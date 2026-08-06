import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { db, row } from './db.js';
import { decrypt } from './crypto.js';
import { runComfyJob, testComfy, validateWorkflowParamValues, parseComfyConfig } from './comfy.js';

type Provider = { id: string; base_url: string; api_key_cipher: string; model: string; type: string; config: string };
type Primitive = string | number | boolean;
type Job = {
  id: string;
  provider_id: string;
  model: string;
  prompt: string;
  width: number;
  height: number;
  quality: string;
  format: string;
  count: number;
  provider_params: string;
  workflow_snapshot: string;
  input_asset_id: string | null;
};

function endpoint(baseUrl: string, path: 'generations' | 'edits' = 'generations') {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/images/${path}` : `${clean}/v1/images/${path}`;
}

function imagePayload(payload: { data?: Array<{ b64_json?: string; url?: string }> }) {
  return payload.data ?? [];
}

async function collectImages(items: Array<{ b64_json?: string; url?: string }>) {
  const buffers: Buffer[] = [];
  for (const item of items) {
    const bytes = item.b64_json ? Buffer.from(item.b64_json, 'base64') : item.url ? Buffer.from(await (await fetch(item.url)).arrayBuffer()) : null;
    if (bytes) buffers.push(bytes);
  }
  if (!buffers.length) throw new Error('Provider 返回的图片为空');
  return buffers;
}

export async function testProvider(provider: Provider) {
  if (provider.type === 'comfyui') return testComfy(provider.base_url.replace(/\/+$/, ''));
  const base = provider.base_url.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${decrypt(provider.api_key_cipher)}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}`);
}

async function fetchOpenAIImages(job: Job, provider: Provider): Promise<Buffer[]> {
  const response = await fetch(endpoint(provider.base_url), {
    method: 'POST',
    headers: { authorization: `Bearer ${decrypt(provider.api_key_cipher)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: job.model, prompt: job.prompt, size: `${job.width}x${job.height}`, quality: job.quality, n: job.count, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Provider 返回 HTTP ${response.status}`);
  const items = imagePayload(payload);
  if (!items.length) throw new Error('Provider 未返回图片');
  return collectImages(items);
}

/**
 * 参考图迭代走 /images/edits：画布导出的选区作为 image 传上去，模型在它基础上改。
 * 不发 response_format——gpt-image-1 不认这个参数，只有 dall-e-2 支持；两种返回形态都能解析。
 * quality 为 auto 时也不发，避免只认固定档位的模型直接 400。
 */
async function fetchOpenAIImageEdit(job: Job, provider: Provider, reference: { bytes: Buffer; filename: string; mimeType: string }): Promise<Buffer[]> {
  const form = new FormData();
  form.set('image', new File([new Uint8Array(reference.bytes)], reference.filename, { type: reference.mimeType || 'image/png' }));
  form.set('prompt', job.prompt);
  form.set('model', job.model);
  form.set('n', String(job.count));
  form.set('size', `${job.width}x${job.height}`);
  if (job.quality && job.quality !== 'auto') form.set('quality', job.quality);
  const response = await fetch(endpoint(provider.base_url, 'edits'), {
    method: 'POST',
    headers: { authorization: `Bearer ${decrypt(provider.api_key_cipher)}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Provider 返回 HTTP ${response.status}`);
  const items = imagePayload(payload);
  if (!items.length) throw new Error('Provider 未返回图片');
  return collectImages(items);
}

async function referenceImage(assetId: string) {
  const asset = row<{ id: string; filename: string; mime_type: string }>('SELECT id,filename,mime_type FROM assets WHERE id=?', assetId);
  if (!asset) throw new Error('参考图不存在或已删除');
  const bytes = await readFile(resolve(process.cwd(), 'data/assets', asset.filename));
  return { bytes, filename: asset.filename, mimeType: asset.mime_type };
}

function parseProviderParams(raw: string): Record<string, Primitive> {
  let value: unknown;
  try { value = JSON.parse(raw || '{}'); }
  catch { throw new Error('任务的 providerParams 快照不是合法 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务的 providerParams 快照必须是对象');
  const entries = Object.entries(value);
  if (entries.length > 160) throw new Error('任务的 providerParams 最多允许 160 项');
  const params: Record<string, Primitive> = Object.create(null) as Record<string, Primitive>;
  for (const [key, item] of entries) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`任务参数 ${key} 必须是字符串、数字或布尔值`);
    }
    params[key] = item;
  }
  return params;
}

async function saveOutputs(job: Job, buffers: Buffer[]) {
  await mkdir(resolve(process.cwd(), 'data/assets'), { recursive: true });
  for (const [index, bytes] of buffers.entries()) {
    const image = sharp(bytes);
    const metadata = await image.metadata();
    const format = job.format === 'jpeg' ? 'jpg' : job.format;
    const assetId = crypto.randomUUID();
    const filename = `${assetId}.${format}`;
    const output = await image.toFormat(job.format as 'png' | 'jpeg' | 'webp').toBuffer();
    await writeFile(resolve(process.cwd(), 'data/assets', filename), output);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO assets
      (id,filename,mime_type,width,height,size_bytes,source,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(assetId, filename, `image/${job.format}`, metadata.width ?? job.width, metadata.height ?? job.height, output.length, 'generated', 'kept', now);
    db.prepare(`INSERT INTO job_outputs (id,job_id,asset_id,ordinal,error)
      VALUES (?,?,?,?,?)`).run(crypto.randomUUID(), job.id, assetId, index, '');
  }
}

export async function executeJob(jobId: string) {
  const job = row<Job>('SELECT * FROM jobs WHERE id=?', jobId);
  if (!job) return;
  const provider = row<Provider>('SELECT * FROM providers WHERE id=?', job.provider_id);
  if (!provider) return;
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(jobId);
  try {
    let buffers: Buffer[];
    if (job.workflow_snapshot || provider.type === 'comfyui') {
      // 参考图只在 OpenAI 端支持；ComfyUI 走工作流，缺 LoadImage 节点，这里直接拦下而不是静默丢掉参考图。
      if (job.input_asset_id) throw new Error('ComfyUI Provider 不支持参考图，请改用 OpenAI 端 Provider');
      const config = job.workflow_snapshot || provider.config;
      const params = parseProviderParams(job.provider_params);
      validateWorkflowParamValues(parseComfyConfig(config).params, params);
      buffers = await runComfyJob(job, { ...provider, config }, params);
    } else if (job.input_asset_id) {
      buffers = await fetchOpenAIImageEdit(job, provider, await referenceImage(job.input_asset_id));
    } else {
      buffers = await fetchOpenAIImages(job, provider);
    }
    await saveOutputs(job, buffers);
    db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), jobId);
  } catch (error) {
    db.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(error instanceof Error ? error.message : String(error), new Date().toISOString(), jobId);
  }
}
