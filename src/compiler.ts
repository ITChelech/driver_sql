import type { Query, QuerySelectItem } from "./query.js";
import { isSqlDefaultExpression } from "./date-time.js";
import { getColumn, getColumns, quoteIdent } from "./metadata.js";
import {
  isSqlJoinValue,
  resolveRelationPath,
  type ResolvedRelationSegment,
} from "./relations.js";
import type {
  CompiledSql,
  RecordShape,
  RelationDef,
  Relations,
  TableStatic,
  UpdateData,
} from "./types.js";
import { isOperator, isOperatorName } from "./operators.js";
import { parseWhere } from "./where.js";
import type { QueryExpr, SqlExpression, SqlPredicate, WhereInput } from "./where.js";

const ROOT_KEY_PREFIX = "__orm_root_key__";
const RELATION_SEPARATOR = "__";
const RELATION_KEY_MARKER = "$key";

type CompileState = {
  params: unknown[];
  joins: Map<string, JoinRef>;
  aliases: boolean;
};

export type LiveSignatureColumnOptions<TRecord extends RecordShape> = {
  /** Column that changes whenever a row is inserted or updated. */
  field: keyof TRecord | string;
  /** Include COUNT_BIG(*) to detect deletes. Disable it only when deletes do not matter. */
  includeRowCount?: boolean;
};

export type LiveSignatureOptions<TRecord extends RecordShape> =
  | "hash"
  | LiveSignatureColumnOptions<TRecord>;

type JoinRef = {
  path: string;
  parentPath: string | null;
  parentAlias: string;
  alias: string;
  relationName: string;
  relation: RelationDef<RecordShape>;
  table: TableStatic<RecordShape>;
  conditions: readonly JoinCondition[];
  joinType: "INNER" | "LEFT";
};

type JoinOperand =
  | {
      type: "column";
      alias: string;
      column: string;
    }
  | {
      type: "parameter";
      parameter: string;
    };

type JoinCondition = {
  local: JoinOperand;
  foreign: JoinOperand;
};

