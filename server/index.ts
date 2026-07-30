import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { z } from 'zod';
import { db, row, rows } from './db.js';
import { encrypt } from './crypto.js';
import { executeJob, testProvider } from './provider.js';

const app = Fastify({ logger: true, bodyLimit: 22 * 1024 * 1024 });
await app.register(multipart, { limits: { files: 1, fileSize: 20 * 1024 * 1024 } });

const providerSchema = z.object({
  name: z.string().trim().min(1).max(80), baseUrl: z.string().url(), apiKey: z.string().min(1).max(8192),
  model: z.string().trim().min(1).max(200), isDefault: z.boolean().default(false),
});
const jobSchema = z.object({
  providerId: z.string().uuid(), prompt: z.string().trim().min(1).max(8000),
  width: z.number().int().min(256).max(4096), height: z.number().int().min(256).max(4096),
  quality: z.enum(['auto', 'low', 'medium', 'high']), format: z.enum(['png', 'jpeg', 'webp']), count: z.number().int().min(1).max(4),
});

type ProviderRow = { id: string; name: string; base_url: string; api_key_cipher: string; model: string; is_default: number; status: string; error: string; created_at: string; updated_at: string };
type AssetRow = { id: string; filename: string; mime_type: string; width: number; height: number; size_bytes: number; source: string; status: string; created_at: string };
type JobRow = { id: string; provider_id: string; model: string; prompt: string; width: number; height: number; quality: string; format: string; count: number; status: string; error: string; created_at: string; finished_at: string | null };

const exposeProvider = (item: ProviderRow) => ({ id: item.id, name: item.name, baseUrl: item.base_url, model: item.model, isDefault: Boolean(item.is_default), status: item.status, error: item.error, hasApiKey: Boolean(item.api_key_cipher) });
const exposeAsset = (item: AssetRow) => ({ id: item.id, filename: item.filename, mimeType: item.mime_type, width: item.width, height: item.height, sizeBytes: item.size_bytes, source: item.source, status: item.status, createdAt: item.created_at });
const exposeJob = (item: JobRow) => ({ ...item, providerId: item.provider_id, createdAt: item.created_at, finishedAt: item.finished_at, outputs: rows<{ asset_id: string }>('SELECT asset_id FROM job_outputs WHERE job_id=? AND asset_id IS NOT NULL ORDER BY ordinal', item.id).map((output) => output.asset_id) });

app.get('/api/health', async () => ({ ok: true, storage: 'sqlite-local' }));
app.get('/api/providers', async () => ({ items: rows<ProviderRow>('SELECT * FROM providers ORDER BY is_default DESC,created_at DESC').map(exposeProvider) }));
app.post('/api/providers', async (request, reply) => {
  const input = providerSchema.parse(request.body);
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  if (input.isDefault) db.exec('UPDATE providers SET is_default=0');
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, input.name, input.baseUrl.replace(/\/+$/, ''), encrypt(input.apiKey), input.model, input.isDefault ? 1 : 0, 'untested', '', now, now);
  return reply.code(201).send(exposeProvider(row<ProviderRow>('SELECT * FROM providers WHERE id=?', id)!));
});
app.put('/api/providers/:id', async (request) => {
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = providerSchema.partial({ apiKey: true }).parse(request.body);
  const current = row<ProviderRow>('SELECT * FROM providers WHERE id=?', id); if (!current) throw Object.assign(new Error('Provider 不存在'), { statusCode: 404 });
  if (input.isDefault) db.exec('UPDATE providers SET is_default=0');
  db.prepare('UPDATE providers SET name=?,base_url=?,api_key_cipher=?,model=?,is_default=?,status=?,error=?,updated_at=? WHERE id=?').run(input.name, input.baseUrl.replace(/\/+$/, ''), input.apiKey ? encrypt(input.apiKey) : current.api_key_cipher, input.model, input.isDefault ? 1 : 0, 'untested', '', new Date().toISOString(), id);
  return exposeProvider(row<ProviderRow>('SELECT * FROM providers WHERE id=?', id)!);
});
app.delete('/api/providers/:id', async (request, reply) => { const id = z.string().uuid().parse((request.params as { id: string }).id); db.prepare('DELETE FROM providers WHERE id=?').run(id); return reply.code(204).send(); });
app.post('/api/providers/:id/test', async (request) => {
  const id = z.string().uuid().parse((request.params as { id: string }).id); const provider = row<ProviderRow>('SELECT * FROM providers WHERE id=?', id); if (!provider) throw Object.assign(new Error('Provider 不存在'), { statusCode: 404 });
  try { await testProvider(provider); db.prepare("UPDATE providers SET status='healthy',error='',updated_at=? WHERE id=?").run(new Date().toISOString(), id); return { ok: true }; }
  catch (error) { const message = error instanceof Error ? error.message : String(error); db.prepare("UPDATE providers SET status='failed',error=?,updated_at=? WHERE id=?").run(message, new Date().toISOString(), id); return { ok: false, error: message }; }
});

