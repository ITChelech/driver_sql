import { isSqlDefaultExpression } from "./date-time.js";
import { getColumn, getColumns, quoteIdent } from "./metadata.js";
import type { ColumnDef, RecordShape, SqlDriver, TableStatic } from "./types.js";
import { isSqlJoinValue } from "./relations.js";

export type SchemaSyncOptions = {
  includeRelations?: boolean;
  schema?: string;
  logger?: Pick<Console, "log" | "warn">;
  verbose?: boolean;
};

export type SchemaSqlOptions = {
  dropExisting?: boolean;
  includeRelations?: boolean;
  schema?: string;
};

type DbColumn = {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
};

type SyncAction = {
  table: string;
  action: "created-table" | "added-column" | "altered-column" | "created-relation" | "noop";
  detail: string;
};

/** Creates or updates database tables to match your local models. */
export async function syncSchema(
  driver: SqlDriver,
  models: readonly TableStatic<RecordShape>[],
  options: SchemaSyncOptions = {},
): Promise<SyncAction[]> {
  const schema = options.schema ?? "dbo";
  const logger = options.logger ?? console;
  const verbose = options.verbose ?? true;
  const actions: SyncAction[] = [];

  if (verbose) {
    logger.log(`schema sync: ${models.length} model(s), schema ${schema}, relations ${options.includeRelations ? "yes" : "no"}`);
  }

  for (const model of models) {
    const result = await syncTable(driver, model, schema, { logger, verbose });
    actions.push(...result);
    result.forEach(action => logger.log(formatAction(action)));
  }

  if (options.includeRelations) {
    for (const model of models) {
      const result = await syncRelations(driver, model, schema, { logger, verbose });
      actions.push(...result);
      result.forEach(action => logger.log(formatAction(action)));
    }
  }

  logger.log(formatSummary(actions));

  return actions;
}

/** Generates CREATE TABLE SQL from your local models. */
export function createSchemaSql(
  models: readonly TableStatic<RecordShape>[],
  options: SchemaSqlOptions = {},
): string {
  const schema = options.schema ?? "dbo";
  const includeRelations = options.includeRelations ?? true;
  const statements = options.dropExisting
    ? dropOrder(models).map(model => compileDropTable(schema, model))
    : [];

  statements.push(...models.map(model => compileCreateTable(schema, model)));

  if (includeRelations) {
    for (const model of models) {
      for (const relation of Object.values(model.relations ?? {})) {
        if (relation.type !== "belongsTo") continue;

        if (
          relation.type !== "belongsTo" ||
          !isPhysicalForeignKeyRelation(relation)
        ) {
          continue;
        }

        statements.push(compileCreateRelation(schema, model, relation));
      }
    }
  }

  return `${statements.map(statement => `${statement};`).join("\nGO\n\n")}\n`;
}

/** Generates schema SQL, prints it, and returns the same SQL string. */
export function printSchemaSql(
  models: readonly TableStatic<RecordShape>[],
  options: SchemaSqlOptions = {},
  logger: Pick<Console, "log"> = console,
): string {
  const sql = createSchemaSql(models, options);
  logger.log(sql);
  return sql;
}