/** Turns a Query into parameterized SELECT SQL. */
export function compileSelect<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
>(
  query: Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes,
    TExplicitSelection
  >,
): CompiledSql {
  const snapshot = query.toSnapshot();
  if (snapshot.groupByValues.length > 0 && snapshot.includedRelations.length > 0) {
    throw new Error("groupBy() is not supported with include() yet");
  }
  if (shouldPaginateRootRows(snapshot)) {
    return compileSelectWithRootPagination(snapshot);
  }

  const state: CompileState = {
    params: [],
    joins: new Map(),
    aliases: true,
  };

  const includedRelations = snapshot.includedRelations.map(included => {
    const resolved = resolveRelationPath(
      snapshot.table as TableStatic<RecordShape>,
      included.path,
    );
    const join = ensureJoinPath(
      snapshot.table as TableStatic<RecordShape>,
      resolved.path,
      state,
    );

    return {
      selection: included,
      path: resolved.path,
      relationName: resolved.relationName,
      relation: resolved.relation,
      joinedTable: resolved.table,
      join,
    };
  });

  const hiddenLocalFields = snapshot.explicitSelection
    ? new Set<string>()
    : new Set(
        includedRelations.flatMap(({ path, relation }) => {
          if (path.includes(".") || relation.type !== "belongsTo") {
            return [];
          }

          return relation.pairs.flatMap(([local]) =>
            isSqlJoinValue(local) ? [] : [String(local)],
          );
        }),
      );

  const fields = snapshot.selectedFields?.length
    ? snapshot.selectedFields
    : getColumns(snapshot.table).map(column => column.propertyName);

  const baseSelect = fields
    .filter(field => isComputedSelectItem(field) || !hiddenLocalFields.has(String(field)))
    .map(field => compileSelectItem(snapshot.table, field, state));

  const rootKeySelect = snapshot.groupByValues.length > 0
    ? []
    : getColumns(snapshot.table)
        .filter(column => column.primaryKey)
        .map(column =>
          `${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${ROOT_KEY_PREFIX}${String(column.propertyName)}`)}`,
        );

  const relationSelect = includedRelations.flatMap(
    ({ selection, path, relation, joinedTable, join }) => {
      const visibleColumns = selection.fields
        ? selection.fields.map(field => getColumn(joinedTable, field))
        : getColumns(joinedTable);
      const identityColumns = relationIdentityColumns(
        joinedTable,
        relation,
        visibleColumns,
      );
      const encodedPath = encodeRelationPath(path);

      const visibleSelect = visibleColumns.map(column =>
        `${quoteIdent(join.alias)}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${encodedPath}${RELATION_SEPARATOR}${String(column.propertyName)}`)}`,
      );

      const keySelect = identityColumns.map(column =>
        `${quoteIdent(join.alias)}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${encodedPath}${RELATION_SEPARATOR}${RELATION_KEY_MARKER}${RELATION_SEPARATOR}${String(column.propertyName)}`)}`,
      );

      return [...visibleSelect, ...keySelect];
    },
  );

  const whereSql = compileWhere(snapshot.table, snapshot.filters, state);
  const groupBySql = compileGroupBy(snapshot.table, snapshot.groupByValues, state);
  const orderBySql = compileOrderBy(
    snapshot.table,
    snapshot.orderByValues,
    state,
    snapshot.limitValue !== undefined || snapshot.offsetValue !== undefined,
  );

  const selectSql = [
    ...baseSelect,
    ...rootKeySelect,
    ...relationSelect,
  ].join(", ");

  const sql = [
    `SELECT ${selectSql}`,
    `FROM ${quoteIdent(snapshot.table.tableName)} AS ${quoteIdent("t0")}`,
    compileJoins(state),
    whereSql,
    groupBySql,
    orderBySql,
    compileLimitOffset(snapshot.limitValue, snapshot.offsetValue, state),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    sql,
    params: state.params,
  };
}

function shouldPaginateRootRows<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
>(snapshot: ReturnType<Query<TRecord, TRelations>["toSnapshot"]>): boolean {
  if (snapshot.limitValue === undefined && snapshot.offsetValue === undefined) {
    return false;
  }

  return snapshot.includedRelations.some(included =>
    resolveRelationPath(
      snapshot.table as TableStatic<RecordShape>,
      included.path,
    ).segments.some(segment => segment.relation.type === "hasMany"),
  );
}

function rootPaginationColumns<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
>(snapshot: ReturnType<Query<TRecord, TRelations>["toSnapshot"]>): ReturnType<typeof getColumns> {
  const selected = new Map<string, ReturnType<typeof getColumns>[number]>();
  const addColumn = (field: keyof TRecord | string) => {
    const column = getColumn(snapshot.table, field as keyof TRecord);
    selected.set(column.dbName, column);
  };

  const visibleFields = selectedColumnFields(snapshot.selectedFields)?.length
    ? selectedColumnFields(snapshot.selectedFields)!
    : getColumns(snapshot.table).map(column => column.propertyName);

  for (const field of visibleFields) addColumn(field as keyof TRecord);

  for (const column of getColumns(snapshot.table).filter(column => column.primaryKey)) {
    selected.set(column.dbName, column);
  }

  for (const order of snapshot.orderByValues) {
    if (!String(order.field).includes(".")) addColumn(order.field as keyof TRecord);
  }

  for (const included of snapshot.includedRelations) {
    const resolved = resolveRelationPath(
      snapshot.table as TableStatic<RecordShape>,
      included.path,
    );

    for (const segment of resolved.segments) {
      if (segment.parentPath) continue;

      for (const [local] of segment.relation.pairs) {
        if (isSqlJoinValue(local)) continue;
        addColumn(local as keyof TRecord);
      }
    }
  }

  return [...selected.values()];
}

function compileSelectWithRootPagination<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
>(snapshot: ReturnType<Query<TRecord, TRelations>["toSnapshot"]>): CompiledSql {
  if (snapshot.groupByValues.length > 0) {
    throw new Error("groupBy() is not supported with root pagination yet");
  }
  if (hasComputedSelectItems(snapshot.selectedFields)) {
    throw new Error("Computed select items are not supported with root pagination yet");
  }
  const rootState: CompileState = {
    params: [],
    joins: new Map(),
    aliases: true,
  };
  const rootWhereSql = compileWhere(snapshot.table, snapshot.filters, rootState);
  const rootOrderBySql = compileOrderBy(
    snapshot.table,
    snapshot.orderByValues,
    rootState,
    true,
  );
  const rootSelect = rootPaginationColumns(snapshot)
    .map(column => `${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS ${quoteIdent(column.dbName)}`)
    .join(", ");
  const rootSql = [
    `SELECT DISTINCT ${rootSelect}`,
    `FROM ${quoteIdent(snapshot.table.tableName)} AS ${quoteIdent("t0")}`,
    compileJoins(rootState),
    rootWhereSql,
    rootOrderBySql,
    compileLimitOffset(snapshot.limitValue, snapshot.offsetValue, rootState),
  ]
    .filter(Boolean)
    .join(" ");

  const state: CompileState = {
    params: [...rootState.params],
    joins: new Map(),
    aliases: true,
  };
  const includedRelations = snapshot.includedRelations.map(included => {
    const resolved = resolveRelationPath(
      snapshot.table as TableStatic<RecordShape>,
      included.path,
    );
    const join = ensureJoinPath(
      snapshot.table as TableStatic<RecordShape>,
      resolved.path,
      state,
    );

    return {
      selection: included,
      path: resolved.path,
      relationName: resolved.relationName,
      relation: resolved.relation,
      joinedTable: resolved.table,
      join,
    };
  });

  const hiddenLocalFields = snapshot.explicitSelection
    ? new Set<string>()
    : new Set(
        includedRelations.flatMap(({ path, relation }) => {
          if (path.includes(".") || relation.type !== "belongsTo") {
            return [];
          }

          return relation.pairs.flatMap(([local]) =>
            isSqlJoinValue(local) ? [] : [String(local)],
          );
        }),
      );

  const fields = (
    selectedColumnFields(snapshot.selectedFields)?.length
      ? selectedColumnFields(snapshot.selectedFields)!
      : getColumns(snapshot.table).map(column => column.propertyName)
  ).filter(field => !hiddenLocalFields.has(String(field)));

  const baseSelect = fields.map(field => {
    const column = getColumn(snapshot.table, field);
    return `${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS ${quoteIdent(String(column.propertyName))}`;
  });

  const rootKeySelect = getColumns(snapshot.table)
    .filter(column => column.primaryKey)
    .map(column =>
      `${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${ROOT_KEY_PREFIX}${String(column.propertyName)}`)}`,
    );

  const relationSelect = includedRelations.flatMap(
    ({ selection, path, relation, joinedTable, join }) => {
      const visibleColumns = selection.fields
        ? selection.fields.map(field => getColumn(joinedTable, field))
        : getColumns(joinedTable);
      const identityColumns = relationIdentityColumns(
        joinedTable,
        relation,
        visibleColumns,
      );
      const encodedPath = encodeRelationPath(path);

      const visibleSelect = visibleColumns.map(column =>
        `${quoteIdent(join.alias)}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${encodedPath}${RELATION_SEPARATOR}${String(column.propertyName)}`)}`,
      );

      const keySelect = identityColumns.map(column =>
        `${quoteIdent(join.alias)}.${quoteIdent(column.dbName)} AS ${quoteIdent(`${encodedPath}${RELATION_SEPARATOR}${RELATION_KEY_MARKER}${RELATION_SEPARATOR}${String(column.propertyName)}`)}`,
      );

      return [...visibleSelect, ...keySelect];
    },
  );

  const orderBySql = compileOrderBy(
    snapshot.table,
    snapshot.orderByValues,
    state,
  );
  const selectSql = [
    ...baseSelect,
    ...rootKeySelect,
    ...relationSelect,
  ].join(", ");
  const sql = [
    `SELECT ${selectSql}`,
    `FROM (${rootSql}) AS ${quoteIdent("t0")}`,
    compileJoins(state),
    orderBySql,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    sql,
    params: state.params,
  };
}

/** Formats compiled SQL with DECLARE lines so it is easy to read or paste. */
export function formatCompiledSql(compiled: CompiledSql): string {
  const declarations = compiled.params
    .map((value, index) => `DECLARE ${paramName(index)} ${sqlDebugType(value)} = ${sqlDebugLiteral(value)};`)
    .join("\n");
  const sql = formatSqlForDebug(compiled.sql);

  return [declarations, sql].filter(Boolean).join("\n\n");
}

/** Builds the small polling query used by Query.live(). */
export function compileLiveSignature<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
>(
  query: Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes,
    TExplicitSelection
  >,
  options: LiveSignatureOptions<TRecord> = "hash",
): CompiledSql {
  if (options !== "hash") {
    return compileLiveColumnSignature(query, options);
  }

  const compiled = compileSelect(query);

  return {
    sql: [
      "SELECT",
      "CASE",
      "WHEN [payload].[payload] IS NULL OR [payload].[payload] = N'[]' THEN 0",
      "ELSE CONVERT(BIGINT, LEN([payload].[payload]) - LEN(REPLACE([payload].[payload], N'},{', N'')) + 1)",
      "END AS row_count,",
      "CONVERT(",
      "VARCHAR(64),",
      "HASHBYTES(",
      "'SHA2_256',",
      "CONVERT(VARBINARY(MAX), ISNULL([payload].[payload], N''))",
      "),",
      "2",
      ") AS hash_value",
      "FROM (VALUES (1)) AS [seed]([n])",
      "CROSS APPLY (",
      "SELECT (",
      compiled.sql,
      "FOR JSON PATH",
      ") AS [payload]",
      ") AS [payload]",
    ].join(" "),
    params: compiled.params,
  };
}

function compileLiveColumnSignature<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
>(
  query: Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes,
    TExplicitSelection
  >,
  options: LiveSignatureColumnOptions<TRecord>,
): CompiledSql {
  const snapshot = query.toSnapshot();
  const column = getColumn(snapshot.table, options.field as keyof TRecord);
  const state: CompileState = {
    params: [],
    joins: new Map(),
    aliases: true,
  };
  const whereSql = compileWhere(snapshot.table, snapshot.filters, state);
  const rowCountSql = options.includeRowCount === false
    ? "0"
    : "COUNT_BIG(*)";
  const versionSql = `MAX(${quoteIdent("t0")}.${quoteIdent(column.dbName)})`;
  const signatureText = `CONCAT(${rowCountSql}, N':', CONVERT(NVARCHAR(4000), ${versionSql}, 126))`;

  return {
    sql: [
      "SELECT",
      `${rowCountSql} AS row_count,`,
      "CONVERT(",
      "VARCHAR(64),",
      "HASHBYTES(",
      "'SHA2_256',",
      `CONVERT(VARBINARY(MAX), ${signatureText})`,
      "),",
      "2",
      ") AS hash_value",
      `FROM ${quoteIdent(snapshot.table.tableName)} AS ${quoteIdent("t0")}`,
      compileJoins(state),
      whereSql,
    ].filter(Boolean).join(" "),
    params: state.params,
  };
}

function formatSqlForDebug(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return formatSelectListForDebug(normalized);
}

function formatSqlClausesForDebug(sql: string): string {
  return sql
    .replace(/\bFROM \(SELECT\b/g, "\nFROM (\nSELECT")
    .replace(/\) AS (\[[^\]]+\])\s+(?=(?:LEFT|INNER|RIGHT|FULL) JOIN\b|ORDER BY\b|WHERE\b|OFFSET\b|FETCH NEXT\b|$)/g, "\n) AS $1 ")
    .replace(/\bFROM\b/g, "\nFROM")
    .replace(/\b(LEFT|INNER|RIGHT|FULL) JOIN\b/g, "\n$1 JOIN")
    .replace(/\bWHERE\b/g, "\nWHERE")
    .replace(/\bAND\b/g, "\n  AND")
    .replace(/\bOR\b/g, "\n  OR")
    .replace(/\bORDER BY\b/g, "\nORDER BY")
    .replace(/\bOFFSET\b/g, "\nOFFSET")
    .replace(/\bFETCH NEXT\b/g, "\nFETCH NEXT")
    .replace(/\nFROM \(\nSELECT/g, "\nFROM (\nSELECT")
    .replace(/\n\) AS (\[[^\]]+\])\s+\n/g, "\n) AS $1\n");
}

function formatSelectListForDebug(sql: string): string {
  if (!sql.startsWith("SELECT ")) return formatSqlClausesForDebug(sql);

  const fromIndex = findTopLevelKeyword(sql, " FROM ");
  if (fromIndex < 0) return sql;

  const selectList = sql.slice("SELECT ".length, fromIndex);
  const rest = sql.slice(fromIndex + 1);
  const items = splitTopLevelComma(selectList);

  if (items.length <= 1) return formatSqlClausesForDebug(sql);

  return `SELECT\n${items.join(",\n")}\n${formatSqlClausesForDebug(rest).trimStart()}`;
}

function findTopLevelKeyword(sql: string, keyword: string): number {
  let depth = 0;
  let inString = false;

  for (let index = 0; index <= sql.length - keyword.length; index++) {
    const char = sql[index];

    if (char === "'") {
      if (inString && sql[index + 1] === "'") {
        index++;
        continue;
      }

      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === "(") depth++;
    if (char === ")" && depth > 0) depth--;

    if (depth === 0 && sql.slice(index, index + keyword.length).toUpperCase() === keyword) {
      return index;
    }
  }

  return -1;
}

function splitTopLevelComma(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (char === "'") {
      if (inString && value[index + 1] === "'") {
        index++;
        continue;
      }

      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === "(") depth++;
    if (char === ")" && depth > 0) depth--;

    if (char === "," && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function compileSelectItem<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  item: QuerySelectItem<TRecord>,
  state: CompileState,
): string {
  if (isComputedSelectItem(item)) {
    const [alias, expression] = Object.entries(item)[0] ?? [];
    if (!alias || !expression) {
      throw new Error("Computed select items require exactly one alias");
    }

    return `${compileSqlExpression(table, expression, state)} AS ${quoteIdent(alias)}`;
  }

  const column = getColumn(table, item);
  return `${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS ${quoteIdent(String(column.propertyName))}`;
}

function isComputedSelectItem<TRecord extends RecordShape>(
  item: QuerySelectItem<TRecord>,
): item is Extract<QuerySelectItem<TRecord>, Record<string, SqlExpression>> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

function hasComputedSelectItems<TRecord extends RecordShape>(
  fields: readonly QuerySelectItem<TRecord>[] | undefined,
): boolean {
  return fields?.some(isComputedSelectItem) ?? false;
}

function selectedColumnFields<TRecord extends RecordShape>(
  fields: readonly QuerySelectItem<TRecord>[] | undefined,
): (keyof TRecord | string)[] | undefined {
  if (!fields) return undefined;
  return fields.filter(field => !isComputedSelectItem(field)) as (keyof TRecord | string)[];
}

function sqlDebugType(value: unknown): string {
  if (typeof value === "string") return "NVARCHAR(MAX)";
  if (typeof value === "boolean") return "BIT";
  if (typeof value === "bigint") return "BIGINT";
  if (typeof value === "number") return Number.isInteger(value) ? "INT" : "FLOAT";
  if (value instanceof Date) return "DATETIME2";
  if (value === null || value === undefined) return "SQL_VARIANT";
  if (value instanceof Uint8Array) return "VARBINARY(MAX)";

  return "NVARCHAR(MAX)";
}

function sqlDebugLiteral(value: unknown): string {
  if (typeof value === "string") return `N'${escapeSqlString(value)}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;

  return `N'${escapeSqlString(JSON.stringify(value))}'`;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Turns a Query into parameterized COUNT SQL. */
export function compileCount<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
>(
  query: Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes,
    TExplicitSelection
  >,
): CompiledSql {
  const snapshot = query.toSnapshot();
  const state: CompileState = { params: [], joins: new Map(), aliases: true };
  const whereSql = compileWhere(snapshot.table, snapshot.filters, state);
  const sql = [
    "SELECT COUNT(1) AS count",
    `FROM ${quoteIdent(snapshot.table.tableName)} AS ${quoteIdent("t0")}`,
    compileJoins(state),
    whereSql,
  ]
    .filter(Boolean)
    .join(" ");

  return { sql, params: state.params };
}

/** Turns a Query into parameterized AVG SQL for one field. */
export function compileAverage<
  TRecord extends RecordShape,
  TRelations extends Relations<TRecord>,
  TSelected extends keyof TRecord,
  TIncludes extends keyof TRelations,
  TExplicitSelection extends boolean,
>(
  query: Query<
    TRecord,
    TRelations,
    TSelected,
    TIncludes,
    TExplicitSelection
  >,
  field: keyof TRecord,
): CompiledSql {
  const snapshot = query.toSnapshot();
  const column = getColumn(snapshot.table, field);
  const state: CompileState = { params: [], joins: new Map(), aliases: true };
  const whereSql = compileWhere(snapshot.table, snapshot.filters, state);
  const sql = [
    `SELECT AVG(CAST(${quoteIdent("t0")}.${quoteIdent(column.dbName)} AS float)) AS average`,
    `FROM ${quoteIdent(snapshot.table.tableName)} AS ${quoteIdent("t0")}`,
    compileJoins(state),
    whereSql,
  ]
    .filter(Boolean)
    .join(" ");

  return { sql, params: state.params };
}

/** Builds parameterized INSERT SQL for one row. */
export function compileInsert<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  data: Partial<TRecord>,
): CompiledSql {
  const output = getColumns(table)
    .map(column => `INSERTED.${quoteIdent(column.dbName)} AS ${quoteIdent(String(column.propertyName))}`)
    .join(", ");
  const entries = Object.entries(data) as [keyof TRecord, unknown][];
  const insertable = entries
    .map(([field, value]) => ({ column: getColumn(table, field), value }))
    .filter(entry => !(entry.column.identity && entry.value === undefined));

  if (insertable.length === 0) {
    return {
      sql: `INSERT INTO ${quoteIdent(table.tableName)} OUTPUT ${output} DEFAULT VALUES`,
      params: [],
    };
  }

  return {
    sql: [
      `INSERT INTO ${quoteIdent(table.tableName)}`,
      `(${insertable.map(entry => quoteIdent(entry.column.dbName)).join(", ")})`,
      `OUTPUT ${output}`,
      `VALUES (${insertable.map((_, index) => paramName(index)).join(", ")})`,
    ].join(" "),
    params: insertable.map(entry => entry.value),
  };
}

/** Builds parameterized INSERT SQL for multiple rows. */
export function compileInsertMany<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  rows: readonly Partial<TRecord>[],
): CompiledSql {
  if (rows.length === 0) {
    throw new Error("createMany() requires at least one row");
  }

  if (rows.length === 1) {
    return compileInsert(table, rows[0] ?? {});
  }

  const fields = uniqueFields(rows).filter(field => !getColumn(table, field).identity);

  if (fields.length === 0) {
    throw new Error("createMany() with multiple rows requires at least one field");
  }

  const columns = fields.map(field => getColumn(table, field));
  const output = getColumns(table)
    .map(column => `INSERTED.${quoteIdent(column.dbName)} AS ${quoteIdent(String(column.propertyName))}`)
    .join(", ");
  const params: unknown[] = [];
  const valuesSql = rows
    .map(row => {
      const values = fields.map(field => {
        if (!Object.hasOwn(row, field)) {
          const column = getColumn(table, field);
          return column.hasDefault ? "DEFAULT" : pushRawParam(params, null);
        }

        return pushRawParam(params, row[field]);
      });

      return `(${values.join(", ")})`;
    })
    .join(", ");

  return {
    sql: [
      `INSERT INTO ${quoteIdent(table.tableName)}`,
      `(${columns.map(column => quoteIdent(column.dbName)).join(", ")})`,
      `OUTPUT ${output}`,
      `VALUES ${valuesSql}`,
    ].join(" "),
    params,
  };
}

/** Builds parameterized UPDATE SQL. */
export function compileUpdate<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  where: WhereInput<TRecord> | readonly QueryExpr<TRecord>[],
  data: UpdateData<TRecord>,
): CompiledSql {
  const entries = Object.entries(data) as [keyof TRecord, unknown][];

  if (entries.length === 0) {
    throw new Error("update() requires at least one field to modify");
  }

  const state: CompileState = { params: [], joins: new Map(), aliases: false };
  const setSql = entries
    .map(([field, value]) => {
      const column = getColumn(table, field);
      if (isSqlDefaultExpression(value)) {
        return `${quoteIdent(column.dbName)} = ${value.sql}`;
      }

      state.params.push(value);
      return `${quoteIdent(column.dbName)} = ${paramName(state.params.length - 1)}`;
    })
    .join(", ");
  const whereSql = compileWhere(table, normalizeWhere(where), state);

  return {
    sql: `UPDATE ${quoteIdent(table.tableName)} SET ${setSql} ${whereSql}`,
    params: state.params,
  };
}

/** Builds parameterized DELETE SQL. */
export function compileDelete<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  where: WhereInput<TRecord> | readonly QueryExpr<TRecord>[],
): CompiledSql {
  const state: CompileState = { params: [], joins: new Map(), aliases: false };
  const whereSql = compileWhere(table, normalizeWhere(where), state);

  return {
    sql: `DELETE FROM ${quoteIdent(table.tableName)} ${whereSql}`,
    params: state.params,
  };
}

