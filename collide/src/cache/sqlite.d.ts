declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
}
