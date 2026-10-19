import crypto from "node:crypto";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sanitizeHtml } from "../services/htmlSanitizer.js";
import { query } from "../services/db.js";
import { saveBotCoverImage } from "../services/mediaStore.js";

const SITE_ID = "ikcneszzs";
const CATEGORY = { slug: "articles", name: "Статьи" };
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 10 * 1024 * 1024 } });

const articleSchema = z.object({
  external_id: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1),
  summary: z.string().max(1000).optional().default(""),
  category_slugs: z.array(z.string()).min(1).refine((items) => items.every((item) => item === CATEGORY.slug), "Unknown category"),
  author_slug: z.null().optional().default(null),
  tag_names: z.array(z.string().trim().min(1).max(80)).max(10).optional().default([])
}).strict();

type BotPostRow = {
  id: string;
  slug: string;
  status: "draft" | "published";
  cover_image: string;
  bot_payload_hash: string;
  bot_image_hash: string | null;
};

function publicBase() {
  return (process.env.SITE_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
}

function result(row: BotPostRow) {
  const base = publicBase();
  const cover = !row.bot_image_hash ? null : row.cover_image.startsWith("/") ? `${base}${row.cover_image}` : row.cover_image;
  return { article_id: String(row.id), status: row.status, url: `${base}/article/${encodeURIComponent(row.slug)}`, image_url: cover };
}

function stableHash(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function slugify(title: string, externalId: string) {
  const base = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 70) || "article";
  return `${base}-${externalId.slice(0, 8)}`;
}

function contentHtml(content: string) {
  if (/<[a-z][\s\S]*>/i.test(content)) return sanitizeHtml(content);
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return escaped.split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`).join("");
}

const authenticate: RequestHandler = (req, res, next) => {
  const configured = Buffer.from(process.env.BOT_INTEGRATION_TOKEN || "");
  const supplied = Buffer.from(req.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
  if (!configured.length || configured.length !== supplied.length || !crypto.timingSafeEqual(configured, supplied)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
};

async function findArticle(externalId: string) {
  const found = await query<BotPostRow>("SELECT id, slug, status, cover_image, bot_payload_hash, bot_image_hash FROM generated_posts WHERE bot_external_id=$1", [externalId]);
  return found.rows[0] ?? null;
}

export const botRouter = Router();
botRouter.use(authenticate);

botRouter.get("/options/", (_req, res) => {
  res.json({ version: 1, site: SITE_ID, categories: [CATEGORY], authors: [] });
});

botRouter.post("/articles/", asyncHandler(async (req, res) => {
  const parsed = articleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid article payload", details: parsed.error.flatten() });
  const input = parsed.data;
  const payloadHash = stableHash(input);
  const slug = slugify(input.title, input.external_id);
  const inserted = await query<BotPostRow>(
    `INSERT INTO generated_posts
      (title, slug, excerpt, tags, status, cover_image, seo_title, seo_description, content_html, bot_external_id, bot_payload_hash)
     VALUES ($1,$2,$3,$4,'draft','/covers/silk-road-ledger.svg',$5,$6,$7,$8,$9)
     ON CONFLICT (bot_external_id) WHERE bot_external_id IS NOT NULL DO NOTHING
     RETURNING id, slug, status, cover_image, bot_payload_hash, bot_image_hash`,
    [input.title, slug, input.summary, input.tag_names, input.title, input.summary, contentHtml(input.content), input.external_id, payloadHash]
  );
  const article = inserted.rows[0] ?? await findArticle(input.external_id);
  if (!article) throw new Error("Article could not be created");
  if (article.bot_payload_hash !== payloadHash) return res.status(409).json({ error: "external_id already exists with a different payload" });
  res.status(inserted.rows[0] ? 201 : 200).json(result(article));
}));

botRouter.get("/articles/:externalId/", asyncHandler(async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.externalId);
  if (!parsed.success) return res.status(404).json({ error: "Article not found" });
  const article = await findArticle(parsed.data);
  if (!article) return res.status(404).json({ error: "Article not found" });
  res.json(result(article));
}));

botRouter.put("/articles/:externalId/image/", upload.single("image"), asyncHandler(async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.externalId);
  if (!parsed.success) return res.status(404).json({ error: "Article not found" });
  let article = await findArticle(parsed.data);
  if (!article) return res.status(404).json({ error: "Article not found" });
  if (article.status !== "draft") return res.status(409).json({ error: "Published articles cannot be changed" });
  if (article.bot_image_hash) return res.json(result(article));
  if (!req.file) return res.status(400).json({ error: "Image is required" });
  const hash = stableHash(req.file.buffer.toString("base64"));
  const saved = await saveBotCoverImage(parsed.data, req.file.mimetype, req.file.buffer);
  await query(
    "UPDATE generated_posts SET cover_image=$1, bot_image_hash=$2, updated_at=$3 WHERE bot_external_id=$4 AND status='draft' AND bot_image_hash IS NULL",
    [saved.url, hash, new Date().toISOString(), parsed.data]
  );
  article = await findArticle(parsed.data);
  if (!article) throw new Error("Article disappeared during image upload");
  res.json(result(article));
}));

botRouter.post("/articles/:externalId/publish/", asyncHandler(async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.externalId);
  if (!parsed.success) return res.status(404).json({ error: "Article not found" });
  let article = await findArticle(parsed.data);
  if (!article) return res.status(404).json({ error: "Article not found" });
  if (article.status === "published") return res.json(result(article));
  await query(
    "UPDATE generated_posts SET status='published', published_at=$1, updated_at=$1 WHERE bot_external_id=$2 AND status='draft'",
    [new Date().toISOString(), parsed.data]
  );
  article = await findArticle(parsed.data);
  if (!article || article.status !== "published") return res.status(409).json({ error: "Article cannot be published" });
  res.json(result(article));
}));
