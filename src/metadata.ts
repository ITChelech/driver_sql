import type { ColumnDef, ColumnInput, RecordShape, TableStatic } from "./types.js";

/** Returns the normalized column definitions for a table model. */
export function getColumns<TRecord extends RecordShape>(table: TableStatic<TRecord>): RequiredColumn<TRecord>[] {
  return Object.entries(table.columns).map(([propertyName, column]) => normalizeColumn(propertyName, column));
}

/** Returns one normalized column definition, or throws when it does not exist. */
export function getColumn<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  field: keyof TRecord,
): RequiredColumn<TRecord> {
  const column = table.columns[field];

  if (!column) {
    throw new Error(`Unknown column "${String(field)}" in table "${table.tableName}"`);
  }

  return normalizeColumn(String(field), column);
}

/** Quotes a SQL Server identifier with square brackets. */
export function quoteIdent(identifier: string): string {
  return `[${identifier.replaceAll("]", "]]")}]`;
}

export type RequiredColumn<TRecord extends RecordShape> = Omit<ColumnDef, "propertyName" | "dbName"> & {
  readonly propertyName: Extract<keyof TRecord, string>;
  readonly dbName: string;
};

function normalizeColumn<TRecord extends RecordShape>(
  propertyName: string,
  column: ColumnInput | undefined,
): RequiredColumn<TRecord> {
  if (!column) {
    throw new Error(`Column "${propertyName}" has no metadata`);
  }

  const def = "build" in column ? column.build(propertyName) : column;

  return {
    ...def,
    propertyName: propertyName as Extract<keyof TRecord, string>,
    dbName: def.dbName ?? propertyName,
  };
}
