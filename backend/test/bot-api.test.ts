import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ikcneszzs-bot-api-"));
const databasePath = path.join(temp, "db.sqlite3");
const sqlite = new DatabaseSync(databasePath);
sqlite.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE refresh_tokens (id TEXT PRIMARY KEY);
  CREATE TABLE generated_posts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    excerpt TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'published',
    cover_image TEXT NOT NULL DEFAULT '/covers/silk-road-ledger.svg', seo_title TEXT NOT NULL,
    seo_description TEXT NOT NULL, content_html TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE subscribers (id TEXT PRIMARY KEY);
  CREATE TABLE admin_settings (key TEXT PRIMARY KEY);
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY);
`);
sqlite.close();

process.env.DATABASE_PATH = databasePath;
process.env.UPLOAD_DIR = path.join(temp, "media");
process.env.BOT_INTEGRATION_TOKEN = "test-integration-token";
process.env.SITE_PUBLIC_URL = "https://ikcneszzs.example";

const [{ botRouter }, { initDb, closeDb }, { errorHandler }] = await Promise.all([
  import("../src/routes/bot.js"),
  import("../src/services/db.js"),
  import("../src/middleware/errorHandler.js")
]);
await initDb();

const app = express();
app.use(express.json());
app.use("/api/bot/v1", botRouter);
app.use(errorHandler);
const auth = { Authorization: "Bearer test-integration-token" };
const externalId = "a4fa2688-b3dd-4f8a-9509-f20209b15f9a";
const payload = {
  external_id: externalId,
  title: "Bot article",
  content: "First paragraph\n\nSecond paragraph",
  summary: "Summary",
  category_slugs: ["articles"],
  author_slug: null,
  tag_names: ["bot", "test"]
};

after(async () => {
  await closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects missing and invalid integration tokens", async () => {
  assert.equal((await request(app).get("/api/bot/v1/options/")).status, 403);
  assert.equal((await request(app).get("/api/bot/v1/options/").set("Authorization", "Bearer wrong")).status, 403);
  const token = process.env.BOT_INTEGRATION_TOKEN;
  process.env.BOT_INTEGRATION_TOKEN = "";
  assert.equal((await request(app).get("/api/bot/v1/options/").set(auth)).status, 403);
  process.env.BOT_INTEGRATION_TOKEN = token;
});

test("returns real site options", async () => {
  const response = await request(app).get("/api/bot/v1/options/").set(auth);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.categories, [{ slug: "articles", name: "Статьи" }]);
  assert.deepEqual(response.body.authors, []);
});

test("creates a draft idempotently and rejects a conflicting payload", async () => {
  const first = await request(app).post("/api/bot/v1/articles/").set(auth).send(payload);
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.status, "draft");
  assert.equal(first.body.image_url, null);
  const repeat = await request(app).post("/api/bot/v1/articles/").set(auth).send(payload);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.article_id, first.body.article_id);
  const conflict = await request(app).post("/api/bot/v1/articles/").set(auth).send({ ...payload, title: "Changed" });
  assert.equal(conflict.status, 409);
});

test("recovers the draft through GET and rejects fake images", async () => {
  const found = await request(app).get(`/api/bot/v1/articles/${externalId}/`).set(auth);
  assert.equal(found.status, 200);
  assert.equal(found.body.status, "draft");
  const fake = await request(app).put(`/api/bot/v1/articles/${externalId}/image/`).set(auth).attach("image", Buffer.from("not an image"), { filename: "fake.png", contentType: "image/png" });
  assert.equal(fake.status, 400);
});

test("stores one image, publishes once, and returns public URLs", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const image = await request(app).put(`/api/bot/v1/articles/${externalId}/image/`).set(auth).attach("image", png, { filename: "cover.png", contentType: "image/png" });
  assert.equal(image.status, 200);
  assert.match(image.body.image_url, /^https:\/\/ikcneszzs\.example\/uploads\/covers\//);
  const repeatImage = await request(app).put(`/api/bot/v1/articles/${externalId}/image/`).set(auth).attach("image", png, { filename: "again.png", contentType: "image/png" });
  assert.equal(repeatImage.body.image_url, image.body.image_url);

  const published = await request(app).post(`/api/bot/v1/articles/${externalId}/publish/`).set(auth);
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");
  assert.equal(published.body.url, "https://ikcneszzs.example/article/bot-article-a4fa2688");
  const repeated = await request(app).post(`/api/bot/v1/articles/${externalId}/publish/`).set(auth);
  assert.deepEqual(repeated.body, published.body);
  assert.equal((await request(app).put(`/api/bot/v1/articles/${externalId}/image/`).set(auth).attach("image", png, "late.png")).status, 409);
});
