import {
  compileAverage,
  compileCount,
  compileDelete,
  compileSelect,
  compileUpdate,
  formatCompiledSql,
} from "./compiler.js";
import { normalizeDateTimeColumns } from "./date-time.js";
import { getTableDriver } from "./driver.js";
import { getLiveOrderFields, LiveQuery, type LiveQueryOptions } from "./live.js";
import { getColumns } from "./metadata.js";
import {
  normalizeRelationPath,
  resolveRelationPath,
} from "./relations.js";
import {
  isSqlExpression,
  parseWhere,
  type QueryExpr,
  type SqlExpression,
  type WhereInput,
} from "./where.js";
import type {
  BelongsToLocalKey,
  OrderBy,
  RecordShape,
  RelationRecord,
  RelationSelection,
  Relations,
  TableStatic,
  UpdateData,
} from "./types.js";

const ROOT_KEY_PREFIX = "__orm_root_key__";
const RELATION_SEPARATOR = "__";
const RELATION_KEY_MARKER = "$key";

export type QueryComputedSelection = {
  readonly [alias: string]: SqlExpression;
};

export type QuerySelectItem<TRecord extends RecordShape> =
  | keyof TRecord
  | QueryComputedSelection;

export type QuerySnapshot<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
> = {
  table: TableStatic<TRecord, TRelations>;
  filters: readonly QueryExpr<TRecord>[];
  selectedFields?: readonly QuerySelectItem<TRecord>[];
  explicitSelection: boolean;
  includedRelations: readonly RelationSelection<TRecord, TRelations>[];
  limitValue?: number;
  offsetValue?: number;
  orderByValues: readonly OrderBy<TRecord>[];
  groupByValues: readonly (keyof TRecord | string)[];
};

type IncludedLocalKeys<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TIncludes extends keyof TRelations,
> = TIncludes extends keyof TRelations
  ? Extract<BelongsToLocalKey<TRelations[TIncludes]>, keyof TRecord>
  : never;

type IncludedRelationValue<
  TRecord extends RecordShape,
  TRelation,
> = TRelation extends {
  readonly type: "hasMany";
  readonly table: () => TableStatic<infer TForeign, any>;
}
  ? Partial<TForeign>[]
  : TRelation extends {
      readonly table: () => TableStatic<infer TForeign, any>;
      readonly pairs: readonly (readonly [infer TLocal, unknown])[];
    }
    ? null extends TRecord[Extract<TLocal, keyof TRecord>]
      ? Partial<TForeign> | null
      : Partial<TForeign>
    : never;

export type QueryResult<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
> = Omit<
  Pick<TRecord, TSelected>,
  TExplicitSelection extends true
    ? never
    : IncludedLocalKeys<TRecord, TRelations, TIncludes>
> & {
  [K in TIncludes]: IncludedRelationValue<TRecord, TRelations[K]>;
};

type ParsedRelationRow = {
  values: RecordShape;
  keys: RecordShape;
};

type ParsedFlatRow = {
  baseRow: RecordShape;
  rootKeys: RecordShape;
  relationRows: Map<string, ParsedRelationRow>;
};

export type MaterializedResult<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
> = QueryResult<
  TRecord,
  TRelations,
  TSelected,
  TIncludes,
  TExplicitSelection
>;

export class Query<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord> = Relations<TRecord>,
  TSelected extends keyof TRecord = keyof TRecord,
  TIncludes extends keyof TRelations = never,
  TExplicitSelection extends boolean = false,
