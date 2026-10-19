import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export type MediaAsset = {
  name: string;
  url: string;
  size: number;
  createdAt: string;
};

const uploadRoot = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
const coversDir = path.join(uploadRoot, "covers");
const publicPrefix = "/uploads/covers";
const maxUploadBytes = 10 * 1024 * 1024;
const allowedTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg"
};

const botAllowedTypes: Record<string, { extension: string; matches: (buffer: Buffer) => boolean }> = {
  "image/jpeg": { extension: "jpg", matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  "image/png": { extension: "png", matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: "webp", matches: (buffer) => buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" }
};

function slugifyName(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "cover";
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image payload");
  const mimeType = match[1];
  const extension = allowedTypes[mimeType];
  if (!extension) throw new Error("Only JPG, PNG, WEBP, and SVG images are allowed");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("Image is empty");
  if (buffer.length > maxUploadBytes) throw new Error("Image is larger than 10MB");
  return { buffer, extension };
}

async function ensureCoversDir() {
  await fs.mkdir(coversDir, { recursive: true });
}

export async function listCoverImages(): Promise<MediaAsset[]> {
  await ensureCoversDir();
  const entries = await fs.readdir(coversDir, { withFileTypes: true });
  const assets = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stat = await fs.stat(path.join(coversDir, entry.name));
        return {
          name: entry.name,
          url: publicPrefix + "/" + entry.name,
          size: stat.size,
          createdAt: stat.birthtime.toISOString()
        };
      })
  );
  return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveCoverImage(input: { fileName?: string; dataUrl?: string }): Promise<MediaAsset> {
  await ensureCoversDir();
  const { buffer, extension } = parseDataUrl(String(input.dataUrl ?? ""));
  const baseName = slugifyName(String(input.fileName ?? "cover"));
  const name = baseName + "-" + crypto.randomUUID().slice(0, 8) + "." + extension;
  const filePath = path.join(coversDir, name);
  await fs.writeFile(filePath, buffer, { flag: "wx" });
  const stat = await fs.stat(filePath);
  return { name, url: publicPrefix + "/" + name, size: stat.size, createdAt: stat.birthtime.toISOString() };
}

export async function deleteCoverImage(name: string) {
  const safeName = path.basename(name);
  await fs.rm(path.join(coversDir, safeName), { force: true });
}

export async function saveBotCoverImage(externalId: string, mimeType: string, buffer: Buffer) {
  if (!buffer.length) throw new Error("Image is empty");
  if (buffer.length > maxUploadBytes) throw new Error("Image is larger than 10MB");
  const type = botAllowedTypes[mimeType];
  if (!type || !type.matches(buffer)) throw new Error("Only valid JPG, PNG, and WebP images are allowed");
  await ensureCoversDir();
  const name = `bot-${externalId}.${type.extension}`;
  const filePath = path.join(coversDir, name);
  try {
    await fs.writeFile(filePath, buffer, { flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  return { filePath, url: `${publicPrefix}/${name}` };
}

export async function pickRandomCoverImage(): Promise<string | null> {
  const covers = await listCoverImages();
  if (!covers.length) return null;
  return covers[Math.floor(Math.random() * covers.length)].url;
}
