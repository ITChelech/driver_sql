import type { SqlDefaultExpression } from "./date-time.js";
import type { ColumnDef, ColumnType } from "./types.js";

class ColumnBuilder<TValue> {
  private readonly def: ColumnDef<TValue>;

  constructor(kind: ColumnType) {
    this.def = { kind };
  }

  /** Uses a different column name in the database than the property name in TypeScript. */
  name(dbName: string): this {
    return this.with({ dbName });
  }

  /** Marks this column as part of the primary key. */
  primaryKey(): this {
    return this.with({ primaryKey: true });
  }

  /** Lets SQL Server generate the numeric value automatically. */
  identity(): this {
    return this.with({ identity: true });
  }

  /** Adds a unique constraint for this column when schema SQL is generated. */
  unique(): this {
    return this.with({ unique: true });
  }

  /** Sets the length for string columns. Use "max" for NVARCHAR(MAX). */
  length(value: number | "max"): this {
    return this.with({ length: value });
  }

  /** Sets precision and scale for decimal columns. */
  precision(value: number, scale = 0): this {
    return this.with({ precision: value, scale });
  }

  /** Requires a value for this column. */
  notNull(): this {
    return this.with({ nullable: false });
  }

  /** Allows this column to store null. */
  nullable(): this {
    return this.with({ nullable: true });
  }

  /** Sets the default value used when schema SQL is generated. */
  default(value: TValue | (() => TValue) | SqlDefaultExpression): this {
    return this.with({ hasDefault: true, defaultValue: value });
  }

  /** Finishes the column definition. Usually called for you by the table model. */
  build(propertyName?: string): ColumnDef<TValue> {
    return { ...this.def, propertyName };
  }

  private with(patch: Partial<ColumnDef<TValue>>): this {
    Object.assign(this.def, patch);
    return this;
  }
}

/** Creates an INT column. */
export const int = () => new ColumnBuilder<number>("int");
/** Creates an NVARCHAR column. */
export const string = (length: number | "max" = 255) => new ColumnBuilder<string>("string").length(length);
/** Creates a BIT column for true/false values. */
export const boolean = () => new ColumnBuilder<boolean>("boolean");
/** Creates a DATETIME2 column and returns values as JavaScript Date objects. */
export const datetime = () => new ColumnBuilder<Date>("datetime");
/** Creates a DECIMAL column. Use precision() to change size and scale. */
export const decimal = () => new ColumnBuilder<number>("decimal");
/** Stores JSON data in an NVARCHAR(MAX) column. */
export const json = <TValue = unknown>() => new ColumnBuilder<TValue>("json");

export type { ColumnBuilder };
