export interface TestD1 {
  raw: { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): any; all(...args: unknown[]): any[] }; exec(sql: string): void };
  prepare(sql: string): any;
  batch(stmts: any[]): Promise<unknown[]>;
  exec(sql: string): Promise<void>;
}
export declare function testD1(): TestD1;