function compileWhere<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  filters: readonly QueryExpr<TRecord>[],
  state: CompileState,
): string {
  if (filters.length === 0) return "";

  const nodes = filters.map(filter => compileExpr(table, filter, state)).filter(Boolean);
  return nodes.length ? `WHERE ${nodes.join(" AND ")}` : "";
}

function compileExpr<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  expr: QueryExpr<TRecord>,
  state: CompileState,
): string {
  if (expr.type === "and" || expr.type === "or") {
    const joiner = expr.type === "and" ? " AND " : " OR ";
    const nodes = expr.nodes.map(node => compileExpr(table, node, state)).filter(Boolean);

    if (nodes.length === 0) return "";
    if (nodes.length === 1) return nodes[0] ?? "";
    return `(${nodes.join(joiner)})`;
  }

  if (expr.type === "sql-predicate") {
    return compileSqlPredicate(table, expr, state);
  }

  const column = compileFieldRef(table, expr.field, state);
  const operator = expr.operator;
  if (!isOperatorName(operator.name)) {
    throw new Error(`Unsupported operator "${String(operator.name)}"`);
  }

  switch (operator.name) {
    case "is":
      if (operator.value === null) return `${column} IS NULL`;
      return `${column} = ${pushParam(state, operator.value)}`;
    case "not":
      if (operator.value === null) return `${column} IS NOT NULL`;
      return `${column} <> ${pushParam(state, operator.value)}`;
    case "gt":
      return `${column} > ${pushParam(state, operator.value)}`;
    case "gte":
      return `${column} >= ${pushParam(state, operator.value)}`;
    case "lt":
      return `${column} < ${pushParam(state, operator.value)}`;
    case "lte":
      return `${column} <= ${pushParam(state, operator.value)}`;
    case "between": {
      const values = operator.values ?? [];
      return `${column} BETWEEN ${pushParam(state, values[0])} AND ${pushParam(state, values[1])}`;
    }
    case "contains":
      return `${column} LIKE ${pushParam(state, `%${String(operator.value)}%`)}`;
    case "startsWith":
      return `${column} LIKE ${pushParam(state, `${String(operator.value)}%`)}`;
    case "endsWith":
      return `${column} LIKE ${pushParam(state, `%${String(operator.value)}`)}`;
    case "inList": {
      const values = operator.values ?? [];
      if (values.length === 0) return "1 = 0";
      return `${column} IN (${values.map(value => pushParam(state, value)).join(", ")})`;
    }
    case "isNull":
      return `${column} IS NULL`;
    case "notNull":
      return `${column} IS NOT NULL`;
    default: {
      const unsupported = operator as { readonly name?: unknown };
      throw new Error(`Unsupported operator "${String(unsupported.name)}"`);
    }
  }
}

