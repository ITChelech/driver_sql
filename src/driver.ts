import { readFileSync } from "node:fs";
import type { CompiledSql, RecordShape, SqlDriver, TableStatic } from "./types.js";

let defaultDriver: SqlDriver | undefined;

export type MssqlConfig = {
  server: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  connectionTimeout?: number;
  requestTimeout?: number;
  options?: {
    connectTimeout?: number;
    encrypt?: boolean;
    requestTimeout?: number;
    trustServerCertificate?: boolean;
    useUTC?: boolean;
  };
};

type MssqlPool = {
  connect(): Promise<MssqlPool>;
  close?(): Promise<void>;
  request(): {
    input(name: string, value: unknown): void;
    query(sql: string): Promise<{
      recordset: unknown[];
      rowsAffected: number[];
    }>;
  };
};

/** Sets the driver used by table models that do not define their own driver. */
export function setDefaultDriver(driver: SqlDriver): void {
  defaultDriver = driver;
}

/** Returns the configured default driver, or throws if none was set. */
export function getDefaultDriver(): SqlDriver {
  if (!defaultDriver) {
    throw new Error("No SQL driver configured. Call setDefaultDriver(...) when the app starts.");
  }

  return defaultDriver;
}

/** Returns a table-specific driver when present, otherwise the default driver. */
export function getTableDriver<TRecord extends RecordShape>(table: TableStatic<TRecord, any>): SqlDriver {
  return table.driver?.() ?? getDefaultDriver();
}

/**
 * Executes already-compiled SQL and returns its first row, or null.
 *
 * Unlike Query.first(), this helper is for custom SQL that cannot be expressed
 * by the model query builder (for example CTEs, GROUP BY, or computed aliases).
 * It still uses the supplied SqlDriver, including read-only checks and retries.
 */
export async function queryFirst<TRecord extends RecordShape>(
  driver: SqlDriver,
  compiled: CompiledSql,
): Promise<TRecord | null> {
  try {
    const rows = await driver.query<TRecord>(compiled);
    return rows[0] ?? null;
  } catch (error) {
    const msg = `queryFirst failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${compiled.sql}\nPARAMS: ${JSON.stringify(compiled.params)}`;
    const wrapped = new Error(msg, { cause: error as Error });
    (wrapped as any).compiled = compiled;
    (wrapped as any).original = error;
    throw wrapped;
  }
}

/**
 * Same as queryFirst(), but throws the provided error when no row is returned.
 */
export async function queryRequired<TRecord extends RecordShape>(
  driver: SqlDriver,
  compiled: CompiledSql,
  message: string,
): Promise<TRecord> {
  const row = await queryFirst<TRecord>(driver, compiled).catch(error => {
    const msg = `queryRequired (fetch) failed: ${error instanceof Error ? error.message : String(error)}`;
    const wrapped = new Error(msg, { cause: error as Error });
    (wrapped as any).compiled = compiled;
    (wrapped as any).original = error;
    throw wrapped;
  });
  if (!row) throw new Error(message);
  return row;
}

/** SQL Server driver backed by the `mssql` package. */
export class MssqlDriver implements SqlDriver {
  private readonly config: MssqlConfig | null;
  private readonly providedPool: MssqlPool | null;
  private poolPromise: Promise<MssqlPool> | null = null;

  constructor(configOrPool: MssqlConfig | MssqlPool) {
    this.config = "request" in configOrPool ? null : configOrPool;
    this.providedPool = "request" in configOrPool ? configOrPool : null;
    this.poolPromise = this.providedPool ? Promise.resolve(this.providedPool) : null;
  }

  /** Runs a SELECT-style query and returns all rows. */
  async query<TRecord extends RecordShape>(compiled: CompiledSql): Promise<TRecord[]> {
    const result = await this.request(compiled);
    return result.recordset as TRecord[];
  }

  /** Runs a query and returns the first value from the first row. */
  async scalar<TValue = unknown>(compiled: CompiledSql): Promise<TValue | null> {
    const rows = await this.query<RecordShape>(compiled);
    const first = rows[0];

    if (!first) return null;

    const [value] = Object.values(first);
    return (value ?? null) as TValue | null;
  }

  /** Runs a write query and returns the total affected row count. */
  async execute(compiled: CompiledSql): Promise<number> {
    const result = await this.request(compiled);
    return result.rowsAffected.reduce((total: number, value: number) => total + value, 0);
  }

  /** Closes the underlying connection pool when one was opened by this driver. */
  async close(): Promise<void> {
    const current = this.poolPromise;
    this.poolPromise = null;
    const pool = await current?.catch(() => null);
    await pool?.close?.();
  }

