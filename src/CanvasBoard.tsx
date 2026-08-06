import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Excalidraw, convertToExcalidrawElements, exportToBlob } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { ImagePlus, LoaderCircle, Save, Sparkles, Wand2 } from 'lucide-react';
import '@excalidraw/excalidraw/index.css';
import { api, json } from './api';
import type { Asset, Job, Provider } from './types';

const assetUrl = (id: string) => `/api/assets/${id}/content`;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 300_000;

async function assetDataUrl(asset: Asset) {
  const response = await fetch(assetUrl(asset.id));
  if (!response.ok) throw new Error(`素材 ${asset.filename} 读取失败`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`素材 ${asset.filename} 解码失败`));
    reader.readAsDataURL(blob);
  });
}

/** 画布坐标是无限的，新图往右排开，避免叠在一起看不出来。 */
function nextPlacement(elements: readonly ExcalidrawElement[]) {
  const visible = elements.filter((element) => !element.isDeleted);
  if (!visible.length) return { x: 0, y: 0 };
  return { x: Math.max(...visible.map((element) => element.x + element.width)) + 48, y: Math.min(...visible.map((element) => element.y)) };
}

function scaled(asset: Asset, max = 720) {
  const width = asset.width || max;
  const height = asset.height || max;
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

export default function CanvasBoard({ providers, assets }: { providers: Provider[]; assets: Asset[] }) {
  const client = useQueryClient();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [providerId, setProviderId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const selectedProvider = providers.find((item) => item.id === providerId) ?? providers.find((item) => item.isDefault) ?? providers[0];

  const placeAssets = useCallback(async (items: Asset[]) => {
    const board = apiRef.current;
    if (!board || !items.length) return;
    const files = await Promise.all(items.map(async (asset) => ({
      id: asset.id as never,
      dataURL: await assetDataUrl(asset) as never,
      mimeType: (asset.mimeType || 'image/png') as never,
      created: Date.now(),
    })));
    board.addFiles(files);
    const existing = board.getSceneElements();
    let placement = nextPlacement(existing);
    const added = items.map((asset) => {
      const size = scaled(asset);
      const element = { type: 'image' as const, x: placement.x, y: placement.y, fileId: asset.id as never, ...size };
      placement = { x: placement.x + size.width + 48, y: placement.y };
      return element;
    });
    board.updateScene({ elements: [...existing, ...convertToExcalidrawElements(added)] });
    board.scrollToContent(undefined, { fitToContent: true });
  }, []);

  /** 只导出选中的元素；没选就导出整张画布。标注和底图一起拍平成 PNG。 */
  const exportSelection = useCallback(async () => {
    const board = apiRef.current;
    if (!board) throw new Error('画布尚未就绪');
    const all = board.getSceneElements();
    const selection = board.getAppState().selectedElementIds;
    const chosen = all.filter((element) => selection[element.id]);
    const elements = chosen.length ? chosen : all;
    if (!elements.length) throw new Error('画布是空的，先放一张素材或画点东西');
    return exportToBlob({
      elements,
      files: board.getFiles(),
      appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
      mimeType: 'image/png',
      exportPadding: 16,
    });
  }, []);

  /** 选区先落成素材，再拿它的 id 当参考图——服务端只认素材 id，不接受裸文件。 */
  const uploadSelection = useCallback(async () => {
    const blob = await exportSelection();
    const body = new FormData();
    body.set('file', new File([blob], `canvas-${Date.now()}.png`, { type: 'image/png' }));
    const asset = await api<Asset>('/assets', { method: 'POST', body });
    await client.invalidateQueries({ queryKey: ['assets'] });
    return { asset, size: blob.size };
  }, [client, exportSelection]);

  const saveSelection = useMutation({
    mutationFn: async () => (await uploadSelection()).size,
    onSuccess: (size) => { setError(''); setNote(`已存入素材库（${Math.ceil(size / 1024)} KB）`); },
    onError: (cause: Error) => { setNote(''); setError(cause.message); },
  });

  const runJob = useCallback(async (inputAssetId?: string) => {
      if (!selectedProvider) throw new Error('先在工作台配置图片 Provider');
      if (!prompt.trim()) throw new Error('先写一句提示词');
      if (inputAssetId && selectedProvider.type === 'comfyui') throw new Error('参考图迭代只支持 OpenAI 端 Provider，请先切换 Provider');
      const before = new Set((await api<{ items: Asset[] }>('/assets')).items.map((asset) => asset.id));
      const created = await api<{ id: string }>('/jobs', {
        method: 'POST',
        ...json({ providerId: selectedProvider.id, prompt: prompt.trim(), width: 1024, height: 1024, quality: 'auto', format: 'png', count: 1, providerParams: {}, ...(inputAssetId ? { inputAssetId } : {}) }),
      });
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
        const list = await api<{ items: Job[] }>('/jobs');
        const job = list.items.find((item) => item.id === created.id);
        if (job?.status === 'failed') throw new Error(job.error || '生成失败');
        if (job?.status === 'completed') break;
        if (Date.now() > deadline) throw new Error('生成超时，任务仍在队列里，可到工作台查看');
      }
      await client.invalidateQueries({ queryKey: ['assets'] });
      const after = await api<{ items: Asset[] }>('/assets');
      const fresh = after.items.filter((asset) => !before.has(asset.id));
      await placeAssets(fresh);
      return fresh.length;
  }, [client, placeAssets, prompt, selectedProvider]);

  const generate = useMutation({
    mutationFn: () => runJob(),
    onSuccess: (count) => { setError(''); setNote(count ? `已生成 ${count} 张并贴回画布` : '任务完成，但没有拿到新素材'); },
    onError: (cause: Error) => { setNote(''); setError(cause.message); },
  });

  /** 标注驱动迭代：把选区（底图 + 标注）当参考图交给 /images/edits。 */
  const iterate = useMutation({
    mutationFn: async () => {
      const { asset } = await uploadSelection();
      return runJob(asset.id);
    },
    onSuccess: (count) => { setError(''); setNote(count ? `已按标注迭代出 ${count} 张并贴回画布` : '任务完成，但没有拿到新素材'); },
    onError: (cause: Error) => { setNote(''); setError(cause.message); },
  });

  const busy = saveSelection.isPending || generate.isPending || iterate.isPending;
  const openAiProvider = selectedProvider?.type !== 'comfyui';

  return <section className="canvas-board panel">
    <header>
      <div><h2>画布</h2><p>把素材拖进来标注，导出选区或直接生成</p></div>
      <div className="canvas-actions">
        <button className="button" type="button" disabled={busy || !assets.length} onClick={() => void placeAssets(assets.slice(0, 1))}><ImagePlus size={15} />放入最新素材</button>
        <button className="button" type="button" disabled={busy} onClick={() => saveSelection.mutate()}>{saveSelection.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}导出选区到素材库</button>
      </div>
    </header>
    <div className="canvas-prompt">
      <select value={selectedProvider?.id ?? ''} onChange={(event) => setProviderId(event.target.value)} aria-label="Provider">
        <option value="">尚未配置</option>
        {providers.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.model}</option>)}
      </select>
      <input value={prompt} placeholder={openAiProvider ? '描述要生成的画面，或说明按标注怎么改……' : '描述要生成的画面……（ComfyUI Provider 不支持参考图迭代）'} onChange={(event) => setPrompt(event.target.value)} />
      <button className="button" type="button" disabled={busy || !selectedProvider || !prompt.trim()} onClick={() => generate.mutate()}>
        {generate.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}文生图
      </button>
      <button className="button primary" type="button" title={openAiProvider ? '把选区连同标注作为参考图迭代' : 'ComfyUI Provider 不支持参考图'} disabled={busy || !selectedProvider || !prompt.trim() || !openAiProvider} onClick={() => iterate.mutate()}>
        {iterate.isPending ? <LoaderCircle className="spin" size={15} /> : <Wand2 size={15} />}按标注迭代
      </button>
    </div>
    {error ? <p className="error">{error}</p> : null}
    {note ? <p className="canvas-note">{note}</p> : null}
    <div className="canvas-surface">
      <Excalidraw excalidrawAPI={(instance) => { apiRef.current = instance; }} langCode="zh-CN" UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }} />
    </div>
  </section>;
}
