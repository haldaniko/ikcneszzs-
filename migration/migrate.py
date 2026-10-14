"""One-time, verified PostgreSQL and upload-volume cutover to host files."""
import datetime as dt
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import sys
import urllib.parse
import uuid

import psycopg
from psycopg.rows import dict_row

ROOT = Path("/workspace")
DB = ROOT / "db.sqlite3"
MEDIA = ROOT / "media"
OLD_MEDIA = Path("/legacy-uploads")
TABLES = {
    "users": ["id", "email", "password_hash", "role", "created_at"],
    "refresh_tokens": ["id", "user_id", "token_hash", "csrf_token", "expires_at", "revoked_at"],
    "generated_posts": ["id", "title", "slug", "excerpt", "tags", "status", "cover_image", "seo_title", "seo_description", "content_html", "published_at", "updated_at"],
    "subscribers": ["id", "email", "created_at"],
    "admin_settings": ["key", "value"],
    "audit_logs": ["id", "user_id", "action", "meta", "created_at"],
}
SCHEMA = """
CREATE TABLE users (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'superadmin', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE refresh_tokens (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE generated_posts (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
 excerpt TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), status TEXT NOT NULL DEFAULT 'published',
 cover_image TEXT NOT NULL DEFAULT '/covers/silk-road-ledger.svg', seo_title TEXT NOT NULL, seo_description TEXT NOT NULL,
 content_html TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE subscribers (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), email TEXT UNIQUE NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)));
CREATE TABLE audit_logs (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT,
 action TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_token_hash_idx ON refresh_tokens(token_hash);
CREATE INDEX generated_posts_published_at_idx ON generated_posts(published_at DESC);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
"""


def docker_api(method, path):
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect("/var/run/docker.sock")

    client = UnixConnection("docker")
    client.request(method, path)
    response = client.getresponse()
    body = response.read()
    code = response.status
    client.close()
    if code >= 300:
        raise RuntimeError(f"Docker API {path} failed: {code} {body[:300]!r}")
    return json.loads(body) if body and method == "GET" else None


def stop_old_backend():
    me = docker_api("GET", f"/containers/{socket.gethostname()}/json")
    project = me["Config"]["Labels"]["com.docker.compose.project"]
    filters = urllib.parse.quote(json.dumps({"label": [f"com.docker.compose.project={project}", "com.docker.compose.service=backend"]}))
    for container in docker_api("GET", f"/containers/json?filters={filters}"):
        if container["State"] == "running":
            print(f"Stopping old backend {container['Id'][:12]} for consistent cutover", flush=True)
            docker_api("POST", f"/containers/{container['Id']}/stop?t=30")


def check_db(path):
    if path.is_symlink():
        raise RuntimeError(f"SQLite path must be a regular host file: {path}")
    with sqlite3.connect(path) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"Invalid SQLite database: {path}")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError(f"Broken SQLite foreign keys: {path}")
        for table in TABLES:
            columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            if not set(TABLES[table]).issubset(columns):
                raise RuntimeError(f"Missing SQLite columns in {table}")
        for (url,) in db.execute("SELECT cover_image FROM generated_posts WHERE cover_image LIKE '/uploads/%' OR cover_image LIKE '/api/uploads/%'"):
            relative = Path(urllib.parse.unquote(url.removeprefix("/api").removeprefix("/uploads/")))
            if relative.is_absolute() or ".." in relative.parts or not (MEDIA / relative).is_file():
                raise RuntimeError(f"Uploaded cover missing: {url}")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.digest()


def copy_media():
    if MEDIA.is_symlink():
        raise RuntimeError("Host media path must be a directory, not a symlink")
    MEDIA.mkdir(exist_ok=True)
    for source in OLD_MEDIA.rglob("*"):
        if source.is_symlink():
            raise RuntimeError(f"Symlink in old uploads: {source}")
        target = MEDIA / source.relative_to(OLD_MEDIA)
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if not target.is_file() or source.stat().st_size != target.stat().st_size or digest(source) != digest(target):
                raise RuntimeError(f"Media conflict (left untouched): {target}")
            continue
        temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            shutil.copy2(source, temp)
            if source.stat().st_size != temp.stat().st_size or digest(source) != digest(temp):
                raise RuntimeError(f"Media copy mismatch: {source}")
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)


def convert(value, is_json=False):
    if is_json or isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def migrate():
    if DB.is_symlink():
        raise RuntimeError("db.sqlite3 must be a regular host file, not a symlink")
    if DB.exists():
        check_db(DB)
        print("Existing valid db.sqlite3 retained; PostgreSQL was not imported again", flush=True)
        return
    with psycopg.connect(host="postgres", dbname=os.environ["POSTGRES_DB"], user=os.environ["POSTGRES_USER"], password=os.environ["POSTGRES_PASSWORD"]) as preflight:
        present = {row[0] for row in preflight.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")}
        if present != set(TABLES):
            raise RuntimeError(f"Source volume has unexpected application tables; missing={sorted(set(TABLES)-present)}, extra={sorted(present-set(TABLES))}")
    stop_old_backend()
    temp = ROOT / f".db.sqlite3.{uuid.uuid4().hex}.tmp"
    try:
        with psycopg.connect(host="postgres", dbname=os.environ["POSTGRES_DB"], user=os.environ["POSTGRES_USER"], password=os.environ["POSTGRES_PASSWORD"], row_factory=dict_row) as pg:
            with pg.transaction():
                pg.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                source_tables = {r["tablename"] for r in pg.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")}
                if not source_tables:
                    raise RuntimeError("PostgreSQL has no application tables; check the Compose project and original volume name")
                unknown = source_tables - set(TABLES)
                if unknown:
                    raise RuntimeError(f"Unmapped PostgreSQL tables: {sorted(unknown)}")
                if source_tables and source_tables != set(TABLES):
                    raise RuntimeError(f"Missing PostgreSQL tables: {sorted(set(TABLES) - source_tables)}")
                with sqlite3.connect(temp) as db:
                    db.execute("PRAGMA foreign_keys=ON")
                    db.executescript(SCHEMA)
                    for table, expected in TABLES.items():
                        if table not in source_tables:
                            continue
                        columns = {r["column_name"] for r in pg.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s", (table,))}
                        if columns != set(expected):
                            raise RuntimeError(f"Unexpected PostgreSQL columns in {table}: {sorted(columns ^ set(expected))}")
                        quoted = ",".join('"' + c + '"' for c in expected)
                        placeholders = ",".join("?" for _ in expected)
                        with pg.cursor(name=f"copy_{table}") as cursor:
                            cursor.execute(f'SELECT {quoted} FROM "{table}"')
                            while batch := cursor.fetchmany(1000):
                                db.executemany(f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})',
                                               ([convert(row[c], (table, c) in {("generated_posts", "tags"), ("admin_settings", "value"), ("audit_logs", "meta")}) for c in expected] for row in batch))
                        target_count = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                        source_count = pg.execute(f'SELECT count(*) AS count FROM "{table}"').fetchone()["count"]
                        if target_count != source_count:
                            raise RuntimeError(f"Count mismatch in {table}: {source_count} vs {target_count}")
                        print(f"{table}: {target_count} rows verified", flush=True)
                    db.commit()
        copy_media()
        check_db(temp)
        with temp.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temp, DB)
        fd = os.open(ROOT, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        print("Published verified /workspace/db.sqlite3", flush=True)
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        migrate()
    except Exception as exc:
        print(f"Migration failed: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
