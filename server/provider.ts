import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { db, row } from './db.js';
import { decrypt } from './crypto.js';

type Provider = { id: string; base_url: string; api_key_cipher: string; model: string };
type Job = { id: string; provider_id: string; model: string; prompt: string; width: number; height: number; quality: string; format: string; count: number };

function endpoint(baseUrl: string) {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/images/generations` : `${clean}/v1/images/generations`;
}

export async function testProvider(provider: Provider) {
  const base = provider.base_url.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${decrypt(provider.api_key_cipher)}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}`);
}

export async function executeJob(jobId: string) {
  const job = row<Job>('SELECT * FROM jobs WHERE id=?', jobId);
  if (!job) return;
  const provider = row<Provider>('SELECT * FROM providers WHERE id=?', job.provider_id);
  if (!provider) return;
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(jobId);
  try {
    const response = await fetch(endpoint(provider.base_url), {
      method: 'POST',
      headers: { authorization: `Bearer ${decrypt(provider.api_key_cipher)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: job.model, prompt: job.prompt, size: `${job.width}x${job.height}`, quality: job.quality, n: job.count, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `Provider 返回 HTTP ${response.status}`);
    const items = payload.data ?? [];
    if (!items.length) throw new Error('Provider 未返回图片');
    await mkdir(resolve(process.cwd(), 'data/assets'), { recursive: true });
    for (const [index, item] of items.entries()) {
      const bytes = item.b64_json ? Buffer.from(item.b64_json, 'base64') : item.url ? Buffer.from(await (await fetch(item.url)).arrayBuffer()) : null;
      if (!bytes) continue;
      const image = sharp(bytes);
      const metadata = await image.metadata();
      const format = job.format === 'jpeg' ? 'jpg' : job.format;
      const assetId = crypto.randomUUID();
      const filename = `${assetId}.${format}`;
      const output = await image.toFormat(job.format as 'png' | 'jpeg' | 'webp').toBuffer();
      await writeFile(resolve(process.cwd(), 'data/assets', filename), output);
      const now = new Date().toISOString();
      db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?)').run(assetId, filename, `image/${job.format}`, metadata.width ?? job.width, metadata.height ?? job.height, output.length, 'generated', 'kept', now);
      db.prepare('INSERT INTO job_outputs VALUES (?,?,?,?,?)').run(crypto.randomUUID(), jobId, assetId, index, '');
    }
    db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), jobId);
  } catch (error) {
    db.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(error instanceof Error ? error.message : String(error), new Date().toISOString(), jobId);
  }
}