function compileSqlPredicate<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  predicate: SqlPredicate,
  state: CompileState,
): string {
  const left = compileSqlExpression(table, predicate.left, state);

  if (predicate.right.kind === "value" && predicate.right.value === null) {
    if (predicate.operator === "=") return `${left} IS NULL`;
    if (predicate.operator === "<>") return `${left} IS NOT NULL`;
  }

  const right = compileSqlExpression(table, predicate.right, state);
  return `${left} ${predicate.operator} ${right}`;
}

function compileSqlExpression<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  expression: SqlExpression,
  state: CompileState,
): string {
  switch (expression.kind) {
    case "field":
      return compileFieldRef(table, expression.field, state);
    case "value":
      return pushParam(state, expression.value);
    case "aggregate":
      return compileSqlAggregate(table, expression, state);
    case "binary":
      return `(${compileSqlExpression(table, expression.left, state)} ${expression.operator} ${compileSqlExpression(table, expression.right, state)})`;
    case "coalesce":
      return `COALESCE(${compileSqlExpression(table, expression.expression, state)}, ${compileSqlExpression(table, expression.fallback, state)})`;
    default:
      throw new Error(`Unsupported SQL expression "${String((expression as SqlExpression).kind)}"`);
  }
}

function compileSqlAggregate<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  expression: Extract<SqlExpression, { kind: "aggregate" }>,
  state: CompileState,
): string {
  const aggregate = compileSqlAggregateName(expression.fn);

  if (expression.expression.kind === "field") {
    const relationAggregate = compileRelationAggregateSubquery(
      table,
      aggregate,
      expression.expression.field,
      state,
      expression.where,
    );

    if (relationAggregate) return relationAggregate;
  }

  return `${aggregate}(${compileSqlExpression(table, expression.expression, state)})`;
}