async function syncTable(
  driver: SqlDriver,
  model: TableStatic<RecordShape>,
  schema: string,
  log: { logger: Pick<Console, "log" | "warn">; verbose: boolean },
): Promise<SyncAction[]> {
  const modelColumns = getColumns(model);

  if (log.verbose) {
    log.logger.log(`checking-table: ${schema}.${model.tableName} (${modelColumns.length} model column(s))`);
  }

  const exists = await tableExists(driver, schema, model.tableName);

  if (!exists) {
    if (log.verbose) {
      log.logger.log(`missing-table: ${schema}.${model.tableName}; creating full table`);
      modelColumns.forEach(column => log.logger.log(`  + ${column.dbName} ${describeExpectedColumn(column)}`));
    }

    await driver.execute({ sql: compileCreateTable(schema, model), params: [] });
    return [{ table: model.tableName, action: "created-table", detail: "table created from local model" }];
  }

  const actions: SyncAction[] = [];
  const dbColumns = await loadColumns(driver, schema, model.tableName);

  if (log.verbose) {
    log.logger.log(`found-table: ${schema}.${model.tableName} (${dbColumns.size} DB column(s))`);
  }

  for (const column of modelColumns) {
    const existing = dbColumns.get(column.dbName.toLowerCase());

    if (!existing) {
      if (log.verbose) {
        log.logger.log(`  + add-column: ${model.tableName}.${column.dbName} ${describeExpectedColumn(column)}`);
      }

      await driver.execute({ sql: compileAddColumn(schema, model.tableName, column), params: [] });
      actions.push({
        table: model.tableName,
        action: "added-column",
        detail: `column ${column.dbName} ${describeExpectedColumn(column)}`,
      });
      continue;
    }

    if (columnNeedsAlter(column, existing)) {
      if (log.verbose) {
        log.logger.log(
          `  ~ alter-column: ${model.tableName}.${column.dbName} ${describeDbColumn(existing)} -> ${describeExpectedColumn(column)}`,
        );
      }

      await driver.execute({ sql: compileAlterColumn(schema, model.tableName, column), params: [] });
      actions.push({
        table: model.tableName,
        action: "altered-column",
        detail: `column ${column.dbName} ${describeDbColumn(existing)} -> ${describeExpectedColumn(column)}`,
      });
    } else if (log.verbose) {
      log.logger.log(`  = ok-column: ${model.tableName}.${column.dbName} ${describeExpectedColumn(column)}`);
    }
  }

  if (actions.length === 0 && log.verbose) {
    log.logger.log(`ok-table: ${schema}.${model.tableName} no changes`);
  }

  return actions;
}

async function syncRelations(
  driver: SqlDriver,
  model: TableStatic<RecordShape>,
  schema: string,
  log: { logger: Pick<Console, "log" | "warn">; verbose: boolean },
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  const relations = Object.entries(model.relations ?? {});

  if (log.verbose && relations.length > 0) {
    log.logger.log(`checking-relations: ${model.tableName} (${relations.length})`);
  }

  for (const [name, relation] of relations) {
    if (relation.type !== "belongsTo") continue;

    if (!isPhysicalForeignKeyRelation(relation)) {
      if (log.verbose) {
        log.logger.log(
          `  - skip-relation: ${name} contains constant join values and cannot create a foreign key`,
        );
      }

      continue;
    }

    const foreignTable = relation.table();
    const localColumns = relation.pairs.map(([local]) => getColumn(model, local as keyof RecordShape));
    const foreignColumns = relation.pairs.map(([, foreign]) => getColumn(foreignTable, foreign as keyof RecordShape));
    const constraintName = foreignKeyName(
      model.tableName,
      localColumns.map(column => column.dbName).join("_"),
      foreignTable.tableName,
      foreignColumns.map(column => column.dbName).join("_"),
    );
    const exists = await constraintExists(driver, constraintName);

    if (exists) {
      if (log.verbose) {
        log.logger.log(`  = ok-relation: ${constraintName}`);
      }
      continue;
    }

    const sql = compileCreateRelation(schema, model, relation);

    if (log.verbose) {
      log.logger.log(
        `  + add-relation: ${constraintName} (${model.tableName}.(${localColumns.map(column => column.dbName).join(", ")}) -> ${foreignTable.tableName}.(${foreignColumns.map(column => column.dbName).join(", ")}))`,
      );
    }

    await driver.execute({ sql, params: [] });
    actions.push({
      table: model.tableName,
      action: "created-relation",
      detail: `relation ${name} -> ${foreignTable.tableName}`,
    });
  }

  return actions;
}