app.get('/api/assets', async () => ({ items: rows<AssetRow>("SELECT * FROM assets WHERE status!='deleted' ORDER BY created_at DESC").map(exposeAsset) }));
app.post('/api/assets', async (request, reply) => {
  const part = await request.file(); if (!part) throw Object.assign(new Error('请选择图片'), { statusCode: 400 });
  const bytes = await part.toBuffer(); const type = await fileTypeFromBuffer(bytes); if (!type || !['image/png', 'image/jpeg', 'image/webp'].includes(type.mime)) throw Object.assign(new Error('只支持 PNG、JPEG、WebP'), { statusCode: 415 });
  const metadata = await sharp(bytes).metadata(); const id = crypto.randomUUID(); const extension = type.ext === 'jpg' ? 'jpg' : type.ext; const filename = `${id}.${extension}`;
  await mkdir(resolve(process.cwd(), 'data/assets'), { recursive: true }); await writeFile(resolve(process.cwd(), 'data/assets', filename), bytes);
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)').run(id, filename, type.mime, metadata.width ?? 0, metadata.height ?? 0, bytes.length, 'upload', 'kept', new Date().toISOString());
  return reply.code(201).send(exposeAsset(row<AssetRow>('SELECT * FROM assets WHERE id=?', id)!));
});
app.get('/api/assets/:id/content', async (request, reply) => { const asset = row<AssetRow>('SELECT * FROM assets WHERE id=?', z.string().uuid().parse((request.params as { id: string }).id)); if (!asset) return reply.code(404).send({ error: '素材不存在' }); reply.type(asset.mime_type); return reply.send(createReadStream(resolve(process.cwd(), 'data/assets', asset.filename))); });
app.delete('/api/assets/:id', async (request, reply) => { const id = z.string().uuid().parse((request.params as { id: string }).id); const asset = row<AssetRow>('SELECT * FROM assets WHERE id=?', id); if (asset) { await unlink(resolve(process.cwd(), 'data/assets', asset.filename)).catch(() => undefined); db.prepare("UPDATE assets SET status='deleted' WHERE id=?").run(id); } return reply.code(204).send(); });

app.get('/api/jobs', async () => ({ items: rows<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50').map(exposeJob) }));
app.post('/api/jobs', async (request, reply) => { const input = jobSchema.parse(request.body); const provider = row<ProviderRow>('SELECT * FROM providers WHERE id=?', input.providerId); if (!provider) throw Object.assign(new Error('Provider 不存在'), { statusCode: 404 }); const id = crypto.randomUUID(); db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, provider.id, provider.model, input.prompt, input.width, input.height, input.quality, input.format, input.count, 'queued', '', new Date().toISOString(), null); setImmediate(() => void executeJob(id)); return reply.code(202).send({ id }); });
app.post('/api/jobs/:id/retry', async (request, reply) => { const source = row<JobRow>('SELECT * FROM jobs WHERE id=?', z.string().uuid().parse((request.params as { id: string }).id)); if (!source) throw Object.assign(new Error('任务不存在'), { statusCode: 404 }); const id = crypto.randomUUID(); db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, source.provider_id, source.model, source.prompt, source.width, source.height, source.quality, source.format, source.count, 'queued', '', new Date().toISOString(), null); setImmediate(() => void executeJob(id)); return reply.code(202).send({ id }); });
app.delete('/api/jobs/:id', async (request, reply) => { db.prepare('DELETE FROM jobs WHERE id=?').run(z.string().uuid().parse((request.params as { id: string }).id)); return reply.code(204).send(); });

const webRoot = resolve(process.cwd(), 'dist/web');
try { await readFile(resolve(webRoot, 'index.html')); await app.register(staticPlugin, { root: webRoot }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html')); } catch { /* Vite serves the UI during development. */ }
app.setErrorHandler((error, _request, reply) => { const details = error instanceof z.ZodError ? error.issues : undefined; const message = error instanceof Error ? error.message : String(error); reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: message, details }); });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 5273) });
