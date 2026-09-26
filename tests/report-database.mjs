import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function databaseFixture() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of fs.readdirSync(directory).filter((n) => n.endsWith(".sql")).sort()) sqlite.exec(fs.readFileSync(new URL(name, directory), "utf8"));
  const db = {
    sqlite,
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return db;
}
