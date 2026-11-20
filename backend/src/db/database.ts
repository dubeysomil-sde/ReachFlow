export interface DatabaseResult<T = unknown> {
  results: T[];
  success: boolean;
  meta?: { changes?: number };
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  run(): Promise<DatabaseResult>;
}

export interface Database {
  prepare(query: string): PreparedStatement;
  batch<T = unknown>(statements: PreparedStatement[]): Promise<DatabaseResult<T>[]>;
}

export async function first<T>(
  db: Database,
  query: string,
  ...values: unknown[]
): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

export async function all<T>(
  db: Database,
  query: string,
  ...values: unknown[]
): Promise<T[]> {
  const result = await db.prepare(query).bind(...values).all<T>();
  return result.results;
}

export async function run(
  db: Database,
  query: string,
  ...values: unknown[]
): Promise<number> {
  const result = await db.prepare(query).bind(...values).run();
  return result.meta?.changes ?? 0;
}
