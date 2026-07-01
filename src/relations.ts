import type {
  BelongsToRelation,
  HasManyRelation,
  JoinType,
  RecordShape,
  RelationDef,
  RelationPair,
  SqlJoinValue,
  TableStatic,
} from "./types.js";

type JoinOptions<
  TRecord extends RecordShape,
  TForeign extends RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
> =
  | {
      readonly local: TLocal;
      readonly foreign: TForeignKey;
      readonly on?: never;
    }
  | {
      readonly on: readonly RelationPair<TRecord, TForeign>[];
      readonly local?: never;
      readonly foreign?: never;
    };

function normalizePairs<
  TRecord extends RecordShape,
  TForeign extends RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
>(
  options: JoinOptions<TRecord, TForeign, TLocal, TForeignKey>,
): readonly RelationPair<TRecord, TForeign>[] {
  if ("on" in options && options.on) {
    if (options.on.length === 0) {
      throw new Error("A relation requires at least one join condition");
    }

    return options.on;
  }

  return [[options.local, options.foreign]];
}

/** Defines a relation where the current table points to one row in another table. */
export function belongsTo<
  TRecord extends RecordShape,
  TForeign extends RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
>(
  table: () => TableStatic<TForeign, any>,
  options: JoinOptions<TRecord, TForeign, TLocal, TForeignKey> & {
    readonly join?: JoinType;
    readonly onDelete?: BelongsToRelation<
      TRecord,
      TForeign,
      TLocal,
      TForeignKey
    >["onDelete"];
    readonly onUpdate?: BelongsToRelation<
      TRecord,
      TForeign,
      TLocal,
      TForeignKey
    >["onUpdate"];
  },
): BelongsToRelation<TRecord, TForeign, TLocal, TForeignKey> {
  return {
    type: "belongsTo",
    table,
    pairs: normalizePairs<TRecord, TForeign, TLocal, TForeignKey>(options),
    join: options.join ?? "LEFT",
    onDelete: options.onDelete,
    onUpdate: options.onUpdate,
  };
}

/** Defines a relation where the current table can have many matching rows. */
export function hasMany<
  TRecord extends RecordShape,
  TForeign extends RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
>(
  table: () => TableStatic<TForeign, any>,
  options: JoinOptions<TRecord, TForeign, TLocal, TForeignKey>,
): HasManyRelation<TRecord, TForeign, TLocal, TForeignKey> {
  return {
    type: "hasMany",
    table,
    pairs: normalizePairs<TRecord, TForeign, TLocal, TForeignKey>(options),
  };
}

/** Creates a parameterized literal operand for a relation ON expression. */
export function sqlValue<TValue>(value: TValue): SqlJoinValue<TValue> {
  return {
    type: "sql-value",
    value,
  };
}

export function isSqlJoinValue(value: unknown): value is SqlJoinValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "sql-value" &&
    "value" in value
  );
}

export type ResolvedRelationSegment = {
  readonly name: string;
  readonly path: string;
  readonly parentPath: string | null;
  readonly parentTable: TableStatic<RecordShape>;
  readonly relation: RelationDef<RecordShape>;
  readonly table: TableStatic<RecordShape>;
};

export type ResolvedRelationPath = {
  readonly path: string;
  readonly relationName: string;
  readonly relation: RelationDef<RecordShape>;
  readonly table: TableStatic<RecordShape>;
  readonly segments: readonly ResolvedRelationSegment[];
};

/** Resolves a dotted relation path from the root table. */
export function resolveRelationPath(
  rootTable: TableStatic<RecordShape>,
  rawPath: string,
): ResolvedRelationPath {
  const path = normalizeRelationPath(rawPath);
  const parts = path.split(".");
  const segments: ResolvedRelationSegment[] = [];

  let currentTable = rootTable;
  let parentPath: string | null = null;

  for (const name of parts) {
    const relation = currentTable.relations?.[name] as
      | RelationDef<RecordShape>
      | undefined;

    if (!relation) {
      throw new Error(
        `Unknown relation "${name}" while resolving "${path}" from table "${currentTable.tableName}"`,
      );
    }

    const segmentPath: string = parentPath ? `${parentPath}.${name}` : name;
    const joinedTable = relation.table() as TableStatic<RecordShape>;

    segments.push({
      name,
      path: segmentPath,
      parentPath,
      parentTable: currentTable,
      relation,
      table: joinedTable,
    });

    currentTable = joinedTable;
    parentPath = segmentPath;
  }

  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    throw new Error(`Invalid relation path "${rawPath}"`);
  }

  return {
    path,
    relationName: finalSegment.name,
    relation: finalSegment.relation,
    table: finalSegment.table,
    segments,
  };
}

/** Cleans up a dotted relation path and rejects empty path parts. */
export function normalizeRelationPath(rawPath: string): string {
  const parts = rawPath.split(".").map(part => part.trim());

  if (parts.length === 0 || parts.some(part => part.length === 0)) {
    throw new Error(`Invalid relation path "${rawPath}"`);
  }

  return parts.join(".");
}