> {
  private readonly filters: QueryExpr<TRecord>[] = [];
  private selectedFields?: QuerySelectItem<TRecord>[];
  private explicitSelection = false;
  private readonly includedRelations: RelationSelection<
    TRecord,
    TRelations
  >[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private readonly orderByValues: OrderBy<TRecord>[] = [];
  private readonly groupByValues: (keyof TRecord | string)[] = [];

  constructor(
    private readonly table: TableStatic<TRecord, TRelations>,
  ) {}

  /** Adds a WHERE filter to the query. You can call it more than once. */
  where(filter: WhereInput<TRecord>): this {
    this.filters.push(parseWhere(filter));
    return this;
  }

  /** Selects only the fields you need. */
  pick<TFields extends readonly QuerySelectItem<TRecord>[]>(
    ...fields: TFields
  ): Query<
    TRecord,
    TRelations,
    Extract<TFields[number], keyof TRecord>,
    TIncludes,
    true
  > {
    this.selectedFields = fields.map(field => normalizeSelectItem(field));
    this.explicitSelection = true;

    return this as unknown as Query<
      TRecord,
      TRelations,
      Extract<TFields[number], keyof TRecord>,
      TIncludes,
      true
    >;
  }

  /** Same as pick(), but accepts the field list as an array. */
  select<TFields extends readonly QuerySelectItem<TRecord>[]>(
    fields: TFields,
  ): Query<
    TRecord,
    TRelations,
    Extract<TFields[number], keyof TRecord>,
    TIncludes,
    true
  > {
    return this.pick(...fields);
  }

  include<
    TRelationName extends keyof TRelations & string,
    TFields extends readonly (
      keyof RelationRecord<TRelations[TRelationName]> & string
    )[],
  >(
    relationPath: TRelationName,
    fields?: TFields,
  ): Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes | TRelationName,
    TExplicitSelection
  >;

  include(
    relationPath: string,
    fields?: readonly string[],
  ): this;

  /** Loads a relation with the result. Nested relations use dotted names. */
  include(
    rawRelationPath: string,
    fields?: readonly string[],
  ): this {
    const relationPath = normalizeRelationPath(rawRelationPath);
    const resolved = resolveRelationPath(
      this.table as TableStatic<RecordShape>,
      relationPath,
    );

    if (fields?.length === 0) {
      throw new Error(
        `include("${relationPath}") requires at least one field`,
      );
    }

    if (fields) {
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(resolved.table.columns, field)) {
          throw new Error(
            `Unknown column "${field}" in relation "${relationPath}"`,
          );
        }
      }
    }

    this.ensureParentIncludes(relationPath);

    const selection: RelationSelection<TRecord, TRelations> = {
      name: resolved.relationName,
      path: relationPath,
      fields: fields ? [...fields] : undefined,
      implicit: false,
    };

    const existingIndex = this.includedRelations.findIndex(
      included => included.path === relationPath,
    );

    if (existingIndex === -1) {
      this.includedRelations.push(selection);
    } else {
      this.includedRelations[existingIndex] = selection;
    }

    return this;
  }

  /** Limits how many rows are returned. */
  limit(value: number): this {
    this.limitValue = normalizeRowCount(value, "limit");
    return this;
  }

  /** Skips rows before returning results. Usually used with orderBy(). */
  offset(value: number): this {
    this.offsetValue = normalizeRowCount(value, "offset");
    return this;
  }

  /** Groups rows by one or more fields. */
  groupBy(...fields: readonly (keyof TRecord | string)[]): this {
    for (const field of fields) {
      this.groupByValues.push(field);
    }
    return this;
  }

  /** Sorts the query by a field. */
  orderBy(
    field: keyof TRecord | string,
    direction: "asc" | "desc" = "asc",
  ): this {
    if (direction !== "asc" && direction !== "desc") {
      throw new Error(
        `Unsupported order direction "${String(direction)}"`,
      );
    }

    this.orderByValues.push({ field, direction });
    return this;
  }

  /** Returns readable SQL for checking or debugging without running it. */
  compile(): string {
    return formatCompiledSql(compileSelect(this));
  }

  /** Runs the query and returns all matching rows. */
  async all(): Promise<
    MaterializedResult<
      TRecord,
      TRelations,
      TSelected,
      TIncludes,
      TExplicitSelection
    >[]
  > {
    const rows = await getTableDriver(this.table).query<RecordShape>(
      compileSelect(this),
    );

    return this.materializeRows(rows);
  }

  /** Runs the query and maps each row into another value. */
  async map<TResult>(
    mapper: (
      row: MaterializedResult<
        TRecord,
        TRelations,
        TSelected,
        TIncludes,
        TExplicitSelection
      >,
      index: number,
    ) => TResult | Promise<TResult>,
  ): Promise<TResult[]> {
    const rows = await this.all();
    return Promise.all(rows.map(mapper));
  }

  /** Runs the query and calls your callback for each row. */
  async forEach(
    callback: (
      row: MaterializedResult<
        TRecord,
        TRelations,
        TSelected,
        TIncludes,
        TExplicitSelection
      >,
      index: number,
    ) => void | Promise<void>,
  ): Promise<void> {
    const rows = await this.all();
    await Promise.all(rows.map(callback));
  }

  /** Returns the first matching row, or null when nothing matches. */
  async first(): Promise<
    MaterializedResult<
      TRecord,
      TRelations,
      TSelected,
      TIncludes,
      TExplicitSelection
    > | null
  > {
    this.limit(1);
    const rows = await this.all();
    return rows[0] ?? null;
  }

  /** Counts rows that match the query. */
  async count(): Promise<number> {
    return (
      (await getTableDriver(this.table).scalar<number>(compileCount(this))) ?? 0
    );
  }

  /** Calculates the average value for a numeric field. */
  async avg(field: keyof TRecord): Promise<number | null> {
    const value = await getTableDriver(this.table).scalar<number>(
      compileAverage(this, field),
    );

    return value === null || value === undefined ? null : Number(value);
  }

  /** Checks if at least one row matches the query. */
  async exists(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  /** Updates rows that match the current filters. Requires at least one where(). */
  async update(data: UpdateData<TRecord>): Promise<number> {
    return getTableDriver(this.table).execute(
      compileUpdate(
        this.table,
        this.requireFilters(),
        await this.applyBeforeUpdate(data),
      ),
    );
  }

  /** Deletes rows that match the current filters. Requires at least one where(). */
  async delete(): Promise<number> {
    return getTableDriver(this.table).execute(
      compileDelete(this.table, this.requireFilters()),
    );
  }

  /** Creates a live watcher for this query. Add listeners, then call start(). */
  live(
    options: LiveQueryOptions<
      MaterializedResult<
        TRecord,
        TRelations,
        TSelected,
        TIncludes,
        TExplicitSelection
      > & RecordShape
    > = {},
  ): LiveQuery<
    MaterializedResult<
      TRecord,
      TRelations,
      TSelected,
      TIncludes,
      TExplicitSelection
    > & RecordShape
  > {
    if (this.includedRelations.length > 0) {
      throw new Error("live() does not support include() yet");
    }
    if (this.groupByValues.length > 0) {
      throw new Error("live() does not support groupBy() yet");
    }

    if (this.orderByValues.length === 0) {
      for (const field of getLiveOrderFields(
        this.table as TableStatic<RecordShape>,
        options.key,
      )) {
        this.orderBy(field as keyof TRecord, "asc");
      }
    }

    return new LiveQuery(this as any, options);
  }

  /** Returns the current query settings for the compiler. */
  toSnapshot(): QuerySnapshot<TRecord, TRelations> {
    return {
      table: this.table,
      filters: [...this.filters],
      selectedFields: this.selectedFields
        ? [...this.selectedFields]
        : undefined,
      explicitSelection: this.explicitSelection,
      includedRelations: [...this.includedRelations]
        .sort((left, right) => pathDepth(left.path) - pathDepth(right.path))
        .map(included => ({
          name: included.name,
          path: included.path,
          fields: included.fields ? [...included.fields] : undefined,
          implicit: included.implicit,
        })),
      limitValue: this.limitValue,
      offsetValue: this.offsetValue,
      orderByValues: [...this.orderByValues],
      groupByValues: [...this.groupByValues],
    };
  }

  private requireFilters(): readonly QueryExpr<TRecord>[] {
    if (this.filters.length === 0) {
      throw new Error("This operation requires at least one where()");
    }

    return this.filters;
  }

  private async applyBeforeUpdate(
    data: UpdateData<TRecord>,
  ): Promise<UpdateData<TRecord>> {
    return this.table.beforeUpdate ? this.table.beforeUpdate(data) : data;
  }

  private async applyAfterSelect(
    row: Partial<TRecord>,
  ): Promise<Partial<TRecord>> {
    return this.table.afterSelect ? this.table.afterSelect(row) : row;
  }

  private async materializeRows(
    rows: readonly RecordShape[],
  ): Promise<
    MaterializedResult<
      TRecord,
      TRelations,
      TSelected,
      TIncludes,
      TExplicitSelection
    >[]
  > {
    if (rows.length === 0) return [];

    const descriptors = this.includedRelations
      .map(selection => {
        const resolved = resolveRelationPath(
          this.table as TableStatic<RecordShape>,
          selection.path,
        );

        const finalSegment = resolved.segments.at(-1);
        if (!finalSegment) {
          throw new Error(`Invalid relation path "${selection.path}"`);
        }

        return {
          selection,
          path: resolved.path,
          parentPath: finalSegment.parentPath,
          relationName: resolved.relationName,
          relation: resolved.relation,
          table: resolved.table,
        };
      })
      .sort((left, right) => pathDepth(left.path) - pathDepth(right.path));

    const grouped = new Map<
      string,
      {
        baseRow: RecordShape;
        rows: ParsedFlatRow[];
      }
    >();

    for (const flatRow of rows) {
      const parsed = this.parseFlatRow(flatRow);
      const rootKey = this.rootRowKey(parsed);
      const group = grouped.get(rootKey) ?? {
        baseRow: parsed.baseRow,
        rows: [],
      };

      group.rows.push(parsed);
      grouped.set(rootKey, group);
    }

    const results: MaterializedResult<
      TRecord,
      TRelations,
      TSelected,
      TIncludes,
      TExplicitSelection
    >[] = [];

    for (const [rootKey, group] of grouped) {
      const normalizedBaseRow = normalizeDateTimeColumns(
        this.table,
        group.baseRow as Partial<TRecord>,
      );
      const root = (await this.applyAfterSelect(
        normalizedBaseRow,
      )) as RecordShape;

      const nodeIndexes = new Map<string, Map<string, RecordShape>>();

      for (const parsed of group.rows) {
        const rowObjects = new Map<string, RecordShape>();
        const rowInstanceKeys = new Map<string, string>();

        for (const descriptor of descriptors) {
          const parentObject = descriptor.parentPath
            ? rowObjects.get(descriptor.parentPath)
            : root;

          if (!parentObject) continue;

          const parentInstanceKey = descriptor.parentPath
            ? rowInstanceKeys.get(descriptor.parentPath)
            : rootKey;

          if (!parentInstanceKey) continue;

          const relationRow = parsed.relationRows.get(descriptor.path) ?? {
            values: {},
            keys: {},
          };

          if (this.relationRowIsNull(relationRow)) {
            this.initializeEmptyRelation(
              parentObject,
              descriptor.relationName,
              descriptor.relation.type,
            );
            continue;
          }

          const rowKey = this.relationRowKey(relationRow);
          const instanceKey = stableKey([parentInstanceKey, rowKey]);
          const pathIndex = nodeIndexes.get(descriptor.path) ?? new Map();
          let relationObject = pathIndex.get(instanceKey);

          if (!relationObject) {
            relationObject = normalizeDateTimeColumns(
              descriptor.table,
              relationRow.values,
            ) as RecordShape;

            pathIndex.set(instanceKey, relationObject);
            nodeIndexes.set(descriptor.path, pathIndex);

            this.attachRelationObject(
              parentObject,
              descriptor.relationName,
              descriptor.relation.type,
              relationObject,
            );
          } else {
            Object.assign(
              relationObject,
              normalizeDateTimeColumns(
                descriptor.table,
                relationRow.values,
              ),
            );
          }

          rowObjects.set(descriptor.path, relationObject);
          rowInstanceKeys.set(descriptor.path, instanceKey);
        }
      }

      for (const descriptor of descriptors) {
        if (descriptor.parentPath) continue;
        this.initializeEmptyRelation(
          root,
          descriptor.relationName,
          descriptor.relation.type,
        );
      }

      results.push(
        root as MaterializedResult<
          TRecord,
          TRelations,
          TSelected,
          TIncludes,
          TExplicitSelection
        >,
      );
    }

    return results;
  }

  private parseFlatRow(flatRow: RecordShape): ParsedFlatRow {
    const baseRow: RecordShape = {};
    const rootKeys: RecordShape = {};
    const relationRows = new Map<string, ParsedRelationRow>();

    for (const [alias, value] of Object.entries(flatRow)) {
      if (alias.startsWith(ROOT_KEY_PREFIX)) {
        rootKeys[alias.slice(ROOT_KEY_PREFIX.length)] = value;
        continue;
      }

      if (!alias.includes(RELATION_SEPARATOR)) {
        baseRow[alias] = value;
        continue;
      }

      const parts = alias.split(RELATION_SEPARATOR);
      const keyMarkerIndex = parts.indexOf(RELATION_KEY_MARKER);

      if (keyMarkerIndex >= 0) {
        const path = parts.slice(0, keyMarkerIndex).join(".");
        const field = parts.slice(keyMarkerIndex + 1).join(RELATION_SEPARATOR);
        const relationRow = relationRows.get(path) ?? {
          values: {},
          keys: {},
        };

        relationRow.keys[field] = value;
        relationRows.set(path, relationRow);
        continue;
      }

      const field = parts.pop();
      if (!field || parts.length === 0) {
        baseRow[alias] = value;
        continue;
      }

      const path = parts.join(".");
      const relationRow = relationRows.get(path) ?? {
        values: {},
        keys: {},
      };

      relationRow.values[field] = value;
      relationRows.set(path, relationRow);
    }

    return {
      baseRow,
      rootKeys,
      relationRows,
    };
  }

  private rootRowKey(parsed: ParsedFlatRow): string {
    if (Object.keys(parsed.rootKeys).length > 0) {
      return stableRecordKey(parsed.rootKeys);
    }

    const primaryKeyFields = getColumns(this.table)
      .filter(column => column.primaryKey)
      .map(column => String(column.propertyName));

    if (
      primaryKeyFields.length > 0 &&
      primaryKeyFields.every(field => parsed.baseRow[field] !== undefined)
    ) {
      return stableKey(
        primaryKeyFields.map(field => [field, parsed.baseRow[field]]),
      );
    }

    return stableRecordKey(parsed.baseRow);
  }

  private relationRowKey(row: ParsedRelationRow): string {
    if (Object.keys(row.keys).length > 0) {
      return stableRecordKey(row.keys);
    }

    return stableRecordKey(row.values);
  }

  private relationRowIsNull(row: ParsedRelationRow): boolean {
    const values = [
      ...Object.values(row.keys),
      ...Object.values(row.values),
    ];

    return (
      values.length === 0 ||
      values.every(value => value === null || value === undefined)
    );
  }

  private initializeEmptyRelation(
    parent: RecordShape,
    relationName: string,
    relationType: "belongsTo" | "hasMany",
  ): void {
    if (relationType === "hasMany") {
      if (!Array.isArray(parent[relationName])) {
        parent[relationName] = [];
      }
      return;
    }

    if (!(relationName in parent)) {
      parent[relationName] = null;
    }
  }

  private attachRelationObject(
    parent: RecordShape,
    relationName: string,
    relationType: "belongsTo" | "hasMany",
    relationObject: RecordShape,
  ): void {
    if (relationType === "hasMany") {
      const list = Array.isArray(parent[relationName])
        ? (parent[relationName] as RecordShape[])
        : [];

      list.push(relationObject);
      parent[relationName] = list;
      return;
    }

    if (
      parent[relationName] === null ||
      parent[relationName] === undefined
    ) {
      parent[relationName] = relationObject;
    }
  }

  private ensureParentIncludes(path: string): void {
    const parts = path.split(".");

    for (let index = 1; index < parts.length; index++) {
      const parentPath = parts.slice(0, index).join(".");

      if (
        this.includedRelations.some(
          included => included.path === parentPath,
        )
      ) {
        continue;
      }

      const resolved = resolveRelationPath(
        this.table as TableStatic<RecordShape>,
        parentPath,
      );

      this.includedRelations.push({
        name: resolved.relationName,
        path: parentPath,
        fields: [],
        implicit: true,
      });
    }
  }
}

