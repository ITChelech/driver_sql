import type { SqlDefaultExpression } from "./date-time.js";

export type RecordShape = Record<string, unknown>;

export type ColumnType =
  | "int"
  | "string"
  | "boolean"
  | "datetime"
  | "decimal"
  | "json";

export type ColumnDef<TValue = unknown> = {
  readonly kind: ColumnType;
  readonly length?: number | "max";
  readonly precision?: number;
  readonly scale?: number;
  readonly propertyName?: string;
  readonly dbName?: string;
  readonly primaryKey?: boolean;
  readonly identity?: boolean;
  readonly unique?: boolean;
  readonly nullable?: boolean;
  readonly hasDefault?: boolean;
  readonly defaultValue?: TValue | (() => TValue) | SqlDefaultExpression;
};

export type ColumnInput<TValue = unknown> =
  | ColumnDef<TValue>
  | { build(propertyName?: string): ColumnDef<TValue> };

export type Columns<TRecord extends RecordShape> = {
  [K in keyof TRecord]?: ColumnInput;
};

export type UpdateData<TRecord extends RecordShape> = {
  [K in keyof TRecord]?: TRecord[K] | SqlDefaultExpression;
};

export type TableStatic<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord> = Relations<TRecord>,
> = {
  readonly tableName: string;
  readonly columns: Columns<TRecord>;
  readonly relations?: TRelations;
  readonly driver?: () => SqlDriver;
  beforeInsert?(data: Partial<TRecord>): Partial<TRecord> | Promise<Partial<TRecord>>;
  beforeUpdate?(data: UpdateData<TRecord>): UpdateData<TRecord> | Promise<UpdateData<TRecord>>;
  afterSelect?(row: Partial<TRecord>): Partial<TRecord> | Promise<Partial<TRecord>>;
};

export type JoinType = "INNER" | "LEFT";

/** A literal value used inside a relation ON expression. It is always parameterized. */
export type SqlJoinValue<TValue = unknown> = {
  readonly type: "sql-value";
  readonly value: TValue;
};

export type RelationLocalOperand<TRecord extends RecordShape> =
  | keyof TRecord
  | SqlJoinValue;

export type RelationForeignOperand<TForeign extends RecordShape> =
  | keyof TForeign
  | SqlJoinValue;

export type RelationPair<
  TRecord extends RecordShape,
  TForeign extends RecordShape,
> = readonly [
  local: RelationLocalOperand<TRecord>,
  foreign: RelationForeignOperand<TForeign>,
];

export type BelongsToRelation<
  TRecord extends RecordShape = RecordShape,
  TForeign extends RecordShape = RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
> = {
  readonly type: "belongsTo";
  readonly table: () => TableStatic<TForeign, any>;
  readonly pairs: readonly RelationPair<TRecord, TForeign>[];
  readonly join: JoinType;
  readonly onDelete?: "NO ACTION" | "CASCADE" | "SET NULL";
  readonly onUpdate?: "NO ACTION" | "CASCADE";
};

export type HasManyRelation<
  TRecord extends RecordShape = RecordShape,
  TForeign extends RecordShape = RecordShape,
  TLocal extends keyof TRecord = keyof TRecord,
  TForeignKey extends keyof TForeign = keyof TForeign,
> = {
  readonly type: "hasMany";
  readonly table: () => TableStatic<TForeign, any>;
  readonly pairs: readonly RelationPair<TRecord, TForeign>[];
};

export type RelationDef<TRecord extends RecordShape = RecordShape> =
  | BelongsToRelation<TRecord, any>
  | HasManyRelation<TRecord, any>;

export type Relations<TRecord extends RecordShape = RecordShape> =
  Record<string, RelationDef<TRecord>>;

export type RelationRecord<TRelation> =
  TRelation extends {
    readonly table: () => TableStatic<infer TForeign, any>;
  }
    ? TForeign
    : never;

type ExtractRelationColumn<TValue> =
  TValue extends PropertyKey ? TValue : never;

export type RelationLocalKey<TRelation> =
  TRelation extends {
    readonly pairs: readonly (readonly [infer TLocal, unknown])[];
  }
    ? ExtractRelationColumn<TLocal>
    : never;

export type BelongsToLocalKey<TRelation> =
  TRelation extends {
    readonly type: "belongsTo";
    readonly pairs: readonly (readonly [infer TLocal, unknown])[];
  }
    ? ExtractRelationColumn<TLocal>
    : never;

/**
 * Runtime include descriptor. Nested relations use dotted paths, for example
 * `MAEDDO.GDV`. An implicit parent is selected only to build the nested graph.
 */
export type RelationSelection<
  TRecord extends RecordShape = RecordShape,
  TRelations extends Relations<TRecord> = Relations<TRecord>,
> = {
  readonly name: string;
  readonly path: string;
  readonly fields?: readonly string[];
  readonly implicit?: boolean;
};

export type OrderDirection = "asc" | "desc";

export type OrderBy<TRecord extends RecordShape> = {
  field: keyof TRecord | string;
  direction: OrderDirection;
};

export type CompiledSql = {
  sql: string;
  params: unknown[];
};

export type SqlDriver = {
  query<TRecord extends RecordShape>(compiled: CompiledSql): Promise<TRecord[]>;
  scalar<TValue = unknown>(compiled: CompiledSql): Promise<TValue | null>;
  execute(compiled: CompiledSql): Promise<number>;
  close?(): Promise<void>;
};
