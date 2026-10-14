import pg, { type QueryResultRow } from "pg";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { defaultMasterPrompt, samplePosts } from "../data/samplePosts.js";

const { Pool } = pg;

if (process.env.DATABASE_PATH && !existsSync(process.env.DATABASE_PATH)) throw new Error("Migrated SQLite database is missing");
const sqlite = process.env.DATABASE_PATH ? new DatabaseSync(process.env.DATABASE_PATH) : null;
export const pool = sqlite ? null : new Pool({ connectionString: process.env.DATABASE_URL });
if (sqlite) {
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE");
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!sqlite) return pool!.query<T>(text, params);
  const values: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_, index: string) => {
    const value = params[Number(index) - 1];
    values.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
    return "?";
  });
  const statement = sqlite.prepare(sql);
  if (statement.columns().length === 0) {
    statement.run(...values as any[]);
    return { rows: [] };
  }
  const rows = statement.all(...values as any[]).map((record: any) => {
    for (const key of ["tags", "value", "meta"]) {
      if (typeof record[key] === "string") record[key] = JSON.parse(record[key]);
    }
    return record as T;
  });
  return { rows };
}

export async function initDb() {
  if (sqlite) {
    if ((sqlite.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    for (const name of ["users", "refresh_tokens", "generated_posts", "subscribers", "admin_settings", "audit_logs"]) {
      if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error(`SQLite table missing: ${name}`);
    }
    return;
  }
  await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'superadmin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS generated_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      excerpt TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'published',
      cover_image TEXT NOT NULL DEFAULT '/covers/silk-road-ledger.svg',
      seo_title TEXT NOT NULL,
      seo_description TEXT NOT NULL,
      content_html TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS subscribers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      action TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query("ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'");
  await query("ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS cover_image TEXT NOT NULL DEFAULT '/covers/silk-road-ledger.svg'");

  const postsCount = await query<{ count: string }>("SELECT count(*) FROM generated_posts");
  if (Number(postsCount.rows[0].count) === 0) {
    for (const post of samplePosts) {
      await query(
        `INSERT INTO generated_posts (title, slug, excerpt, tags, status, cover_image, seo_title, seo_description, content_html)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (slug) DO NOTHING`,
        [
          post.title,
          post.slug,
          post.excerpt,
          post.tags,
          post.status,
          post.coverImage,
          post.seoTitle,
          post.seoDescription,
          post.contentHtml
        ]
      );
    }
  }

  await query(
    `INSERT INTO admin_settings (key, value) VALUES
      ('masterPrompt', $1),
      ('generationEnabled', 'false'),
      ('generationFrequencyCount', '1'),
      ('generationFrequencyPeriod', '"day"'),
      ('generationTimes', '["09:00"]')
    ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(defaultMasterPrompt)]
  );
}
