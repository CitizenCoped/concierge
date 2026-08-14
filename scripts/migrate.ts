import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "@neondatabase/serverless";
import { loadEnv } from "./env";

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query(
      `create table if not exists _migrations (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`
    );
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const { rows } = await client.query("select filename from _migrations");
    const applied = new Set(rows.map((r) => r.filename as string));
    let ran = 0;
    for (const f of files) {
      if (applied.has(f)) continue;
      console.log(`applying ${f}…`);
      const sqlText = readFileSync(join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sqlText);
        await client.query("insert into _migrations (filename) values ($1)", [f]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
      ran++;
    }
    console.log(ran === 0 ? "nothing to do" : `applied ${ran} migration(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
