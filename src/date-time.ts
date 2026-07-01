import { getColumns } from "./metadata.js";
import type { RecordShape, TableStatic } from "./types.js";

export type SqlDefaultExpression = {
  readonly kind: "sql-default-expression";
  readonly sql: string;
};

/** Uses SQL Server's current UTC time as the default value. */
export function defaultDateTime(): SqlDefaultExpression {
  return {
    kind: "sql-default-expression",
    sql: "SYSUTCDATETIME()",
  };
}

/** Checks if a value was created by defaultDateTime() or a similar SQL default. */
export function isSqlDefaultExpression(value: unknown): value is SqlDefaultExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "sql-default-expression" &&
    "sql" in value &&
    typeof value.sql === "string"
  );
}

/** Converts datetime fields in a row into JavaScript Date objects. */
export function normalizeDateTimeColumns<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  row: Partial<TRecord>,
): Partial<TRecord> {
  const normalized = { ...row };

  for (const column of getColumns(table)) {
    if (column.kind !== "datetime") continue;

    const field = column.propertyName;
    const value = normalized[field];

    if (
      value === null ||
      value === undefined ||
      value instanceof Date ||
      isSqlDefaultExpression(value)
    ) {
      continue;
    }

    normalized[field] = parseUtcDate(value) as TRecord[typeof field];
  }

  return normalized;
}

/** Parses a value as a UTC Date. Strings without timezone are treated as UTC. */
export function parseUtcDate(value: unknown): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    const date = new Date(hasTimeZone ? trimmed : `${trimmed.replace(" ", "T")}Z`);

    if (!Number.isNaN(date.getTime())) return date;
  }

  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  throw new TypeError(`Invalid UTC datetime value: ${String(value)}`);
}