  private async request(compiled: CompiledSql): Promise<{ recordset: unknown[]; rowsAffected: number[] }> {
    try {
      return await this.requestOnce(compiled);
    } catch (error) {
      if (!isTransientConnectionError(error) || !this.config) throw error;
      await this.resetPool();
      await sleep(500);
      return this.requestOnce(compiled);
    }
  }

  private async requestOnce(compiled: CompiledSql): Promise<{ recordset: unknown[]; rowsAffected: number[] }> {
    const pool = await this.getPool();
    const request = pool.request();

    compiled.params.forEach((value, index) => {
      request.input(`p${index + 1}`, value);
    });

    try {
      return await request.query(compiled.sql);
    } catch (error) {
      const msg = `SQL request failed: ${error instanceof Error ? error.message : String(error)}\n` +
        `SQL: ${compiled.sql}\nPARAMS: ${JSON.stringify(compiled.params)}`;
      const wrapped = new Error(msg, { cause: error as Error });
      // Attach compiled info for programmatic inspection
      (wrapped as any).compiled = compiled;
      (wrapped as any).original = error;
      throw wrapped;
    }
  }

  private getPool(): Promise<MssqlPool> {
    if (!this.poolPromise) {
      if (!this.config) throw new Error("No SQL pool configured");
      this.poolPromise = import("mssql").then(({ default: mssql }) => {
        const ConnectionPool = mssql.ConnectionPool as new (config: MssqlConfig) => MssqlPool;
        return new ConnectionPool(this.config as MssqlConfig).connect();
      });
    }

    return this.poolPromise;
  }

  private async resetPool() {
    const current = this.poolPromise;
    this.poolPromise = null;
    const pool = await current?.catch(() => null);
    await pool?.close?.().catch(() => {});
  }
}

/** Wraps another driver and only allows SELECT or WITH queries. */
export class ReadOnlySqlDriver implements SqlDriver {
  constructor(private readonly driver: SqlDriver, private readonly name = "SQL") {}

  /** Runs a read-only query. */
  query<TRecord extends RecordShape>(compiled: CompiledSql): Promise<TRecord[]> {
    assertReadOnlyQuery(compiled, this.name);
    return this.driver.query<TRecord>(compiled);
  }

  /** Runs a read-only query and returns the first value from the first row. */
  scalar<TValue = unknown>(compiled: CompiledSql): Promise<TValue | null> {
    assertReadOnlyQuery(compiled, this.name);
    return this.driver.scalar<TValue>(compiled);
  }

  /** Always rejects because this wrapper is read-only. */
  execute(_compiled: CompiledSql): Promise<number> {
    return Promise.reject(new Error(`${this.name} driver is read-only`));
  }

  /** Closes the wrapped driver when it supports closing. */
  async close(): Promise<void> {
    await this.driver.close?.();
  }
}

/** Creates an MssqlDriver from MSSQL_* environment variables. */
export function createMssqlDriverFromEnv(env: Record<string, string | undefined> = process.env): MssqlDriver {
  const password = env.MSSQL_PSS ?? env.MSSQL_PASSWORD ?? readSecretFile(env.MSSQL_PSS_FILE ?? env.MSSQL_PASSWORD_FILE);
  const connectionTimeout = env.MSSQL_CONNECTION_TIMEOUT ? Number(env.MSSQL_CONNECTION_TIMEOUT) : 30_000;
  const requestTimeout = env.MSSQL_REQUEST_TIMEOUT ? Number(env.MSSQL_REQUEST_TIMEOUT) : 60_000;

  return new MssqlDriver({
    server: required(env.MSSQL_HOST, "MSSQL_HOST"),
    port: env.MSSQL_PORT ? Number(env.MSSQL_PORT) : 1433,
    user: required(env.MSSQL_USER, "MSSQL_USER"),
    password: required(password, "MSSQL_PSS"),
    database: required(env.MSSQL_DB, "MSSQL_DB"),
    connectionTimeout,
    requestTimeout,
    options: {
      connectTimeout: connectionTimeout,
      encrypt: env.MSSQL_ENCRYPT === "true",
      requestTimeout,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE !== "false",
      useUTC: true,
    },
  });
}

/** Creates a read-only SQL Server driver from CHELECH_* environment variables. */
export function createRandomMssqlDriverFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReadOnlySqlDriver {
  return new ReadOnlySqlDriver(
    new MssqlDriver(createRandomMssqlConfigFromEnv(env)),
    "Random MSSQL",
  );
}

