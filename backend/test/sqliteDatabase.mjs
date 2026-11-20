import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

class SQLitePreparedStatement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new SQLitePreparedStatement(this.database, this.query, values);
  }

  async first(columnName) {
    const row = this.database.prepare(this.query).get(...this.values) ?? null;
    return columnName && row ? (row[columnName] ?? null) : row;
  }

  async all() {
    return {
      results: this.database.prepare(this.query).all(...this.values),
      success: true,
    };
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SQLiteDatabaseAdapter {
  constructor(database = new DatabaseSync(':memory:')) {
    this.database = database;
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  static async createWithMigrations() {
    const adapter = new SQLiteDatabaseAdapter();
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      adapter.database.exec(await readFile(new URL(file, directory), 'utf8'));
    }
    return adapter;
  }

  prepare(query) {
    return new SQLitePreparedStatement(this.database, query);
  }

  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) {
        const result = this.database.prepare(statement.query).run(...statement.values);
        results.push({ success: true, meta: { changes: Number(result.changes) } });
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
