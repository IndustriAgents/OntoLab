import "../server/env.ts";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { postgresConnectionString } from "../server/store/connection.ts";

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED is required for migrations. Use make db-migrate for local Postgres.");
if (new URL(connectionString).hostname.includes("-pooler"))
  throw new Error("Migrations require the direct DATABASE_URL_UNPOOLED connection.");
const pool = new Pool({
  connectionString: postgresConnectionString(connectionString),
  max: 1,
  connectionTimeoutMillis: 15_000,
  statement_timeout: 120_000,
  application_name: "ontolab-migrations",
});
const db = await pool.connect();
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext('ontolab-migrations'))");
  await db.query("create schema if not exists ontolab");
  await db.query(
    "create table if not exists ontolab.schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())",
  );
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
    const sql = await readFile(new URL(name, dir), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const old = (await db.query<{ checksum: string }>("select checksum from ontolab.schema_migrations where name=$1", [name])).rows[0];
    if (old) {
      if (old.checksum !== checksum) throw new Error(`Applied migration ${name} was changed. Add a new migration instead.`);
      console.info(`Already applied: ${name}`);
      continue;
    }
    await db.query(sql);
    await db.query("insert into ontolab.schema_migrations(name,checksum) values($1,$2)", [name, checksum]);
    console.info(`Applied: ${name}`);
  }
  await db.query("commit");
  console.info("Database migrations complete.");
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  db.release();
  await pool.end();
}
