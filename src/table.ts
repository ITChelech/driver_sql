import { compileDelete, compileInsert, compileInsertMany, compileUpdate } from "./compiler.js";
import { normalizeDateTimeColumns } from "./date-time.js";
import { getTableDriver } from "./driver.js";
import { Query, type QuerySelectItem } from "./query.js";
import type { RecordShape, Relations, SqlDriver, TableStatic, UpdateData } from "./types.js";
import type { WhereInput } from "./where.js";

export abstract class Table<TRecord extends RecordShape> {
  static tableName: string;
  static columns: Record<string, unknown>;
  static relations?: Relations<any>;
  static driver?: () => SqlDriver;

  declare protected readonly __recordType?: TRecord;

  /**
   * Runs immediately before an UPDATE query is compiled.
   *
   * Override this hook in a model to normalize values or automatically add
   * fields such as `updatedAt`. It may return the transformed data directly
   * or asynchronously.
   */
  static beforeUpdate(data: any): any {
    return data;
  }

  /** Starts a query for this table. */
  static query<TRecord extends RecordShape, TRelations extends Relations<TRecord>>(
    this: TableStatic<TRecord, TRelations>,
  ): Query<TRecord, TRelations> {
    return new Query<TRecord, TRelations>(this);
  }

  /** Starts a query and immediately adds a WHERE filter. */
  static where<TRecord extends RecordShape, TRelations extends Relations<TRecord>>(
    this: TableStatic<TRecord, TRelations>,
    filter: WhereInput<TRecord>,
  ): Query<TRecord, TRelations> {
    return new Query<TRecord, TRelations>(this).where(filter);
  }

  /** Starts a query that returns only the selected fields. */
  static pick<
    TRecord extends RecordShape,
    TRelations extends Relations<TRecord>,
    TFields extends readonly QuerySelectItem<TRecord>[],
  >(
    this: TableStatic<TRecord, TRelations>,
    ...fields: TFields
  ): Query<TRecord, TRelations, Extract<TFields[number], keyof TRecord>, never, true> {
    return new Query<TRecord, TRelations>(this).pick(...fields);
  }

  /** Inserts one row or many rows and returns the created data. */
  static async create<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    data: readonly Partial<TRecord>[],
  ): Promise<Partial<TRecord>[]>;
  static async create<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    data: Partial<TRecord>,
  ): Promise<Partial<TRecord>>;
  static async create<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    data: Partial<TRecord> | readonly Partial<TRecord>[],
  ): Promise<Partial<TRecord> | Partial<TRecord>[]> {
    if (Array.isArray(data)) {
      return createManyRows(this, data as readonly Partial<TRecord>[]);
    }

    const input = data as Partial<TRecord>;
    const prepared = this.beforeInsert ? await this.beforeInsert(input) : input;
    const rows = await getTableDriver(this).query<Partial<TRecord>>(compileInsert(this, prepared));
    const row = normalizeDateTimeColumns(this, rows[0] ?? prepared);
    return this.afterSelect ? this.afterSelect(row) : row;
  }

  /** Inserts many rows and returns the created data. */
  static async createMany<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    data: readonly Partial<TRecord>[],
  ): Promise<Partial<TRecord>[]> {
    return createManyRows(this, data);
  }

  /** Alias for create() when you are inserting a single row. */
  static async insert<TRecord extends RecordShape>(
    this: TableStatic<TRecord> & typeof Table,
    data: Partial<TRecord>,
  ): Promise<Partial<TRecord>> {
    return this.create(data);
  }

  /** Alias for createMany(). */
  static async insertMany<TRecord extends RecordShape>(
    this: TableStatic<TRecord> & typeof Table,
    data: readonly Partial<TRecord>[],
  ): Promise<Partial<TRecord>[]> {
    return this.createMany(data);
  }

  /** Updates rows that match the filter and returns the affected row count. */
  static async update<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    where: WhereInput<TRecord>,
    data: UpdateData<TRecord>,
  ): Promise<number> {
    const prepared = this.beforeUpdate ? await this.beforeUpdate(data) : data;
    return getTableDriver(this).execute(compileUpdate(this, where, prepared));
  }

  /** Deletes rows that match the filter and returns the affected row count. */
  static async delete<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    where: WhereInput<TRecord>,
  ): Promise<number> {
    return getTableDriver(this).execute(compileDelete(this, where));
  }

  /** Alias for delete(). */
  static async destroy<TRecord extends RecordShape>(
    this: TableStatic<TRecord> & typeof Table,
    where: WhereInput<TRecord>,
  ): Promise<number> {
    return this.delete(where);
  }

  /** Checks if at least one row matches the filter. */
  static async exists<TRecord extends RecordShape>(
    this: TableStatic<TRecord>,
    where: WhereInput<TRecord>,
  ): Promise<boolean> {
    return new Query<TRecord>(this).where(where).exists();
  }
}

async function createManyRows<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  data: readonly Partial<TRecord>[],
): Promise<Partial<TRecord>[]> {
  if (data.length === 0) return [];

  const prepared = await Promise.all(data.map(row => (table.beforeInsert ? table.beforeInsert(row) : row)));
  const rows = await getTableDriver(table).query<Partial<TRecord>>(compileInsertMany(table, prepared));
  const result = (rows.length > 0 ? rows : prepared).map(row =>
    normalizeDateTimeColumns(table, row),
  );
  return Promise.all(result.map(row => (table.afterSelect ? table.afterSelect(row) : row)));
}
