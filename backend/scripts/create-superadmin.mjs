import bcrypt from "bcrypt";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const { Pool } = pg;
if (process.env.DATABASE_PATH && !existsSync(process.env.DATABASE_PATH)) throw new Error("Migrated SQLite database is missing");
const sqlite = process.env.DATABASE_PATH ? new DatabaseSync(process.env.DATABASE_PATH) : null;
const pool = sqlite ? null : new Pool({ connectionString: process.env.DATABASE_URL });

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
  process.exit(1);
}

if (!sqlite) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'superadmin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `);
}
const passwordHash = await bcrypt.hash(password, 12);
if (sqlite) {
  sqlite.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?,?,'superadmin')
    ON CONFLICT (email) DO UPDATE SET password_hash=excluded.password_hash`).run(email.toLowerCase(), passwordHash);
  sqlite.close();
} else {
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'superadmin')
   ON CONFLICT (email) DO UPDATE SET password_hash=$2`,
    [email.toLowerCase(), passwordHash]
  );
  await pool.end();
}
console.log(`Superadmin ready: ${email}`);