function compileSqlAggregateName(fn: Extract<SqlExpression, { kind: "aggregate" }>["fn"]): "SUM" | "COUNT" {
  switch (fn) {
    case "sum":
      return "SUM";
    case "count":
      return "COUNT";
    default:
      throw new Error(`Unsupported SQL aggregate "${String(fn)}"`);
  }
}

function compileRelationAggregateSubquery<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  aggregate: "SUM" | "COUNT",
  field: string,
  state: CompileState,
  where?: Readonly<Record<string, unknown>>,
): string | null {
  const resolvedRelation = tryResolveRelationPath(table, field);
  if (resolvedRelation) {
    if (aggregate !== "COUNT") return null;
    assertRelationAggregateSupported(field, state);
    return compileResolvedRelationAggregateSubquery(resolvedRelation, aggregate, field, state, null, where);
  }

  const parts = field.split(".");
  const columnName = parts.pop();
  const relationPath = parts.join(".");

  if (!columnName || !relationPath) return null;

  const resolved = resolveRelationPath(table as TableStatic<RecordShape>, relationPath);
  assertRelationAggregateSupported(field, state);
  return compileResolvedRelationAggregateSubquery(resolved, aggregate, field, state, columnName, where);
}

function assertRelationAggregateSupported(field: string, state: CompileState): void {
  if (!state.aliases) {
    throw new Error(`Relation aggregate "${field}" is only supported in SELECT/count.`);
  }
}

