import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(resolve(dataDir, 'workshop.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key_cipher TEXT NOT NULL,
    model TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'untested',
    error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'openai', config TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL,
    height INTEGER NOT NULL, size_bytes INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'kept',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, quality TEXT NOT NULL, format TEXT NOT NULL,
    count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    finished_at TEXT, provider_params TEXT NOT NULL DEFAULT '{}', workflow_snapshot TEXT NOT NULL DEFAULT '',
    input_asset_id TEXT,
    FOREIGN KEY(provider_id) REFERENCES providers(id), FOREIGN KEY(input_asset_id) REFERENCES assets(id)
  );
  CREATE TABLE IF NOT EXISTS job_outputs (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, asset_id TEXT, ordinal INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE, FOREIGN KEY(asset_id) REFERENCES assets(id)
  );
`);

// 老库轻量迁移：只补缺失列，重复启动不会重复执行。
{
  const columns = db.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('type')) db.exec("ALTER TABLE providers ADD COLUMN type TEXT NOT NULL DEFAULT 'openai'");
  if (!names.has('config')) db.exec("ALTER TABLE providers ADD COLUMN config TEXT NOT NULL DEFAULT ''");
}
{
  const columns = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('provider_params')) db.exec("ALTER TABLE jobs ADD COLUMN provider_params TEXT NOT NULL DEFAULT '{}'");
  if (!names.has('workflow_snapshot')) db.exec("ALTER TABLE jobs ADD COLUMN workflow_snapshot TEXT NOT NULL DEFAULT ''");
  // 参考图（图生图）只走 OpenAI 端的 /images/edits，老库补一列即可。
  if (!names.has('input_asset_id')) db.exec('ALTER TABLE jobs ADD COLUMN input_asset_id TEXT');
}

export function rows<T>(statement: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(statement).all(...params) as T[];
}

export function row<T>(statement: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(statement).get(...params) as T | undefined;
}
