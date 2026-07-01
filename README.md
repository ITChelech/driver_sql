# driver_sql

Small TypeScript helper for defining SQL Server tables, building typed queries,
and running them through a simple driver interface.

## Install

```bash
npm install driver_sql
```

If you want to use the built-in SQL Server driver, also install `mssql`:

```bash
npm install mssql
```

## Quick Example

```ts
import {
  MssqlDriver,
  Table,
  int,
  setDefaultDriver,
  string,
  type Columns,
} from "driver_sql";

type UserRow = {
  id: number;
  email: string;
  name: string;
};

class Users extends Table<UserRow> {
  static tableName = "users";
  static columns: Columns<UserRow> = {
    id: int().primaryKey().identity(),
    email: string(255).notNull().unique(),
    name: string(120).notNull(),
  };
}

setDefaultDriver(new MssqlDriver({
  server: "localhost",
  user: "sa",
  password: "your-password",
  database: "app",
  options: { trustServerCertificate: true },
}));

const user = await Users
  .where({ email: "admin@example.com" })
  .first();
```

## Watching Changes

Use `live()` when you want to poll a query and receive row-level changes. The
default signature hashes the selected rows, which is exact but can be expensive
on large tables. For heavy tables, use a column that changes on every insert or
update, such as `updated_at`, `rowversion`, or a sync/version number.

```ts
const watcher = Products
  .where({ KOLT: "02P" })
  .pick("KOPR", "PP01UD")
  .live({
    key: "KOPR",
    intervalMs: 1000,
    signature: { field: "updated_at" },
  });

watcher.on("change", event => {
  console.log("added", event.added);
  console.log("updated", event.updated);
  console.log("removed", event.removed);
});

watcher.on("error", event => {
  console.error(event.error);
});

watcher.start();
```

With `signature: { field: "updated_at" }`, the polling query uses
`COUNT_BIG(*)` and `MAX(updated_at)` instead of serializing the whole result.
That is much cheaper when the field is indexed and always moves forward. If
deletes do not matter, use `includeRowCount: false` to skip the count.

For the diff to work, the selected rows must include the key field. If no key is
provided, `live()` uses the table primary key. If the table has no reliable
change column, the default hash mode is still available, but SQL Server must
read the selected result to calculate it. For the lightest exact tracking, use
SQL Server Change Tracking, CDC, triggers, or a dedicated change table and pass a
custom `signature` function.

## Useful Pieces

- `Table`: base class for models. It gives you `query`, `where`, `create`,
  `update`, `delete`, and `exists`.
- `int`, `string`, `boolean`, `datetime`, `decimal`, `json`: small helpers to
  describe columns.
- `belongsTo` and `hasMany`: relation helpers used by `include`.
- `gt`, `contains`, `inList`, `isNull`: filter operators for `where`.
- `compile()`: returns readable SQL with parameter declarations, useful while
  checking what a query will run.
- `live()`: polls a query signature and emits row-level add/update/remove
  events when the result changes.
- `createSchemaSql` and `syncSchema`: generate or apply tables from your models.

## Build

```bash
bun run build
```

The package emits JavaScript and TypeScript declarations into `dist/`.
