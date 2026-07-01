import {
  compileLiveSignature,
  type LiveSignatureColumnOptions,
} from "./compiler.js";
import { getTableDriver } from "./driver.js";
import { getColumns } from "./metadata.js";
import type { Query } from "./query.js";
import type { CompiledSql, RecordShape, Relations, TableStatic } from "./types.js";

export type LiveKey<TRow extends RecordShape> =
  | keyof TRow
  | string
  | readonly (keyof TRow | string)[]
  | ((row: TRow) => string | number | bigint);

export type LiveSignature = {
  readonly hash: string;
  readonly rowCount: number;
  readonly checkedAt: Date;
};

export type LiveSignatureStrategy<TRow extends RecordShape> =
  | "hash"
  | LiveSignatureColumnOptions<TRow>
  | ((query: LiveQuerySource<TRow>) => CompiledSql | Promise<CompiledSql>);

export type LiveQueryOptions<TRow extends RecordShape> = {
  /** How often the signature query should run. */
  intervalMs?: number;
  /** Field, fields, or function used to match old rows with new rows. */
  key?: LiveKey<TRow>;
  /** How live() checks if the result changed. Use a column for large tables. */
  signature?: LiveSignatureStrategy<TRow>;
  /** Runs the first check as soon as start() is called. */
  pollImmediately?: boolean;
  /** Emits the first loaded rows as added rows instead of only saving the baseline. */
  emitInitial?: boolean;
  /** Custom row comparison. Return true when both rows should be treated as equal. */
  equals?: (previous: TRow, current: TRow) => boolean;
};

export type LiveReadyEvent<TRow extends RecordShape> = {
  readonly type: "ready";
  readonly current: LiveSignature;
  readonly rows: readonly TRow[];
};

export type LiveTickEvent = {
  readonly type: "tick";
  readonly current: LiveSignature;
  readonly changed: boolean;
};

export type LiveAddEvent<TRow extends RecordShape> = {
  readonly type: "add";
  readonly key: string;
  readonly row: TRow;
  readonly current: LiveSignature;
};

export type LiveUpdateEvent<TRow extends RecordShape> = {
  readonly type: "update";
  readonly key: string;
  readonly previousRow: TRow;
  readonly row: TRow;
  readonly current: LiveSignature;
};

export type LiveRemoveEvent<TRow extends RecordShape> = {
  readonly type: "remove";
  readonly key: string;
  readonly row: TRow;
  readonly current: LiveSignature;
};

export type LiveChangeEvent<TRow extends RecordShape> = {
  readonly type: "change";
  readonly previous: LiveSignature | null;
  readonly current: LiveSignature;
  readonly added: readonly TRow[];
  readonly updated: readonly {
    readonly key: string;
    readonly previousRow: TRow;
    readonly row: TRow;
  }[];
  readonly removed: readonly TRow[];
  readonly rows: readonly TRow[];
};

export type LiveErrorEvent = {
  readonly type: "error";
  readonly error: unknown;
};

export type LiveEventMap<TRow extends RecordShape> = {
  ready: LiveReadyEvent<TRow>;
  tick: LiveTickEvent;
  add: LiveAddEvent<TRow>;
  update: LiveUpdateEvent<TRow>;
  remove: LiveRemoveEvent<TRow>;
  change: LiveChangeEvent<TRow>;
  error: LiveErrorEvent;
};

type LiveListener<TEvent> = (event: TEvent) => void;
type AnyLiveListener = (event: any) => void;

export type LiveQuerySource<TRow extends RecordShape> = Pick<
  Query<
    RecordShape,
    Relations<RecordShape>,
    keyof RecordShape,
    keyof Relations<RecordShape>,
    boolean
  >,
  "toSnapshot"
> & {
  all(): Promise<TRow[]>;
};

type LiveSignatureRow = {
  row_count?: number | bigint | string;
  hash_value?: string;
};

type IndexedRow<TRow extends RecordShape> = {
  row: TRow;
  fingerprint: string;
};

/** Watches a query by polling a small SQL signature and fetching rows only when it changes. */
export class LiveQuery<TRow extends RecordShape> {
  private readonly listeners = new Map<keyof LiveEventMap<TRow>, Set<AnyLiveListener>>();
  private readonly intervalMs: number;
  private readonly pollImmediately: boolean;
  private readonly emitInitial: boolean;
  private readonly equals: (previous: TRow, current: TRow) => boolean;
  private readonly keyForRow: (row: TRow) => string;
  private readonly signature: LiveSignatureStrategy<TRow>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private previousSignature: LiveSignature | null = null;
  private previousRows: readonly TRow[] = [];
  private previousIndex = new Map<string, IndexedRow<TRow>>();

