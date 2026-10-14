import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const secret = () => crypto.randomBytes(64).toString("base64url");

function writeIfMissing(file, content) {
  const target = path.join(root, file);
  if (fs.existsSync(target)) {
    console.log(`${file} already exists; leaving it unchanged.`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  console.log(`${file} created.`);
}

const postgresPassword = secret();
const redisPassword = secret();
const adminPassword = secret().slice(0, 32);

writeIfMissing(
  ".env.production",
  `POSTGRES_DB=ikcneszzs
POSTGRES_USER=ikcneszzs
POSTGRES_PASSWORD=${postgresPassword}
REDIS_PASSWORD=${redisPassword}
LOCAL_SUPERADMIN_EMAIL=admin@ikcneszzs.xyz
LOCAL_SUPERADMIN_PASSWORD=${adminPassword}
OPENROUTER_API_KEY=
VITE_API_URL=https://api.ikcneszzs.xyz/api
`
);

writeIfMissing(
  "backend/.env.production",
  `NODE_ENV=production
PORT=4000
DATABASE_PATH=/workspace/db.sqlite3
UPLOAD_DIR=/workspace/media
REDIS_URL=redis://:${redisPassword}@redis:6379
CORS_ORIGIN=https://ikcneszzs.xyz
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_DAYS=30
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
ADMIN_EMAIL=admin@ikcneszzs.xyz
ADMIN_PASSWORD=${adminPassword}
JWT_SECRET=${secret()}
REFRESH_TOKEN_SECRET=${secret()}
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct
OPENROUTER_API_KEY=
`
);

writeIfMissing("frontend/.env.production", "VITE_API_URL=https://api.ikcneszzs.xyz/api\n");

console.log("");
console.log("Production env files are ready. Add OPENROUTER_API_KEY before real AI generation.");
