import { Suspense, lazy, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Images,
  ListTree,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, json } from './api';
// 画布把 Excalidraw（含 mermaid/katex 等）拉进来有几 MB，懒加载后工作台首屏不受影响。
const CanvasBoard = lazy(() => import('./CanvasBoard'));
import type {
  Asset,
  Job,
  Provider,
  WorkflowInspection,
  WorkflowNode,
  WorkflowParam,
  WorkflowParamValue,
} from './types';

const running = new Set(['queued', 'running']);
const assetUrl = (id: string) => `/api/assets/${id}/content`;
const loraParamKey = /^lora_(\d+)_(enabled|name|strength)$/;

type LoraSlot = {
  number: number;
  enabled?: WorkflowParam;
  name?: WorkflowParam;
  strength?: WorkflowParam;
};

function IconButton({ title, children, onClick, disabled = false }: { title: string; children: React.ReactNode; onClick(): void; disabled?: boolean }) {
  return <button className="icon-button" type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

function defaultWorkflowValues(params: WorkflowParam[]) {
  return Object.fromEntries(params.flatMap((param) => param.default === undefined ? [] : [[param.key, param.default]])) as Record<string, WorkflowParamValue>;
}

function WorkflowField({ param, value, onChange, label = param.label }: { param: WorkflowParam; value: WorkflowParamValue | undefined; onChange(value: WorkflowParamValue | undefined): void; label?: string }) {
  const id = `workflow-${param.key}`;
  if (param.kind === 'boolean') {
    return <label className="workflow-toggle" htmlFor={id}><span>{label}</span><input id={id} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /></label>;
  }
  if (param.kind === 'select') {
    return <label htmlFor={id}><span>{label}</span><select id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{(param.options ?? []).map((option) => <option key={option} value={option}>{option || '不选择'}</option>)}</select></label>;
  }
  if (param.kind === 'int' || param.kind === 'float' || param.kind === 'seed') {
    return <label htmlFor={id}><span>{label}</span><input id={id} type="number" value={value === undefined ? '' : String(value)} min={param.min} max={param.max} step={param.step ?? (param.kind === 'float' ? 0.01 : 1)} placeholder={param.kind === 'seed' ? '留空随机' : param.placeholder} onChange={(event) => onChange(event.target.value || undefined)} /></label>;
  }
  return <label htmlFor={id}><span>{label}</span><input id={id} value={String(value ?? '')} placeholder={param.placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function collectLoraSlots(params: WorkflowParam[]) {
  const slots = new Map<number, LoraSlot>();
  for (const param of params) {
    const match = loraParamKey.exec(param.key);
    if (!match) continue;
    const number = Number(match[1]);
    const field = match[2] as 'enabled' | 'name' | 'strength';
    const slot = slots.get(number) ?? { number };
    slot[field] = param;
    slots.set(number, slot);
  }
  return [...slots.values()].sort((left, right) => left.number - right.number);
}

function LoraSlotFields({ params, values, onChange }: { params: WorkflowParam[]; values: Record<string, WorkflowParamValue>; onChange(key: string, value: WorkflowParamValue | undefined): void }) {
  return <div className="lora-slots">{collectLoraSlots(params).map((slot) => {
    const enabled = slot.enabled ? values[slot.enabled.key] === true : false;
    const checkboxId = slot.enabled ? `workflow-${slot.enabled.key}` : undefined;
    return <section className={`lora-slot ${enabled ? 'enabled' : ''}`} key={slot.number}>
      <label className="lora-slot-header" htmlFor={checkboxId}>
        <span>LoRA {slot.number}</span>
        <small>{enabled ? '已启用' : '未启用'}</small>
        {slot.enabled ? <input id={checkboxId} type="checkbox" checked={enabled} onChange={(event) => onChange(slot.enabled!.key, event.target.checked)} /> : null}
      </label>
      {enabled ? <div className="lora-slot-fields">
        {slot.name ? <WorkflowField param={slot.name} label="文件" value={values[slot.name.key]} onChange={(value) => onChange(slot.name!.key, value)} /> : null}
        {slot.strength ? <WorkflowField param={slot.strength} label="强度" value={values[slot.strength.key]} onChange={(value) => onChange(slot.strength!.key, value)} /> : null}
      </div> : null}
    </section>;
  })}</div>;
}

function WorkflowParameterGroups({ params, values, onChange }: { params: WorkflowParam[]; values: Record<string, WorkflowParamValue>; onChange(key: string, value: WorkflowParamValue | undefined): void }) {
  const groups = useMemo(() => {
    const map = new Map<string, WorkflowParam[]>();
    for (const param of params) {
      const group = param.group || '工作流参数';
      map.set(group, [...(map.get(group) ?? []), param]);
    }
    return [...map.entries()];
  }, [params]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setOpenGroups(new Set(groups.filter(([group]) => group !== 'LoRA').map(([group]) => group)));
  }, [groups]);

  if (!groups.length) return null;
  return <div className="workflow-parameters">{groups.map(([group, groupParams]) => {
    const open = openGroups.has(group);
    const enabledLoras = group === 'LoRA' ? groupParams.filter((param) => param.key.endsWith('_enabled') && values[param.key] === true).length : 0;
    return <section className={`workflow-group ${group === 'LoRA' ? 'lora-group' : ''}`} key={group}>
      <button type="button" className="workflow-group-toggle" onClick={() => setOpenGroups((current) => {
        const next = new Set(current);
        if (next.has(group)) next.delete(group); else next.add(group);
        return next;
      })}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span>{group}</span><small>{group === 'LoRA' ? `${enabledLoras} 已启用 / ${groupParams.length / 3} 槽位` : `${groupParams.length} 项`}</small></button>
      {open ? group === 'LoRA'
        ? <LoraSlotFields params={groupParams} values={values} onChange={onChange} />
        : <div className="workflow-fields">{groupParams.map((param) => <WorkflowField key={param.key} param={param} value={values[param.key]} onChange={(value) => onChange(param.key, value)} />)}</div>
        : null}
    </section>;
  })}</div>;
}

export default function App() {
  const client = useQueryClient();
  const [providerOpen, setProviderOpen] = useState(false);
  const [view, setView] = useState<'studio' | 'canvas'>('studio');
  const [preview, setPreview] = useState<Asset | null>(null);
  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [quality, setQuality] = useState('auto');
  const [format, setFormat] = useState('png');
  const [count, setCount] = useState(1);
  const [providerParams, setProviderParams] = useState<Record<string, WorkflowParamValue>>({});
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ items: Provider[] }>('/providers') });
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => api<{ items: Asset[] }>('/assets') });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<{ items: Job[] }>('/jobs'), refetchInterval: (query) => query.state.data?.items.some((job) => running.has(job.status)) ? 1500 : false });
  const selectedProvider = providers.data?.items.find((item) => item.id === providerId) ?? providers.data?.items.find((item) => item.isDefault) ?? providers.data?.items[0];
  const selectedParamsSignature = (selectedProvider?.params ?? [])
    .map((param) => `${param.key}:${JSON.stringify(param.default)}`)
    .join('|');

  useEffect(() => { if (!providerId && selectedProvider) setProviderId(selectedProvider.id); }, [providerId, selectedProvider]);
  useEffect(() => { setProviderParams(defaultWorkflowValues(selectedProvider?.params ?? [])); }, [selectedProvider?.id, selectedParamsSignature]);

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['assets'] }), client.invalidateQueries({ queryKey: ['jobs'] }), client.invalidateQueries({ queryKey: ['providers'] })]);
  const generate = useMutation({
    mutationFn: () => api('/jobs', { method: 'POST', ...json({ providerId: selectedProvider!.id, prompt, width, height, quality, format, count, providerParams }) }),
    onSuccess: async () => { setPrompt(''); await refresh(); },
  });
  const deleteAsset = useMutation({ mutationFn: (id: string) => api(`/assets/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const jobAction = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'retry' | 'delete' }) => api(`/jobs/${id}${action === 'retry' ? '/retry' : ''}`, { method: action === 'retry' ? 'POST' : 'DELETE' }), onSuccess: refresh });
  const upload = async (file?: File) => { if (!file) return; const body = new FormData(); body.set('file', file); await api('/assets', { method: 'POST', body }); await refresh(); };
  const loading = providers.isLoading || assets.isLoading || jobs.isLoading;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span><Images size={19} /></span><div><strong>素材工坊</strong><small>独立图片生成与素材管理</small></div></div><div className="top-actions"><div className="view-switch" role="group" aria-label="视图"><button type="button" className={view === 'studio' ? 'active' : ''} onClick={() => setView('studio')}>工作台</button><button type="button" className={view === 'canvas' ? 'active' : ''} onClick={() => setView('canvas')}>画布</button></div><IconButton title="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></IconButton><button className="button" onClick={() => setProviderOpen(true)}><Settings2 size={16} />Provider</button></div></header>
    {view === 'canvas' ? <main className="canvas-main"><Suspense fallback={<div className="loading"><LoaderCircle className="spin" /></div>}><CanvasBoard providers={providers.data?.items ?? []} assets={assets.data?.items ?? []} /></Suspense></main> : <main>
      <section className="composer panel"><header><div><h1>创建图片</h1><p>{selectedProvider ? `${selectedProvider.name} / ${selectedProvider.model}` : '先配置图片 Provider'}</p></div><span className={`status ${selectedProvider?.status || 'untested'}`}>{selectedProvider?.status || '未配置'}</span></header>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (selectedProvider && prompt.trim()) generate.mutate(); }}>
          <label><span>Provider / 模型</span><select value={selectedProvider?.id || ''} onChange={(event) => setProviderId(event.target.value)}><option value="">尚未配置</option>{providers.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.model}</option>)}</select></label>
          <label><span>提示词</span><textarea rows={7} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想生成的画面、构图、光线和风格..." /></label>
          <div className="size-presets"><button type="button" onClick={() => { setWidth(1024); setHeight(1024); }}>方图</button><button type="button" onClick={() => { setWidth(1536); setHeight(1024); }}>横图</button><button type="button" onClick={() => { setWidth(1024); setHeight(1536); }}>竖图</button></div>
          <div className="form-grid"><label><span>宽度</span><input type="number" value={width} step={16} onChange={(event) => setWidth(Number(event.target.value))} /></label><label><span>高度</span><input type="number" value={height} step={16} onChange={(event) => setHeight(Number(event.target.value))} /></label><label><span>质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label><span>格式</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label><label><span>数量</span><input type="number" min={1} max={4} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label></div>
          {selectedProvider?.type === 'comfyui' ? <WorkflowParameterGroups params={selectedProvider.params} values={providerParams} onChange={(key, value) => setProviderParams((current) => {
            if (value !== undefined) return { ...current, [key]: value };
            const next = { ...current };
            delete next[key];
            return next;
          })} /> : null}
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
    </main>}
    {providerOpen ? <ProviderDialog providers={providers.data?.items || []} onClose={() => setProviderOpen(false)} onChanged={refresh} /> : null}
    {preview ? <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><div className="preview-modal"><header><div><strong>{preview.filename}</strong><small>{preview.width} x {preview.height}</small></div><IconButton title="关闭" onClick={() => setPreview(null)}><X size={18} /></IconButton></header><img src={assetUrl(preview.id)} alt={preview.filename} /></div></div> : null}
  </div>;
}

function NodeSummary({ nodes }: { nodes: WorkflowNode[] }) {
  if (!nodes.length) return null;
  return <div className="node-summary"><div><ListTree size={16} /><strong>{nodes.length} 个节点</strong><span>{nodes.reduce((count, node) => count + node.inputKeys.length, 0)} 个可编辑输入</span></div><div className="node-list">{nodes.map((node) => <span key={node.id}><b>{node.id}</b>{node.title}</span>)}</div></div>;
}

function ProviderDialog({ providers, onClose, onChanged }: { providers: Provider[]; onClose(): void; onChanged(): Promise<unknown> }) {
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(!providers.length);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [type, setType] = useState('openai');
  const [workflowText, setWorkflowText] = useState('');
  const [bindingsText, setBindingsText] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [inspectionNote, setInspectionNote] = useState('');

  const select = (item?: Provider) => {
    setEditing(item || null); setCreating(!item); setName(item?.name || ''); setBaseUrl(item?.baseUrl || ''); setApiKey(''); setModel(item?.model || ''); setIsDefault(item?.isDefault ?? !providers.length); setError(''); setInspectionNote('');
    setType(item?.type || 'openai'); setWorkflowText(''); setBindingsText(''); setParamsText(''); setNodes(item?.workflowNodes ?? []);
    if (item?.type === 'comfyui') {
      void api<Provider>(`/providers/${item.id}`).then((detail) => {
        try {
          const parsed = JSON.parse(detail.config || '{}') as { workflow?: unknown; bindings?: unknown; params?: unknown };
          setWorkflowText(parsed.workflow ? JSON.stringify(parsed.workflow, null, 2) : '');
          setBindingsText(parsed.bindings ? JSON.stringify(parsed.bindings, null, 2) : '');
          setParamsText(parsed.params ? JSON.stringify(parsed.params, null, 2) : '');
          setNodes(detail.workflowNodes ?? []);
        } catch { setError('Provider 工作流配置无法解析'); }
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const inspect = async () => {
    setError(''); setInspectionNote(''); setInspecting(true);
    try {
      const workflow = JSON.parse(workflowText) as unknown;
      const result = await api<WorkflowInspection>('/providers/inspect-comfy-workflow', { method: 'POST', ...json({ baseUrl, workflow }) });
      setBindingsText(JSON.stringify(result.bindings, null, 2));
      setParamsText(JSON.stringify(result.params, null, 2));
      setNodes(result.nodes);
      setInspectionNote(result.metadataWarning || `已同步 ${result.nodes.length} 个节点、${result.params.length} 个参数、${result.loraCount} 个 LoRA 文件`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setInspecting(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      let config = '';
      if (type === 'comfyui') {
        let workflow: unknown; let bindings: unknown; let params: unknown;
        try { workflow = JSON.parse(workflowText); } catch { throw new Error('工作流模板不是合法 JSON'); }
        try { bindings = bindingsText.trim() ? JSON.parse(bindingsText) : undefined; } catch { throw new Error('节点绑定不是合法 JSON'); }
        try { params = paramsText.trim() ? JSON.parse(paramsText) : undefined; } catch { throw new Error('工作流参数不是合法 JSON'); }
        config = JSON.stringify({ workflow, ...(bindings ? { bindings } : {}), ...(params ? { params } : {}) });
      }
      await api(`/providers${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', ...json({ name, baseUrl, ...(apiKey ? { apiKey } : {}), model, isDefault, type, config }) });
      await onChanged(); select();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const test = async (id: string) => { setTesting(id); await api(`/providers/${id}/test`, { method: 'POST' }).catch(() => undefined); await onChanged(); setTesting(''); };
  const remove = async (id: string) => { await api(`/providers/${id}`, { method: 'DELETE' }); await onChanged(); select(); };

  return <div className="modal-backdrop"><section className="provider-modal"><header><div><h2>图片 Provider</h2><p>密钥加密保存在本机 SQLite</p></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header><div className="provider-layout"><aside><button className="button add" onClick={() => select()}><Plus size={15} />新增 Provider</button>{providers.map((item) => <button className={`provider-row ${editing?.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => select(item)}><span><strong>{item.name}</strong><small>{item.model}</small></span><i className={item.status}>{item.status}</i></button>)}</aside><form onSubmit={save}>{creating || editing ? <>
    <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
    <label><span>类型</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="openai">OpenAI Images</option><option value="comfyui">ComfyUI（SSH 隧道）</option></select></label>
    <label><span>Base URL</span><input type="url" placeholder={type === 'comfyui' ? 'http://127.0.0.1:8188' : 'https://api.openai.com/v1'} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></label>
    <label><span>API Key</span><input type="password" placeholder={type === 'comfyui' ? 'ComfyUI 无需密钥，留空即可' : editing ? '留空则保留原密钥' : '输入 API Key'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={type === 'openai' && !editing} /></label>
    <label><span>模型</span><input placeholder={type === 'comfyui' ? 'white-创作方案' : 'gpt-image-1'} value={model} onChange={(event) => setModel(event.target.value)} required /></label>
    {type === 'comfyui' ? <div className="comfy-workflow-editor"><label><span>工作流模板（ComfyUI API JSON）</span><textarea rows={10} value={workflowText} onChange={(event) => setWorkflowText(event.target.value)} placeholder="粘贴 ComfyUI API 格式的工作流 JSON" required /></label><button type="button" className="button read-nodes" onClick={() => void inspect()} disabled={inspecting || !baseUrl || !workflowText.trim()}>{inspecting ? <LoaderCircle className="spin" size={15} /> : <ListTree size={15} />}读取节点</button>{inspectionNote ? <p className="inspection-note">{inspectionNote}</p> : null}<NodeSummary nodes={nodes} /><details className="advanced-config"><summary>高级工作流映射</summary><label><span>节点绑定 JSON</span><textarea rows={4} value={bindingsText} onChange={(event) => setBindingsText(event.target.value)} /></label><label><span>动态参数 JSON</span><textarea rows={8} value={paramsText} onChange={(event) => setParamsText(event.target.value)} /></label></details></div> : null}
    <label className="check"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />设为默认 Provider</label>
    {error ? <p className="error">{error}</p> : null}<div className="form-actions">{editing ? <><button type="button" className="button danger" onClick={() => void remove(editing.id)}><Trash2 size={15} />删除</button><button type="button" className="button" onClick={() => void test(editing.id)} disabled={testing === editing.id}>{testing === editing.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}测试</button></> : null}<button className="button primary" type="submit">保存</button></div>
  </> : <div className="empty">选择或新增 Provider</div>}</form></div></section></div>;
}