function compileCreateRelation(
  schema: string,
  model: TableStatic<RecordShape>,
  relation: NonNullable<TableStatic<RecordShape>["relations"]>[string],
): string {
  if (relation.type !== "belongsTo") {
    throw new Error("Only belongsTo relations create foreign keys");
  }

  const foreignTable = relation.table();
  const localColumns = relation.pairs.map(([local]) => getColumn(model, local as keyof RecordShape));
  const foreignColumns = relation.pairs.map(([, foreign]) => getColumn(foreignTable, foreign as keyof RecordShape));
  const constraintName = foreignKeyName(
    model.tableName,
    localColumns.map(column => column.dbName).join("_"),
    foreignTable.tableName,
    foreignColumns.map(column => column.dbName).join("_"),
  );

  return [
    `ALTER TABLE ${tableName(schema, model.tableName)}`,
    `ADD CONSTRAINT ${quoteIdent(constraintName)}`,
    `FOREIGN KEY (${localColumns.map(column => quoteIdent(column.dbName)).join(", ")})`,
    `REFERENCES ${tableName(schema, foreignTable.tableName)} (${foreignColumns.map(column => quoteIdent(column.dbName)).join(", ")})`,
    relation.onDelete ? `ON DELETE ${relation.onDelete}` : "",
    relation.onUpdate ? `ON UPDATE ${relation.onUpdate}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function tableExists(driver: SqlDriver, schema: string, table: string): Promise<boolean> {
  const value = await driver.scalar<number>({
    sql: "SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2",
    params: [schema, table],
  });

  return Number(value ?? 0) > 0;
}

async function constraintExists(driver: SqlDriver, name: string): Promise<boolean> {
  const value = await driver.scalar<number>({
    sql: "SELECT COUNT(1) FROM sys.foreign_keys WHERE name = @p1",
    params: [name],
  });

  return Number(value ?? 0) > 0;
}

async function loadColumns(driver: SqlDriver, schema: string, table: string): Promise<Map<string, DbColumn>> {
  const rows = await driver.query<RecordShape>({
    sql: `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2
    `,
    params: [schema, table],
  });

  return new Map(
    rows.map(row => {
      const column: DbColumn = {
        name: String(row.COLUMN_NAME),
        type: String(row.DATA_TYPE).toLowerCase(),
        maxLength: row.CHARACTER_MAXIMUM_LENGTH === null ? null : Number(row.CHARACTER_MAXIMUM_LENGTH),
        precision: row.NUMERIC_PRECISION === null ? null : Number(row.NUMERIC_PRECISION),
        scale: row.NUMERIC_SCALE === null ? null : Number(row.NUMERIC_SCALE),
        nullable: row.IS_NULLABLE === "YES",
      };

      return [column.name.toLowerCase(), column];
    }),
  );
}

function compileCreateTable(modelSchema: string, model: TableStatic<RecordShape>): string {
  const columns = getColumns(model);
  const columnSql = columns.map(column => compileColumn(column));
  const primaryKeys = columns.filter(column => column.primaryKey);
  const uniqueColumns = columns.filter(column => column.unique && !column.primaryKey);
  const constraints = [
    primaryKeys.length
      ? `CONSTRAINT ${quoteIdent(primaryKeyName(model.tableName))} PRIMARY KEY (${primaryKeys
        .map(column => quoteIdent(column.dbName))
        .join(", ")})`
      : "",
    ...uniqueColumns.map(
      column =>
        `CONSTRAINT ${quoteIdent(uniqueName(model.tableName, column.dbName))} UNIQUE (${quoteIdent(column.dbName)})`,
    ),
  ].filter(Boolean);

  return `CREATE TABLE ${tableName(modelSchema, model.tableName)} (${[...columnSql, ...constraints].join(", ")})`;
}

function compileDropTable(modelSchema: string, model: TableStatic<RecordShape>): string {
  return `DROP TABLE IF EXISTS ${tableName(modelSchema, model.tableName)}`;
}

function dropOrder(models: readonly TableStatic<RecordShape>[]): TableStatic<RecordShape>[] {
  const modelSet = new Set(models);
  const remainingDependencies = new Map(
    models.map(model => [
      model,
      new Set(
        Object.values(model.relations ?? {})
          .filter(relation => relation.type === "belongsTo")
          .map(relation => relation.table())
          .filter(foreignModel => foreignModel !== model && modelSet.has(foreignModel)),
      ),
    ]),
  );
  const ordered: TableStatic<RecordShape>[] = [];

  while (remainingDependencies.size > 0) {
    const referencedModels = new Set(
      [...remainingDependencies.values()].flatMap(dependencies => [...dependencies]),
    );
    const next = models.find(
      model => remainingDependencies.has(model) && !referencedModels.has(model),
    );

    if (!next) {
      throw new Error("Cannot generate DROP TABLE order because the model relations contain a cycle");
    }

    ordered.push(next);
    remainingDependencies.delete(next);
  }

  return ordered;
}

function compileAddColumn(schema: string, table: string, column: ColumnDef & { dbName: string }): string {
  return `ALTER TABLE ${tableName(schema, table)} ADD ${compileColumn(column)}`;
}

function compileAlterColumn(schema: string, table: string, column: ColumnDef & { dbName: string }): string {
  return `ALTER TABLE ${tableName(schema, table)} ALTER COLUMN ${quoteIdent(column.dbName)} ${sqlType(column)} ${nullability(column)}`;
}

function compileColumn(column: ColumnDef & { dbName: string }): string {
  return [
    quoteIdent(column.dbName),
    sqlType(column),
    column.identity ? "IDENTITY(1,1)" : "",
    column.primaryKey ? "NOT NULL" : nullability(column),
    defaultSql(column),
  ]
    .filter(Boolean)
    .join(" ");
}

function sqlType(column: ColumnDef): string {
  switch (column.kind) {
    case "int":
      return "INT";
    case "string":
      return `NVARCHAR(${column.length === "max" ? "MAX" : column.length ?? 255})`;
    case "boolean":
      return "BIT";
    case "datetime":
      return "DATETIME2";
    case "decimal":
      return `DECIMAL(${column.precision ?? 18}, ${column.scale ?? 2})`;
    case "json":
      return "NVARCHAR(MAX)";
  }
}

function nullability(column: ColumnDef): string {
  return column.nullable === false ? "NOT NULL" : "NULL";
}

function defaultSql(column: ColumnDef): string {
  if (!column.hasDefault || typeof column.defaultValue === "function") return "";

  if (isSqlDefaultExpression(column.defaultValue)) return `DEFAULT ${column.defaultValue.sql}`;
  if (typeof column.defaultValue === "string") return `DEFAULT ${quoteString(column.defaultValue)}`;
  if (typeof column.defaultValue === "number") return `DEFAULT ${column.defaultValue}`;
  if (typeof column.defaultValue === "boolean") return `DEFAULT ${column.defaultValue ? 1 : 0}`;
  if (column.defaultValue === null) return "DEFAULT NULL";

  return "";
}

function columnNeedsAlter(expected: ColumnDef, existing: DbColumn): boolean {
  if (existing.nullable !== (expected.nullable !== false && !expected.primaryKey)) {
    return true;
  }

  switch (expected.kind) {
    case "int":
      return existing.type !== "int";
    case "string":
      return existing.type !== "nvarchar" || existing.maxLength !== (expected.length === "max" ? -1 : expected.length ?? 255);
    case "boolean":
      return existing.type !== "bit";
    case "datetime":
      return existing.type !== "datetime2";
    case "decimal":
      return (
        existing.type !== "decimal" ||
        existing.precision !== (expected.precision ?? 18) ||
        existing.scale !== (expected.scale ?? 2)
      );
    case "json":
      return existing.type !== "nvarchar" || existing.maxLength !== -1;
  }
}

function tableName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function primaryKeyName(table: string): string {
  return `PK_${table}`;
}

function uniqueName(table: string, column: string): string {
  return `UQ_${table}_${column}`;
}

function foreignKeyName(table: string, local: string, foreignTable: string, foreign: string): string {
  return `FK_${table}_${local}_${foreignTable}_${foreign}`;
}

function formatAction(action: SyncAction): string {
  return `${action.action}: ${action.table} - ${action.detail}`;
}

function formatSummary(actions: readonly SyncAction[]): string {
  if (actions.length === 0) {
    return "schema summary: ok, no pending changes";
  }

  const counts = actions.reduce<Record<string, number>>((total, action) => {
    total[action.action] = (total[action.action] ?? 0) + 1;
    return total;
  }, {});

  return `schema summary: ${actions.length} change(s) - ${Object.entries(counts)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ")}`;
}

function describeExpectedColumn(column: ColumnDef): string {
  return `${sqlType(column)} ${column.primaryKey ? "NOT NULL" : nullability(column)}${column.primaryKey ? " PRIMARY KEY" : ""}${column.unique ? " UNIQUE" : ""
    }`;
}

function describeDbColumn(column: DbColumn): string {
  const length =
    column.type === "nvarchar" && column.maxLength !== null ? `(${column.maxLength === -1 ? "MAX" : column.maxLength})` : "";
  const numeric =
    column.type === "decimal" && column.precision !== null && column.scale !== null
      ? `(${column.precision}, ${column.scale})`
      : "";

  return `${column.type.toUpperCase()}${length}${numeric} ${column.nullable ? "NULL" : "NOT NULL"}`;
}

function isPhysicalForeignKeyRelation(
  relation: NonNullable<
    TableStatic<RecordShape>["relations"]
  >[string],
): boolean {
  return relation.pairs.every(
    ([local, foreign]) =>
      !isSqlJoinValue(local) &&
      !isSqlJoinValue(foreign),
  );
}