function tryResolveRelationPath<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  path: string,
): ReturnType<typeof resolveRelationPath> | null {
  try {
    return resolveRelationPath(table as TableStatic<RecordShape>, path);
  } catch {
    return null;
  }
}

function compileResolvedRelationAggregateSubquery(
  resolved: ReturnType<typeof resolveRelationPath>,
  aggregate: "SUM" | "COUNT",
  field: string,
  state: CompileState,
  columnName: string | null,
  where?: Readonly<Record<string, unknown>>,
): string {
  const aliases = resolved.segments.map((_, index) => `sq${index + 1}`);
  const firstSegment = resolved.segments[0];
  const firstAlias = aliases[0];
  const finalSegment = resolved.segments.at(-1);
  const finalAlias = aliases.at(-1);

  if (!firstSegment || !firstAlias || !finalSegment || !finalAlias) {
    throw new Error(`Invalid relation aggregate path "${field}"`);
  }

  const whereSql = firstSegment.relation.pairs
    .map(([local, foreign]) =>
      `${compileRelationOperandSql(firstSegment.parentTable, "t0", local, state)} = ${compileRelationOperandSql(firstSegment.table, firstAlias, foreign, state)}`,
    )
    .join(" AND ");

  const joins = resolved.segments.slice(1).map((segment, index) => {
    const parentAlias = aliases[index];
    const alias = aliases[index + 1];

    if (!parentAlias || !alias) {
      throw new Error(`Invalid relation aggregate path "${field}"`);
    }

    const onSql = segment.relation.pairs
      .map(([local, foreign]) =>
        `${compileRelationOperandSql(segment.parentTable, parentAlias, local, state)} = ${compileRelationOperandSql(segment.table, alias, foreign, state)}`,
      )
      .join(" AND ");
    const joinType = segment.relation.type === "belongsTo" ? segment.relation.join : "LEFT";

    return `${joinType} JOIN ${quoteIdent(segment.table.tableName)} AS ${quoteIdent(alias)} ON ${onSql}`;
  });

  const target = columnName
    ? `${quoteIdent(finalAlias)}.${quoteIdent(getColumn(finalSegment.table, columnName).dbName)}`
    : "1";
  const filterSql = compileRelationAggregateFilters(resolved, aliases, where, state);

  return `(${[
    `SELECT ${aggregate}(${target})`,
    `FROM ${quoteIdent(firstSegment.table.tableName)} AS ${quoteIdent(firstAlias)}`,
    ...joins,
    `WHERE ${[whereSql, ...filterSql].join(" AND ")}`,
  ].join(" ")})`;
}

function compileRelationAggregateFilters(
  resolved: ReturnType<typeof resolveRelationPath>,
  aliases: readonly string[],
  where: Readonly<Record<string, unknown>> | undefined,
  state: CompileState,
): string[] {
  if (!where) return [];

  return flattenAggregateWhere(where).map(([field, value]) => {
    const column = compileRelationAggregateFilterColumn(resolved, aliases, field);
    return compileColumnFilter(column, value, state);
  });
}

function flattenAggregateWhere(
  where: Readonly<Record<string, unknown>>,
  prefix = "",
): [string, unknown][] {
  return Object.entries(where).flatMap(([field, value]) => {
    const path = prefix ? `${prefix}.${field}` : field;
    if (isPlainAggregateWhere(value)) {
      return flattenAggregateWhere(value, path);
    }

    return [[path, value]];
  });
}

