import type { Database, DatabaseResult, PreparedStatement } from './database.ts';

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  run(): Promise<DatabaseResult>;
}

export interface D1Binding {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<DatabaseResult<T>[]>;
}

class D1PreparedStatement implements PreparedStatement {
  private readonly statement: D1Statement;

  constructor(statement: D1Statement) {
    this.statement = statement;
  }

  bind(...values: unknown[]): PreparedStatement {
    return new D1PreparedStatement(this.statement.bind(...values));
  }

  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    return this.statement.first<T>(columnName);
  }

  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return this.statement.all<T>();
  }

  run(): Promise<DatabaseResult> {
    return this.statement.run();
  }

  unwrap(): D1Statement {
    return this.statement;
  }
}

export class D1DatabaseAdapter implements Database {
  private readonly binding: D1Binding;

  constructor(binding: D1Binding) {
    this.binding = binding;
  }

  prepare(query: string): PreparedStatement {
    return new D1PreparedStatement(this.binding.prepare(query));
  }

  batch<T = unknown>(statements: PreparedStatement[]): Promise<DatabaseResult<T>[]> {
    const d1Statements = statements.map((statement) => {
      if (!(statement instanceof D1PreparedStatement)) {
        throw new Error('D1 batch statements must be created by this adapter');
      }
      return statement.unwrap();
    });
    return this.binding.batch<T>(d1Statements);
  }
}