  constructor(
    private readonly query: LiveQuerySource<TRow>,
    options: LiveQueryOptions<TRow> = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.pollImmediately = options.pollImmediately ?? true;
    this.emitInitial = options.emitInitial ?? false;
    this.equals = options.equals ?? defaultRowsEqual;
    this.keyForRow = createKeyGetter(query.toSnapshot().table, options.key);
    this.signature = options.signature ?? "hash";

    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("live() intervalMs must be a positive number");
    }
  }

  /** Registers a listener and returns a function that removes it. */
  on<K extends keyof LiveEventMap<TRow>>(
    event: K,
    listener: LiveListener<LiveEventMap<TRow>[K]>,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<AnyLiveListener>();
    listeners.add(listener as AnyLiveListener);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  /** Removes a listener registered with on(). */
  off<K extends keyof LiveEventMap<TRow>>(
    event: K,
    listener: LiveListener<LiveEventMap<TRow>[K]>,
  ): void {
    this.listeners.get(event)?.delete(listener as AnyLiveListener);
  }

  /** Starts polling. Call this after adding your listeners. */
  start(): this {
    if (this.running) return this;

    this.running = true;
    this.schedule(this.pollImmediately ? 0 : this.intervalMs);
    return this;
  }

  /** Stops polling. You can call start() again later. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs one check now. Returns a change event only when rows changed. */
  async check(): Promise<LiveChangeEvent<TRow> | null> {
    const current = await this.readSignature();
    const previous = this.previousSignature;
    const changed = !previous || previous.hash !== current.hash || previous.rowCount !== current.rowCount;

    this.emit("tick", { type: "tick", current, changed });
    if (!changed) return null;

    const rows = await this.query.all();
    const currentIndex = this.indexRows(rows);

    if (!previous) {
      this.previousSignature = current;
      this.previousRows = rows;
      this.previousIndex = currentIndex;
      this.emit("ready", { type: "ready", current, rows });

      if (!this.emitInitial) return null;
    }

    const change = this.diff(previous, current, rows, currentIndex);
    this.previousSignature = current;
    this.previousRows = rows;
    this.previousIndex = currentIndex;
    this.emitChangeEvents(change);
    return change;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runLoop();
    }, delayMs);
  }

  private async runLoop(): Promise<void> {
    if (!this.running) return;

    try {
      await this.check();
    } catch (error) {
      this.emit("error", { type: "error", error });
    } finally {
      if (this.running) this.schedule(this.intervalMs);
    }
  }

  private async readSignature(): Promise<LiveSignature> {
    const snapshot = this.query.toSnapshot();
    const driver = getTableDriver(snapshot.table);
    const compiled = await this.compileSignature();
    const rows = await driver.query<LiveSignatureRow>(compiled);
    const row = rows[0] ?? {};

    return {
      hash: String(row.hash_value ?? ""),
      rowCount: Number(row.row_count ?? 0),
      checkedAt: new Date(),
    };
  }

  private async compileSignature(): Promise<CompiledSql> {
    if (typeof this.signature === "function") {
      return this.signature(this.query);
    }

    return compileLiveSignature(
      this.query as unknown as Query<any, any, any, any, any>,
      this.signature as any,
    );
  }

  private indexRows(rows: readonly TRow[]): Map<string, IndexedRow<TRow>> {
    const index = new Map<string, IndexedRow<TRow>>();

    for (const row of rows) {
      const key = this.keyForRow(row);
      if (index.has(key)) {
        throw new Error(`live() key "${key}" matched more than one row`);
      }

      index.set(key, {
        row,
        fingerprint: stableStringify(row),
      });
    }

    return index;
  }

  private diff(
    previous: LiveSignature | null,
    current: LiveSignature,
    rows: readonly TRow[],
    currentIndex: Map<string, IndexedRow<TRow>>,
  ): LiveChangeEvent<TRow> {
    const added: TRow[] = [];
    const updated: {
      readonly key: string;
      readonly previousRow: TRow;
      readonly row: TRow;
    }[] = [];
    const removed: TRow[] = [];

    for (const [key, currentRow] of currentIndex) {
      const previousRow = this.previousIndex.get(key);
      if (!previousRow) {
        added.push(currentRow.row);
        continue;
      }

      if (
        previousRow.fingerprint !== currentRow.fingerprint &&
        !this.equals(previousRow.row, currentRow.row)
      ) {
        updated.push({
          key,
          previousRow: previousRow.row,
          row: currentRow.row,
        });
      }
    }

    for (const [key, previousRow] of this.previousIndex) {
      if (!currentIndex.has(key)) removed.push(previousRow.row);
    }

    return {
      type: "change",
      previous,
      current,
      added,
      updated,
      removed,
      rows,
    };
  }

  private emitChangeEvents(change: LiveChangeEvent<TRow>): void {
    for (const row of change.added) {
      this.emit("add", {
        type: "add",
        key: this.keyForRow(row),
        row,
        current: change.current,
      });
    }

    for (const update of change.updated) {
      this.emit("update", {
        type: "update",
        key: update.key,
        previousRow: update.previousRow,
        row: update.row,
        current: change.current,
      });
    }

    for (const row of change.removed) {
      this.emit("remove", {
        type: "remove",
        key: this.keyForRow(row),
        row,
        current: change.current,
      });
    }

    this.emit("change", change);
  }

  private emit<K extends keyof LiveEventMap<TRow>>(
    event: K,
    payload: LiveEventMap<TRow>[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

export function getLiveOrderFields<TRow extends RecordShape>(
  table: TableStatic<RecordShape>,
  key: LiveKey<TRow> | undefined,
): string[] {
  if (typeof key === "function") return [];
  if (Array.isArray(key)) return key.map(field => String(field));
  if (key) return [String(key)];

  return getColumns(table)
    .filter(column => column.primaryKey)
    .map(column => String(column.propertyName));
}

function createKeyGetter<TRow extends RecordShape>(
  table: TableStatic<RecordShape>,
  key: LiveKey<TRow> | undefined,
): (row: TRow) => string {
  if (typeof key === "function") {
    return row => String(key(row));
  }

  const fields = getLiveOrderFields(table, key);
  if (fields.length === 0) {
    throw new Error("live() requires a key option or at least one primary key column");
  }

  return row => {
    const values = fields.map(field => {
      if (!Object.prototype.hasOwnProperty.call(row, field)) {
        throw new Error(`live() key field "${field}" is not present in the selected row`);
      }

      return row[field];
    });

    return values.length === 1
      ? String(values[0])
      : values.map(stableStringify).join("\u001f");
  };
}

function defaultRowsEqual<TRow extends RecordShape>(
  previous: TRow,
  current: TRow,
): boolean {
  return stableStringify(previous) === stableStringify(current);
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}