function isPlainAggregateWhere(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isOperator(value) &&
    !(value instanceof Date)
  );
}

function compileRelationAggregateFilterColumn(
  resolved: ReturnType<typeof resolveRelationPath>,
  aliases: readonly string[],
  field: string,
): string {
  const parts = field.split(".");
  const columnName = parts.pop();
  const relationPath = parts.join(".");

  if (!columnName) {
    throw new Error(`Invalid relation aggregate filter "${field}"`);
  }

  const segmentIndex = relationPath
    ? resolved.segments.findIndex(segment => segment.path === relationPath)
    : 0;
  const segment = resolved.segments[segmentIndex];
  const alias = aliases[segmentIndex];

  if (!segment || !alias) {
    throw new Error(`Relation aggregate filter "${field}" is outside relation "${resolved.path}"`);
  }

  const column = getColumn(segment.table, columnName);
  return `${quoteIdent(alias)}.${quoteIdent(column.dbName)}`;
}

function compileColumnFilter(column: string, rawValue: unknown, state: CompileState): string {
  const operator = Array.isArray(rawValue)
    ? { type: "operator" as const, name: "inList" as const, values: rawValue }
    : isOperator(rawValue)
      ? rawValue
      : { type: "operator" as const, name: "is" as const, value: rawValue };

  switch (operator.name) {
    case "is":
      if (operator.value === null) return `${column} IS NULL`;
      return `${column} = ${pushParam(state, operator.value)}`;
    case "not":
      if (operator.value === null) return `${column} IS NOT NULL`;
      return `${column} <> ${pushParam(state, operator.value)}`;
    case "gt":
      return `${column} > ${pushParam(state, operator.value)}`;
    case "gte":
      return `${column} >= ${pushParam(state, operator.value)}`;
    case "lt":
      return `${column} < ${pushParam(state, operator.value)}`;
    case "lte":
      return `${column} <= ${pushParam(state, operator.value)}`;
    case "between": {
      const values = operator.values ?? [];
      return `${column} BETWEEN ${pushParam(state, values[0])} AND ${pushParam(state, values[1])}`;
    }
    case "contains":
      return `${column} LIKE ${pushParam(state, `%${String(operator.value)}%`)}`;
    case "startsWith":
      return `${column} LIKE ${pushParam(state, `${String(operator.value)}%`)}`;
    case "endsWith":
      return `${column} LIKE ${pushParam(state, `%${String(operator.value)}`)}`;
    case "inList": {
      const values = operator.values ?? [];
      if (values.length === 0) return "1 = 0";
      return `${column} IN (${values.map(value => pushParam(state, value)).join(", ")})`;
    }
    case "isNull":
      return `${column} IS NULL`;
    case "notNull":
      return `${column} IS NOT NULL`;
    default: {
      const unsupported = operator as { readonly name?: unknown };
      throw new Error(`Unsupported operator "${String(unsupported.name)}"`);
    }
  }
}

function compileRelationOperandSql(
  table: TableStatic<RecordShape>,
  alias: string,
  operand: unknown,
  state: CompileState,
): string {
  return compileJoinOperandSql(compileJoinOperand(table, alias, operand, state));
}

function compileGroupBy<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  fields: readonly (keyof TRecord | string)[],
  state: CompileState,
): string {
  if (fields.length === 0) return "";

  const parts = fields.map(field => compileFieldRef(table, field, state));
  return `GROUP BY ${parts.join(", ")}`;
}

function compileOrderBy<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  orderByValues: readonly { field: keyof TRecord | string; direction: "asc" | "desc" }[],
  state: CompileState,
  required = false,
): string {
  if (orderByValues.length === 0) return required ? "ORDER BY (SELECT NULL)" : "";

  const parts = orderByValues.map(order => {
    const column = compileFieldRef(table, order.field, state);
    const direction = compileOrderDirection(order.direction);
    return `${column} ${direction}`;
  });

  return `ORDER BY ${parts.join(", ")}`;
}

function compileOrderDirection(direction: unknown): "ASC" | "DESC" {
  if (direction === "asc") return "ASC";
  if (direction === "desc") return "DESC";
  throw new Error(`Unsupported order direction "${String(direction)}"`);
}

function normalizeWhere<TRecord extends RecordShape>(
  where: WhereInput<TRecord> | readonly QueryExpr<TRecord>[],
): readonly QueryExpr<TRecord>[] {
  if (Array.isArray(where) && where.every(isQueryExpr)) {
    return where as readonly QueryExpr<TRecord>[];
  }

  return [parseWhere(where as WhereInput<TRecord>)];
}

function isQueryExpr<TRecord extends RecordShape>(value: unknown): value is QueryExpr<TRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  if (type === "field" || type === "sql-predicate") return true;
  if (type !== "and" && type !== "or") return false;

  const nodes = (value as { nodes?: unknown }).nodes;
  return Array.isArray(nodes);
}

function compileLimitOffset(limitValue: number | undefined, offsetValue: number | undefined, state: CompileState): string {
  if (limitValue === undefined && offsetValue === undefined) return "";

  const offset = offsetValue ?? 0;
  const parts = [`OFFSET ${pushParam(state, offset)} ROWS`];

  if (limitValue !== undefined) {
    parts.push(`FETCH NEXT ${pushParam(state, limitValue)} ROWS ONLY`);
  }

  return parts.join(" ");
}

