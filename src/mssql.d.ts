declare module "mssql" {
  const mssql: {
    ConnectionPool: new (config: unknown) => {
      connect(): Promise<{
        close?(): Promise<void>;
        request(): {
          input(name: string, value: unknown): void;
          query(sql: string): Promise<{
            recordset: unknown[];
            rowsAffected: number[];
          }>;
        };
      }>;
    };
  };

  export default mssql;
}
