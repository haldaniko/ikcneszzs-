import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, ".env");
const sample = path.join(root, ".env.sample");
const secret = () => crypto.randomBytes(64).toString("base64url");

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator >= 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

const values = parse(fs.readFileSync(sample, "utf8"));
const preferLegacy = process.argv.includes("--prefer-legacy");
const legacyFiles = [
  "backend/.env",
  "frontend/.env",
  ".env.production",
  "backend/.env.production",
  "frontend/.env.production"
];

const mergeFile = (file) => {
  if (!fs.existsSync(file)) return;
  for (const [key, value] of parse(fs.readFileSync(file, "utf8"))) values.set(key, value);
};
if (preferLegacy) mergeFile(target);
for (const file of legacyFiles) mergeFile(path.join(root, file));
if (!preferLegacy) mergeFile(target);
for (const key of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "JWT_SECRET", "REFRESH_TOKEN_SECRET", "BOT_INTEGRATION_TOKEN"]) {
  if (!values.get(key) || values.get(key).includes("replace-with")) values.set(key, secret());
}
if (!values.get("LOCAL_SUPERADMIN_PASSWORD") || values.get("LOCAL_SUPERADMIN_PASSWORD").includes("replace-with")) {
  values.set("LOCAL_SUPERADMIN_PASSWORD", secret().slice(0, 32));
}
if (!values.get("ADMIN_PASSWORD") || values.get("ADMIN_PASSWORD").includes("replace-with")) {
  values.set("ADMIN_PASSWORD", values.get("LOCAL_SUPERADMIN_PASSWORD"));
}
values.set("DATABASE_URL", `postgres://${encodeURIComponent(values.get("POSTGRES_USER"))}:${encodeURIComponent(values.get("POSTGRES_PASSWORD"))}@postgres:5432/${encodeURIComponent(values.get("POSTGRES_DB"))}`);
values.set("REDIS_URL", `redis://:${encodeURIComponent(values.get("REDIS_PASSWORD"))}@redis:6379`);
fs.writeFileSync(target, `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
console.log("Ready: .env (existing values preserved; missing secrets generated)");

for (const file of legacyFiles) {
  const legacyPath = path.join(root, file);
  if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath);
}

const botEnvPath = path.resolve(root, "..", "tg-posting-integration", ".env");
if (fs.existsSync(botEnvPath)) {
  const botValues = parse(fs.readFileSync(botEnvPath, "utf8"));
  let sites;
  try {
    sites = JSON.parse(botValues.get("SITES_JSON") || "[]");
    if (!Array.isArray(sites)) throw new Error("SITES_JSON is not an array");
  } catch (error) {
    throw new Error(`Cannot update bot .env: ${error instanceof Error ? error.message : String(error)}`);
  }
  const site = {
    id: "ikcneszzs",
    name: "ikcneszzs.xyz",
    api_base: "https://api.ikcneszzs.xyz/api/bot/v1/",
    token_env: "IKCNESZZS_INTEGRATION_TOKEN"
  };
  const existingIndex = sites.findIndex((entry) => entry?.id === site.id);
  if (existingIndex >= 0) sites[existingIndex] = site;
  else sites.push(site);
  botValues.set("SITES_JSON", JSON.stringify(sites));
  botValues.set(site.token_env, values.get("BOT_INTEGRATION_TOKEN"));
  fs.writeFileSync(botEnvPath, `${[...botValues].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  console.log("Ready: Telegram bot .env (site registered; token synchronized)");
} else {
  console.warn(`Telegram bot .env was not found at ${botEnvPath}; site .env is ready, but bot registration was skipped.`);
}
