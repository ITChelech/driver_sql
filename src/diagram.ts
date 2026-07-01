import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getColumn, getColumns } from "./metadata.js";
import type { ColumnDef, RecordShape, TableStatic } from "./types.js";
import { isSqlJoinValue } from "./relations.js";

/** Creates a Mermaid ER diagram from your table models. */
export function createSchemaDiagram(
  models: readonly TableStatic<RecordShape>[],
): string {
  const tables = collectRelatedTables(models);
  const foreignKeys = collectForeignKeys(tables);
  const lines = ["erDiagram"];

  for (const table of tables) {
    const entity = diagramIdentifier(table.tableName);

    const tableForeignKeys = foreignKeys.get(table) ?? new Set<string>();
    lines.push(`  ${entity} {`);

    for (const column of getColumns(table)) {
      const keys = [
        column.primaryKey ? "PK" : "",
        tableForeignKeys.has(String(column.propertyName)) ? "FK" : "",
        column.unique && !column.primaryKey ? "UK" : "",
      ].filter(Boolean);
      const comment = columnComment(column);

      lines.push(
        [
          "    ",
          diagramColumnType(column),
          diagramIdentifier(column.dbName),
          keys.length ? keys.join(",") : "",
          comment ? `"${comment}"` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    lines.push("  }");
  }

  for (const table of tables) {
    for (const [relationName, relation] of Object.entries(table.relations ?? {})) {
      if (relation.type !== "belongsTo") continue;

      const foreignTable = relation.table();
      const columnPairs = relation.pairs.filter(
        ([local, foreign]) =>
          !isSqlJoinValue(local) &&
          !isSqlJoinValue(foreign),
      );

      if (columnPairs.length === 0) {
        continue;
      }

      const localColumns = columnPairs.map(
        ([local]) =>
          getColumn(
            table,
            local as keyof RecordShape,
          ),
      );

      for (const [, foreign] of columnPairs) {
        getColumn(
          foreignTable,
          foreign as keyof RecordShape,
        );
      }

      //for (const [, foreign] of relation.pairs) getColumn(foreignTable, foreign);

      const parentCardinality = localColumns.every(column => column.nullable === false) ? "||" : "o|";
      const childCardinality = localColumns.every(column => column.unique) ? "o|" : "o{";
      lines.push(
        `  ${diagramIdentifier(foreignTable.tableName)} ${parentCardinality}--${childCardinality} ${diagramIdentifier(table.tableName)} : "${escapeLabel(relationName)}"`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Writes a Mermaid ER diagram to a file and returns its contents. */
export async function writeSchemaDiagram(
  outputPath: string,
  models: readonly TableStatic<RecordShape>[],
): Promise<string> {
  const diagram = createSchemaDiagram(models);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, diagram, "utf8");
  return diagram;
}

function collectRelatedTables(
  initialModels: readonly TableStatic<RecordShape>[],
): TableStatic<RecordShape>[] {
  const tables: TableStatic<RecordShape>[] = [];
  const tableNames = new Map<string, TableStatic<RecordShape>>();
  const pending = [...initialModels];

  while (pending.length > 0) {
    const table = pending.shift();
    if (!table) break;

    const existing = tableNames.get(table.tableName);
    if (existing) {
      if (existing !== table) {
        throw new Error(`Duplicate table name "${table.tableName}" in schema diagram`);
      }
      continue;
    }

    tableNames.set(table.tableName, table);
    tables.push(table);

    for (const relation of Object.values(table.relations ?? {})) {
      if (relation.type === "belongsTo") {
        pending.push(relation.table());
      }
    }
  }

  return tables;
}

function collectForeignKeys(
  tables: readonly TableStatic<RecordShape>[],
): Map<TableStatic<RecordShape>, Set<string>> {
  return new Map(
    tables.map(table => [
      table,
      new Set(
        Object.values(table.relations ?? {})
          .filter(relation => relation.type === "belongsTo")
          .flatMap(relation =>
            relation.pairs.flatMap(([local]) =>
              isSqlJoinValue(local)
                ? []
                : [String(local)],
            ),
          )
      ),
    ]),
  );
}

function diagramColumnType(column: ColumnDef): string {
  switch (column.kind) {
    case "int":
      return "int";
    case "string":
      return `nvarchar_${column.length === "max" ? "max" : column.length ?? 255}`;
    case "boolean":
      return "bit";
    case "datetime":
      return "datetime2";
    case "decimal":
      return `decimal_${column.precision ?? 18}_${column.scale ?? 2}`;
    case "json":
      return "nvarchar_max";
  }
}

function columnComment(column: ColumnDef): string {
  const details = [];
  if (column.nullable !== false && !column.primaryKey) details.push("nullable");
  if (column.identity) details.push("identity");
  return details.join(", ");
}

function diagramIdentifier(value: string): string {
  const identifier = value.replaceAll(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(identifier) ? identifier : `_${identifier}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