/** Reads CHELECH_* environment variables into a SQL Server config object. */
export function createRandomMssqlConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MssqlConfig {
  const connectionTimeout = optionalPositiveNumber(
    env.CHELECH_CONNECTION_TIMEOUT,
    "CHELECH_CONNECTION_TIMEOUT",
    30_000,
  );
  const requestTimeout = optionalPositiveNumber(
    env.CHELECH_REQUEST_TIMEOUT,
    "CHELECH_REQUEST_TIMEOUT",
    60_000,
  );

  return {
    server: required(env.CHELECH_SERVER, "CHELECH_SERVER"),
    port: optionalPositiveNumber(env.CHELECH_PORT, "CHELECH_PORT", 1433),
    user: required(env.CHELECH_USER, "CHELECH_USER"),
    password: required(
      env.CHELECH_PASSWORD ?? readSecretFile(env.CHELECH_PASSWORD_FILE),
      "CHELECH_PASSWORD",
    ),
    database: required(env.CHELECH_DATABASE, "CHELECH_DATABASE"),
    connectionTimeout,
    requestTimeout,
    options: {
      connectTimeout: connectionTimeout,
      encrypt: env.CHELECH_ENCRYPT === "true",
      requestTimeout,
      trustServerCertificate: env.CHELECH_TRUST_SERVER_CERTIFICATE !== "false",
      useUTC: true,
    },
  };
}

/** Creates the configured SQL Server database if it does not exist yet. */
export async function ensureMssqlDatabaseExists(config: MssqlConfig): Promise<void> {
  const { default: mssql } = await import("mssql");
  const ConnectionPool = mssql.ConnectionPool as new (config: MssqlConfig) => MssqlPool;
  const adminPool = await new ConnectionPool({
    ...config,
    database: "master",
  }).connect();

  try {
    const request = adminPool.request();
    request.input("p1", config.database);
    await request.query(`
      IF DB_ID(@p1) IS NULL
      BEGIN
        DECLARE @sql NVARCHAR(MAX) = N'CREATE DATABASE ' + QUOTENAME(@p1);
        EXEC(@sql);
      END
    `);
  } finally {
    await adminPool.close?.();
  }
}

/** Reads MSSQL_* environment variables into a SQL Server config object. */
export function createMssqlConfigFromEnv(env: Record<string, string | undefined> = process.env): MssqlConfig {
  const password = env.MSSQL_PSS ?? env.MSSQL_PASSWORD ?? readSecretFile(env.MSSQL_PSS_FILE ?? env.MSSQL_PASSWORD_FILE);
  const connectionTimeout = env.MSSQL_CONNECTION_TIMEOUT ? Number(env.MSSQL_CONNECTION_TIMEOUT) : 30_000;
  const requestTimeout = env.MSSQL_REQUEST_TIMEOUT ? Number(env.MSSQL_REQUEST_TIMEOUT) : 60_000;

  return {
    server: required(env.MSSQL_HOST, "MSSQL_HOST"),
    port: env.MSSQL_PORT ? Number(env.MSSQL_PORT) : 1433,
    user: required(env.MSSQL_USER, "MSSQL_USER"),
    password: required(password, "MSSQL_PSS"),
    database: required(env.MSSQL_DB, "MSSQL_DB"),
    connectionTimeout,
    requestTimeout,
    options: {
      connectTimeout: connectionTimeout,
      encrypt: env.MSSQL_ENCRYPT === "true",
      requestTimeout,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE !== "false",
      useUTC: true,
    },
  };
}

/** Creates the database from MSSQL_* env vars and returns the config used. */
export async function ensureMssqlDatabaseExistsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<MssqlConfig> {
  const config = createMssqlConfigFromEnv(env);
  await ensureMssqlDatabaseExists(config);
  return config;
}

function readSecretFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return readFileSync(path, "utf8").trim();
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }

  return value;
}

function optionalPositiveNumber(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }

  return number;
}

function assertReadOnlyQuery(compiled: CompiledSql, name: string): void {
  const sql = compiled.sql.trimStart();
  if (!/^(SELECT|WITH)\b/i.test(sql)) {
    throw new Error(`${name} driver only accepts SELECT queries`);
  }

  const normalized = sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\[(?:]]|[^\]])*]/g, "[]")
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutTrailingTerminator = normalized.replace(/;\s*$/, "");

  if (
    withoutTrailingTerminator.includes(";") ||
    /\b(?:ALTER|CREATE|DELETE|DENY|DROP|EXEC(?:UTE)?|GRANT|INSERT|MERGE|REVOKE|TRUNCATE|UPDATE)\b/i.test(
      withoutTrailingTerminator,
    ) ||
    /^SELECT\b[\s\S]*\bINTO\b/i.test(withoutTrailingTerminator)
  ) {
    throw new Error(`${name} driver only accepts SELECT queries`);
  }
}

function isTransientConnectionError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  return (
    code === "ETIMEOUT" ||
    code === "ESOCKET" ||
    code === "ECONNCLOSED" ||
    /failed to connect|timeout|connection is closed|socket|cancelled/i.test(message)
  );
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