function normalizeRowCount(
  value: number,
  label: "limit" | "offset",
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}() requires a non-negative finite number`);
  }

  return Math.trunc(value);
}

function pathDepth(path: string): number {
  return path.split(".").length;
}

function stableRecordKey(record: RecordShape): string {
  return stableKey(
    Object.keys(record)
      .sort()
      .map(field => [field, record[field]]),
  );
}

function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") {
      return { $type: "bigint", value: item.toString() };
    }

    if (item instanceof Date) {
      return { $type: "date", value: item.toISOString() };
    }

    if (item === undefined) {
      return { $type: "undefined" };
    }

    if (typeof item === "number" && Number.isNaN(item)) {
      return { $type: "nan" };
    }

    return item;
  });
}

function normalizeSelectItem<TRecord extends RecordShape>(
  item: QuerySelectItem<TRecord>,
): QuerySelectItem<TRecord> {
  if (isSelectAlias(item)) {
    const entries = Object.entries(item);
    if (entries.length !== 1) {
      throw new Error("Computed select items require exactly one alias");
    }

    const [alias, expression] = entries[0] ?? [];
    if (!alias || !isValidSelectAlias(alias)) {
      throw new Error(`Invalid computed select alias "${String(alias)}"`);
    }
    if (!isSqlExpression(expression)) {
      throw new Error(`Computed select alias "${alias}" must use a SQL expression`);
    }

    return { [alias]: expression };
  }

  return item;
}

export function isSelectAlias<TRecord extends RecordShape>(
  item: QuerySelectItem<TRecord>,
): item is QueryComputedSelection {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

export function selectedColumnFields<TRecord extends RecordShape>(
  fields: readonly QuerySelectItem<TRecord>[] | undefined,
): (keyof TRecord | string)[] | undefined {
  if (!fields) return undefined;
  return fields.filter(field => !isSelectAlias(field)) as (keyof TRecord | string)[];
}

function isValidSelectAlias(alias: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias);
}
