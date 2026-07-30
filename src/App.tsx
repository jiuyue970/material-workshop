import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Image as ImageIcon, Images, LoaderCircle, Plus, RefreshCw, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { api, json } from './api';
import type { Asset, Job, Provider } from './types';

const running = new Set(['queued', 'running']);
const assetUrl = (id: string) => `/api/assets/${id}/content`;

function IconButton({ title, children, onClick, disabled = false }: { title: string; children: React.ReactNode; onClick(): void; disabled?: boolean }) {
  return <button className="icon-button" type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

export default function App() {
  const client = useQueryClient();
  const [providerOpen, setProviderOpen] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [prompt, setPrompt] = useState(''); const [providerId, setProviderId] = useState('');
  const [width, setWidth] = useState(1024); const [height, setHeight] = useState(1024);
  const [quality, setQuality] = useState('auto'); const [format, setFormat] = useState('png'); const [count, setCount] = useState(1);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ items: Provider[] }>('/providers') });
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => api<{ items: Asset[] }>('/assets') });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<{ items: Job[] }>('/jobs'), refetchInterval: (query) => query.state.data?.items.some((job) => running.has(job.status)) ? 1500 : false });
  const selectedProvider = providers.data?.items.find((item) => item.id === providerId) ?? providers.data?.items.find((item) => item.isDefault) ?? providers.data?.items[0];
  useEffect(() => { if (!providerId && selectedProvider) setProviderId(selectedProvider.id); }, [providerId, selectedProvider]);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['assets'] }), client.invalidateQueries({ queryKey: ['jobs'] }), client.invalidateQueries({ queryKey: ['providers'] })]);
  const generate = useMutation({ mutationFn: () => api('/jobs', { method: 'POST', ...json({ providerId: selectedProvider!.id, prompt, width, height, quality, format, count }) }), onSuccess: async () => { setPrompt(''); await refresh(); } });
  const deleteAsset = useMutation({ mutationFn: (id: string) => api(`/assets/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const jobAction = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'retry' | 'delete' }) => api(`/jobs/${id}${action === 'retry' ? '/retry' : ''}`, { method: action === 'retry' ? 'POST' : 'DELETE' }), onSuccess: refresh });
  const upload = async (file?: File) => { if (!file) return; const body = new FormData(); body.set('file', file); await api('/assets', { method: 'POST', body }); await refresh(); };
  const loading = providers.isLoading || assets.isLoading || jobs.isLoading;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span><Images size={19} /></span><div><strong>素材工坊</strong><small>独立图片生成与素材管理</small></div></div><div className="top-actions"><IconButton title="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></IconButton><button className="button" onClick={() => setProviderOpen(true)}><Settings2 size={16} />Provider</button></div></header>
    <main>
      <section className="composer panel"><header><div><h1>创建图片</h1><p>{selectedProvider ? `${selectedProvider.name} / ${selectedProvider.model}` : '先配置图片 Provider'}</p></div><span className={`status ${selectedProvider?.status || 'untested'}`}>{selectedProvider?.status || '未配置'}</span></header>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (selectedProvider && prompt.trim()) generate.mutate(); }}>
          <label><span>Provider / 模型</span><select value={selectedProvider?.id || ''} onChange={(event) => setProviderId(event.target.value)}><option value="">尚未配置</option>{providers.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.model}</option>)}</select></label>
          <label><span>提示词</span><textarea rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想生成的画面、构图、光线和风格..." /></label>
          <div className="size-presets"><button type="button" onClick={() => { setWidth(1024); setHeight(1024); }}>方图</button><button type="button" onClick={() => { setWidth(1536); setHeight(1024); }}>横图</button><button type="button" onClick={() => { setWidth(1024); setHeight(1536); }}>竖图</button></div>
          <div className="form-grid"><label><span>宽度</span><input type="number" value={width} step={16} onChange={(event) => setWidth(Number(event.target.value))} /></label><label><span>高度</span><input type="number" value={height} step={16} onChange={(event) => setHeight(Number(event.target.value))} /></label><label><span>质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label><span>格式</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label><label><span>数量</span><input type="number" min={1} max={4} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label></div>
          {generate.error ? <p className="error">{generate.error.message}</p> : null}
          <button className="button primary generate" disabled={!selectedProvider || !prompt.trim() || generate.isPending}>{generate.isPending ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}生成图片</button>
        </form>
      </section>
      <div className="content-column">
        <section className="library panel"><header><div><h2>素材库</h2><p>{assets.data?.items.length || 0} 个本地素材</p></div><label className="button"><Upload size={16} />上传<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(event.target.files?.[0])} /></label></header>
          {loading ? <div className="loading"><LoaderCircle className="spin" /></div> : assets.data?.items.length ? <div className="asset-grid">{assets.data.items.map((asset) => <article key={asset.id}><button className="asset-preview" onClick={() => setPreview(asset)}><img src={assetUrl(asset.id)} alt={asset.filename} /></button><div className="asset-meta"><div><strong>{asset.source === 'generated' ? '生成图片' : '上传图片'}</strong><small>{asset.width} x {asset.height} / {Math.ceil(asset.sizeBytes / 1024)} KB</small></div><div><a className="icon-button" href={assetUrl(asset.id)} download={asset.filename} title="下载"><Download size={15} /></a><IconButton title="删除" onClick={() => deleteAsset.mutate(asset.id)}><Trash2 size={15} /></IconButton></div></div></article>)}</div> : <div className="empty"><ImageIcon size={34} /><strong>素材库还是空的</strong><span>上传图片，或配置 Provider 后生成第一张图片。</span></div>}
        </section>
        <section className="jobs panel"><header><div><h2>生成任务</h2><p>最近 50 条记录</p></div></header><div className="job-list">{jobs.data?.items.length ? jobs.data.items.map((job) => <article key={job.id}><span className={`job-state ${job.status}`}>{running.has(job.status) ? <LoaderCircle className="spin" size={16} /> : job.status === 'completed' ? <Check size={16} /> : <X size={16} />}</span><div><strong>{job.prompt}</strong><small>{job.model} / {job.width} x {job.height} / {job.count} 张</small>{job.error ? <em>{job.error}</em> : null}</div><span className="job-status">{job.status}</span><div className="job-actions">{job.status === 'failed' ? <IconButton title="重试" onClick={() => jobAction.mutate({ id: job.id, action: 'retry' })}><RefreshCw size={15} /></IconButton> : null}<IconButton title="删除任务" onClick={() => jobAction.mutate({ id: job.id, action: 'delete' })}><Trash2 size={15} /></IconButton></div></article>) : <div className="empty compact">暂无任务</div>}</div></section>
      </div>
    </main>
    {providerOpen ? <ProviderDialog providers={providers.data?.items || []} onClose={() => setProviderOpen(false)} onChanged={refresh} /> : null}
    {preview ? <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><div className="preview-modal"><header><div><strong>{preview.filename}</strong><small>{preview.width} x {preview.height}</small></div><IconButton title="关闭" onClick={() => setPreview(null)}><X size={18} /></IconButton></header><img src={assetUrl(preview.id)} alt={preview.filename} /></div></div> : null}
  </div>;
}

function ProviderDialog({ providers, onClose, onChanged }: { providers: Provider[]; onClose(): void; onChanged(): Promise<unknown> }) {
  const [editing, setEditing] = useState<Provider | null>(null); const [creating, setCreating] = useState(!providers.length); const [error, setError] = useState(''); const [testing, setTesting] = useState('');
  const [name, setName] = useState(''); const [baseUrl, setBaseUrl] = useState(''); const [apiKey, setApiKey] = useState(''); const [model, setModel] = useState(''); const [isDefault, setIsDefault] = useState(true);
  const select = (item?: Provider) => { setEditing(item || null); setCreating(!item); setName(item?.name || ''); setBaseUrl(item?.baseUrl || ''); setApiKey(''); setModel(item?.model || ''); setIsDefault(item?.isDefault ?? !providers.length); setError(''); };
  const save = async (event: FormEvent) => { event.preventDefault(); setError(''); try { await api(`/providers${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', ...json({ name, baseUrl, ...(apiKey ? { apiKey } : {}), model, isDefault }) }); await onChanged(); select(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const test = async (id: string) => { setTesting(id); await api(`/providers/${id}/test`, { method: 'POST' }).catch(() => undefined); await onChanged(); setTesting(''); };
  const remove = async (id: string) => { await api(`/providers/${id}`, { method: 'DELETE' }); await onChanged(); select(); };
  return <div className="modal-backdrop"><section className="provider-modal"><header><div><h2>图片 Provider</h2><p>密钥加密保存在本机 SQLite</p></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header><div className="provider-layout"><aside><button className="button add" onClick={() => select()}><Plus size={15} />新增 Provider</button>{providers.map((item) => <button className={`provider-row ${editing?.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => select(item)}><span><strong>{item.name}</strong><small>{item.model}</small></span><i className={item.status}>{item.status}</i></button>)}</aside><form onSubmit={save}>{creating || editing ? <><label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>Base URL</span><input type="url" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></label><label><span>API Key</span><input type="password" placeholder={editing ? '留空则保留原密钥' : '输入 API Key'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!editing} /></label><label><span>模型</span><input placeholder="gpt-image-1" value={model} onChange={(event) => setModel(event.target.value)} required /></label><label className="check"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />设为默认 Provider</label>{error ? <p className="error">{error}</p> : null}<div className="form-actions">{editing ? <><button type="button" className="button danger" onClick={() => void remove(editing.id)}><Trash2 size={15} />删除</button><button type="button" className="button" onClick={() => void test(editing.id)} disabled={testing === editing.id}>{testing === editing.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}测试</button></> : null}<button className="button primary" type="submit">保存</button></div></> : <div className="empty">选择或新增 Provider</div>}</form></div></section></div>;
}