function compileFieldRef<TRecord extends RecordShape>(
  table: TableStatic<TRecord>,
  field: keyof TRecord | string,
  state: CompileState,
): string {
  const rawPath = String(field);
  const parts = rawPath.split(".");

  if (parts.length === 1) {
    const column = getColumn(table, field as keyof TRecord);
    return state.aliases
      ? `${quoteIdent("t0")}.${quoteIdent(column.dbName)}`
      : quoteIdent(column.dbName);
  }

  if (!state.aliases) {
    throw new Error(
      `Relation filter "${rawPath}" is only supported in SELECT/count.`,
    );
  }

  const columnName = parts.pop();
  const relationPath = parts.join(".");

  if (!columnName || !relationPath) {
    throw new Error(`Unsupported column path: "${rawPath}"`);
  }

  const join = ensureJoinPath(
    table as TableStatic<RecordShape>,
    relationPath,
    state,
  );
  const column = getColumn(join.table, columnName);

  return `${quoteIdent(join.alias)}.${quoteIdent(column.dbName)}`;
}

function ensureJoinPath(
  rootTable: TableStatic<RecordShape>,
  path: string,
  state: CompileState,
): JoinRef {
  const resolved = resolveRelationPath(rootTable, path);
  let currentJoin: JoinRef | undefined;

  for (const segment of resolved.segments) {
    const existing = state.joins.get(segment.path);
    if (existing) {
      currentJoin = existing;
      continue;
    }

    currentJoin = ensureJoinSegment(segment, state);
  }

  if (!currentJoin) {
    throw new Error(`Invalid relation path "${path}"`);
  }

  return currentJoin;
}

function ensureJoinSegment(
  segment: ResolvedRelationSegment,
  state: CompileState,
): JoinRef {
  const existing = state.joins.get(segment.path);
  if (existing) return existing;

  const parentAlias = segment.parentPath
    ? state.joins.get(segment.parentPath)?.alias
    : "t0";

  if (!parentAlias) {
    throw new Error(
      `Parent relation "${segment.parentPath}" was not joined before "${segment.path}"`,
    );
  }

  const alias = `t${state.joins.size + 1}`;
  const conditions = segment.relation.pairs.map(
    ([local, foreign]): JoinCondition => ({
      local: compileJoinOperand(
        segment.parentTable,
        parentAlias,
        local,
        state,
      ),
      foreign: compileJoinOperand(
        segment.table,
        alias,
        foreign,
        state,
      ),
    }),
  );

  const join: JoinRef = {
    path: segment.path,
    parentPath: segment.parentPath,
    parentAlias,
    alias,
    relationName: segment.name,
    relation: segment.relation,
    table: segment.table,
    conditions,
    joinType:
      segment.relation.type === "belongsTo"
        ? segment.relation.join
        : "LEFT",
  };

  state.joins.set(segment.path, join);
  return join;
}

function compileJoinOperand(
  table: TableStatic<RecordShape>,
  alias: string,
  operand: unknown,
  state: CompileState,
): JoinOperand {
  if (isSqlJoinValue(operand)) {
    return {
      type: "parameter",
      parameter: pushParam(state, operand.value),
    };
  }

  if (
    typeof operand !== "string" &&
    typeof operand !== "number" &&
    typeof operand !== "symbol"
  ) {
    throw new Error(`Invalid relation operand "${String(operand)}"`);
  }

  const column = getColumn(table, operand as keyof RecordShape);

  return {
    type: "column",
    alias,
    column: column.dbName,
  };
}

function compileJoins(state: CompileState): string {
  return [...state.joins.values()]
    .map(join => {
      const onSql = join.conditions
        .map(condition =>
          `${compileJoinOperandSql(condition.local)} = ${compileJoinOperandSql(condition.foreign)}`,
        )
        .join(" AND ");

      return [
        `${join.joinType} JOIN`,
        `${quoteIdent(join.table.tableName)} AS ${quoteIdent(join.alias)}`,
        `ON ${onSql}`,
      ].join(" ");
    })
    .join(" ");
}

function compileJoinOperandSql(operand: JoinOperand): string {
  if (operand.type === "parameter") {
    return operand.parameter;
  }

  return `${quoteIdent(operand.alias)}.${quoteIdent(operand.column)}`;
}

function relationIdentityColumns(
  table: TableStatic<RecordShape>,
  relation: RelationDef<RecordShape>,
  visibleColumns: readonly ReturnType<typeof getColumns>[number][],
): ReturnType<typeof getColumns> {
  const primaryKeys = getColumns(table).filter(column => column.primaryKey);
  if (primaryKeys.length > 0) return primaryKeys;

  const joinColumns = relation.pairs.flatMap(([, foreign]) => {
    if (isSqlJoinValue(foreign)) return [];
    return [getColumn(table, foreign as keyof RecordShape)];
  });

  const uniqueJoinColumns = uniqueColumns(joinColumns);
  if (uniqueJoinColumns.length > 0) return uniqueJoinColumns;

  return uniqueColumns(visibleColumns);
}

function uniqueColumns(
  columns: readonly ReturnType<typeof getColumns>[number][],
): ReturnType<typeof getColumns> {
  const result: ReturnType<typeof getColumns> = [];
  const names = new Set<string>();

  for (const column of columns) {
    const name = String(column.propertyName);
    if (names.has(name)) continue;
    names.add(name);
    result.push(column);
  }

  return result;
}

function encodeRelationPath(path: string): string {
  return path.split(".").join(RELATION_SEPARATOR);
}

function pushParam(state: CompileState, value: unknown): string {
  state.params.push(value);
  return paramName(state.params.length - 1);
}

function paramName(index: number): string {
  return `@p${index + 1}`;
}

function pushRawParam(params: unknown[], value: unknown): string {
  params.push(value);
  return paramName(params.length - 1);
}

function uniqueFields<TRecord extends RecordShape>(rows: readonly Partial<TRecord>[]): (keyof TRecord)[] {
  const fields: (keyof TRecord)[] = [];
  const seen = new Set<keyof TRecord>();

  for (const row of rows) {
    for (const field of Object.keys(row) as (keyof TRecord)[]) {
      if (seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  }

  return fields;
}
