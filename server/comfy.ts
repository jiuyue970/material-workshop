// ComfyUI Provider: bind a saved API-format workflow, inject task inputs, then
// execute it through /prompt -> /history -> /view.

type Primitive = string | number | boolean;
type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};
type WorkflowGraph = Record<string, WorkflowNode>;

export type ComfyProvider = { id: string; base_url: string; config: string };
export type ComfyJob = {
  id: string;
  prompt: string;
  width: number;
  height: number;
  count: number;
  provider_params?: string;
};
export type ComfyBinding = { node: string; path: string[] };
export type ComfyBindings = {
  prompt: ComfyBinding;
  seed: ComfyBinding;
  width: ComfyBinding;
  height: ComfyBinding;
  batch: ComfyBinding;
};
export type ComfyWorkflowParam = {
  key: string;
  label: string;
  kind: 'text' | 'int' | 'float' | 'boolean' | 'select' | 'seed';
  binding: string;
  default?: Primitive;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  placeholder?: string;
  group?: string;
};
export type ComfyWorkflowNodeInfo = {
  id: string;
  classType: string;
  title: string;
  inputKeys: string[];
};
export type ParsedComfyConfig = {
  workflow: WorkflowGraph;
  bindings: ComfyBindings;
  params: ComfyWorkflowParam[];
};

type ComfyWorkflowMetadata = {
  objectInfo?: Record<string, unknown>;
  loraModels?: string[];
};
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_BINDINGS: ComfyBindings = {
  prompt: { node: '271', path: ['string'] },
  seed: { node: '210', path: ['seed'] },
  width: { node: '264', path: ['width'] },
  height: { node: '264', path: ['height'] },
  batch: { node: '264', path: ['batch_size'] },
};
const COMMON_SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral',
  'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde',
  'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddpm', 'lcm', 'ipndm', 'deis',
];
const COMMON_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'];
const PARAM_KINDS = new Set<ComfyWorkflowParam['kind']>(['text', 'int', 'float', 'boolean', 'select', 'seed']);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const POLL_INTERVAL_MS = 2_000;
const JOB_TIMEOUT_MS = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isConnection(value: unknown): value is [string | number, number] {
  return Array.isArray(value)
    && value.length >= 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number';
}

function nodeTitle(node: WorkflowNode, id: string) {
  return String(node._meta?.title || node.class_type || `节点 ${id}`);
}

function assertSafePathSegment(value: string, context: string) {
  if (!value || value.length > 200 || FORBIDDEN_PATH_SEGMENTS.has(value)) {
    throw new Error(`${context}包含不安全的字段路径`);
  }
}

function parseBinding(value: unknown): ComfyBinding | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([^.]+)\.inputs\.(.+)$/.exec(value.trim());
  if (!match) return undefined;
  const node = match[1]!.trim();
  const path = match[2]!.split('.');
  try {
    assertSafePathSegment(node, '绑定');
    for (const segment of path) assertSafePathSegment(segment, '绑定');
  } catch {
    return undefined;
  }
  return { node, path };
}

function bindingString(binding: ComfyBinding) {
  return `${binding.node}.inputs.${binding.path.join('.')}`;
}

function inputBinding(node: string, key: string): ComfyBinding {
  return { node, path: [key] };
}

export function parseComfyWorkflow(raw: unknown): WorkflowGraph {
  const value = typeof raw === 'string'
    ? (() => {
      try { return JSON.parse(raw) as unknown; }
      catch { throw new Error('ComfyUI 工作流不是合法 JSON'); }
    })()
    : raw;
  if (!isRecord(value)) throw new Error('ComfyUI Provider 缺少 workflow 对象（需要 API 格式工作流）');
  if (!Object.keys(value).length) throw new Error('ComfyUI 工作流为空');
  for (const [id, node] of Object.entries(value)) {
    assertSafePathSegment(id, '工作流节点');
    if (!isRecord(node)) throw new Error(`ComfyUI 工作流节点 ${id} 不是对象`);
    if (node.inputs !== undefined && !isRecord(node.inputs)) throw new Error(`ComfyUI 工作流节点 ${id} 的 inputs 不是对象`);
  }
  return value as WorkflowGraph;
}

export function describeComfyWorkflow(raw: unknown): ComfyWorkflowNodeInfo[] {
  const graph = parseComfyWorkflow(raw);
  return Object.entries(graph).map(([id, node]) => ({
    id,
    classType: node.class_type || '',
    title: nodeTitle(node, id),
    inputKeys: Object.entries(node.inputs ?? {})
      .filter(([, value]) => !isConnection(value))
      .map(([key]) => key),
  }));
}

function findScalarInput(graph: WorkflowGraph, keys: string[], matcher?: (id: string, node: WorkflowNode) => boolean) {
  for (const [id, node] of Object.entries(graph)) {
    if (matcher && !matcher(id, node)) continue;
    for (const key of keys) {
      if (scalar(node.inputs?.[key])) return inputBinding(id, key);
    }
  }
  return undefined;
}

export function inferComfyBindings(raw: unknown): Partial<ComfyBindings> {
  const graph = parseComfyWorkflow(raw);
  const entries = Object.entries(graph);
  const preferred = (predicate: (id: string, node: WorkflowNode) => boolean, keys: string[]) => findScalarInput(graph, keys, predicate);
  const latent = entries.find(([, node]) => /emptylatent|latent/i.test(`${node.class_type} ${node._meta?.title}`)
    && scalar(node.inputs?.width) && scalar(node.inputs?.height));
  const seed = preferred((_, node) => /seed|ksampler/i.test(`${node.class_type} ${node._meta?.title}`), ['seed']);
  const prompt = preferred((_, node) => /string literal|prompt|positive/i.test(`${node.class_type} ${node._meta?.title}`), ['string', 'prompt', 'positive', 'text'])
    ?? findScalarInput(graph, ['string', 'prompt', 'positive', 'text']);
  const inferred: Partial<ComfyBindings> = {};
  if (prompt) inferred.prompt = prompt;
  if (seed) inferred.seed = seed;
  if (latent) {
    inferred.width = inputBinding(latent[0], 'width');
    inferred.height = inputBinding(latent[0], 'height');
    if (scalar(latent[1].inputs?.batch_size)) inferred.batch = inputBinding(latent[0], 'batch_size');
  }
  return inferred;
}

export function resolveComfyBindings(overrides: unknown, workflow: unknown): ComfyBindings {
  if (overrides !== undefined && !isRecord(overrides)) throw new Error('ComfyUI bindings 必须是对象');
  const inferred = inferComfyBindings(workflow);
  const bindings = { ...DEFAULT_BINDINGS, ...inferred };
  for (const key of Object.keys(bindings) as Array<keyof ComfyBindings>) {
    const override = (overrides as Record<string, unknown> | undefined)?.[key];
    if (override !== undefined) {
      const parsed = parseBinding(override);
      if (!parsed) throw new Error(`ComfyUI 绑定 ${key} 无效，应为 node.inputs.field 格式`);
      bindings[key] = parsed;
    }
  }
  return bindings;
}

function optionalFiniteNumber(value: unknown, field: string, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数「${label}」的 ${field} 必须是有限数字`);
  return value;
}

function coerceParamValue(param: ComfyWorkflowParam, raw: Primitive): Primitive {
  if (param.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === 0 || raw === '0' || raw === 'false' || raw === 'off') return false;
    throw new Error(`参数「${param.label}」需要布尔值`);
  }
  if (param.kind === 'int' || param.kind === 'seed') {
    if (typeof raw === 'boolean' || (typeof raw === 'string' && !raw.trim())) throw new Error(`参数「${param.label}」需要整数`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`参数「${param.label}」需要安全整数`);
    return value;
  }
  if (param.kind === 'float') {
    if (typeof raw === 'boolean' || (typeof raw === 'string' && !raw.trim())) throw new Error(`参数「${param.label}」需要数字`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`参数「${param.label}」需要数字`);
    return value;
  }
  if (typeof raw !== 'string') throw new Error(`参数「${param.label}」需要文本`);
  return raw;
}

function assertParamValue(param: ComfyWorkflowParam, raw: Primitive) {
  const value = coerceParamValue(param, raw);
  if (typeof value === 'number') {
    if (param.min !== undefined && value < param.min) throw new Error(`参数「${param.label}」不能小于 ${param.min}`);
    if (param.max !== undefined && value > param.max) throw new Error(`参数「${param.label}」不能大于 ${param.max}`);
  }
  if (param.kind === 'select' && !param.options?.includes(String(value))) {
    throw new Error(`参数「${param.label}」不是允许的选项`);
  }
  return value;
}

function parseWorkflowParams(raw: unknown): ComfyWorkflowParam[] {
  if (!Array.isArray(raw)) throw new Error('ComfyUI params 必须是数组');
  if (raw.length > 160) throw new Error('ComfyUI params 最多允许 160 项');
  const keys = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`ComfyUI params[${index}] 必须是对象`);
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const kind = item.kind;
    const binding = typeof item.binding === 'string' ? item.binding.trim() : '';
    if (!key || key.length > 100 || FORBIDDEN_PATH_SEGMENTS.has(key)) throw new Error(`ComfyUI params[${index}] 的 key 无效`);
    if (keys.has(key)) throw new Error(`ComfyUI 参数 key 重复：${key}`);
    keys.add(key);
    if (!label || label.length > 120) throw new Error(`ComfyUI 参数 ${key} 的 label 无效`);
    if (typeof kind !== 'string' || !PARAM_KINDS.has(kind as ComfyWorkflowParam['kind'])) throw new Error(`ComfyUI 参数「${label}」的 kind 无效`);
    if (!parseBinding(binding)) throw new Error(`ComfyUI 参数「${label}」的 binding 无效`);
    const min = optionalFiniteNumber(item.min, 'min', label);
    const max = optionalFiniteNumber(item.max, 'max', label);
    const step = optionalFiniteNumber(item.step, 'step', label);
    if (min !== undefined && max !== undefined && min > max) throw new Error(`参数「${label}」的 min 不能大于 max`);
    if (step !== undefined && step <= 0) throw new Error(`参数「${label}」的 step 必须大于 0`);
    const options = item.options === undefined
      ? undefined
      : Array.isArray(item.options) && item.options.every((value) => typeof value === 'string')
        ? [...new Set(item.options)]
        : (() => { throw new Error(`参数「${label}」的 options 必须是字符串数组`); })();
    if (kind === 'select' && (!options || !options.length)) throw new Error(`参数「${label}」缺少可选项`);
    const param: ComfyWorkflowParam = {
      key,
      label,
      kind: kind as ComfyWorkflowParam['kind'],
      binding,
      ...(item.default !== undefined ? { default: item.default as Primitive } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(options ? { options } : {}),
      ...(typeof item.placeholder === 'string' ? { placeholder: item.placeholder.slice(0, 300) } : {}),
      ...(typeof item.group === 'string' ? { group: item.group.slice(0, 100) } : {}),
    };
    if (item.default !== undefined) {
      if (!scalar(item.default)) throw new Error(`参数「${label}」的 default 必须是字符串、数字或布尔值`);
      param.default = assertParamValue(param, item.default);
    }
    return param;
  });
}

function addParam(params: ComfyWorkflowParam[], keys: Set<string>, param: ComfyWorkflowParam) {
  if (keys.has(param.key)) return;
  keys.add(param.key);
  params.push(param);
}

function numericParam(
  params: ComfyWorkflowParam[],
  keys: Set<string>,
  input: { node: string; path: string[]; value: number },
  key: string,
  label: string,
  group: string,
  options: Partial<ComfyWorkflowParam> = {},
) {
  const kind = options.kind === 'float' || options.kind === 'int'
    ? options.kind
    : Number.isInteger(input.value) ? 'int' : 'float';
  const { kind: _kind, ...rest } = options;
  addParam(params, keys, {
    key,
    label,
    kind,
    binding: bindingString({ node: input.node, path: input.path }),
    default: input.value,
    group,
    ...(kind === 'int' ? { min: 1, max: 200, step: 1 } : { min: 0, max: 1, step: 0.01 }),
    ...rest,
  });
}

function applyComfyMetadata(graph: WorkflowGraph, params: ComfyWorkflowParam[], metadata: ComfyWorkflowMetadata) {
  const loraOptions = [...new Set((metadata.loraModels ?? []).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  return params.map((param) => {
    const binding = parseBinding(param.binding);
    if (!binding) return param;
    if (/^lora_\d+$/.test(binding.path[0] ?? '') && binding.path[1] === 'lora' && loraOptions.length) {
      const current = typeof param.default === 'string' ? param.default : '';
      return { ...param, kind: 'select' as const, options: ['', ...new Set(current ? [current, ...loraOptions] : loraOptions)] };
    }
    const classType = graph[binding.node]?.class_type;
    const classInfo = classType ? metadata.objectInfo?.[classType] : undefined;
    if (!isRecord(classInfo)) return param;
    const input = isRecord(classInfo.input) ? classInfo.input : undefined;
    const required = isRecord(input?.required) ? input.required : undefined;
    const optional = isRecord(input?.optional) ? input.optional : undefined;
    const spec = required?.[binding.path[0]!] ?? optional?.[binding.path[0]!];
    if (!Array.isArray(spec)) return param;
    const type = spec[0];
    const config = isRecord(spec[1]) ? spec[1] : {};
    if (Array.isArray(type)) {
      const options = type.filter((value): value is string => typeof value === 'string');
      return options.length ? { ...param, kind: 'select' as const, options } : param;
    }
    const range = {
      ...(typeof config.min === 'number' && Number.isFinite(config.min) ? { min: config.min } : {}),
      ...(typeof config.max === 'number' && Number.isFinite(config.max) ? { max: config.max } : {}),
      ...(typeof config.step === 'number' && Number.isFinite(config.step) && config.step > 0 ? { step: config.step } : {}),
    };
    if (type === 'FLOAT') return { ...param, kind: 'float' as const, ...range };
    if (type === 'INT' && param.kind !== 'seed') return { ...param, kind: 'int' as const, ...range };
    if (type === 'BOOLEAN') return { ...param, kind: 'boolean' as const };
    return param;
  });
}

export function inferComfyWorkflowParams(raw: unknown, metadata: ComfyWorkflowMetadata = {}): ComfyWorkflowParam[] {
  const graph = parseComfyWorkflow(raw);
  const params: ComfyWorkflowParam[] = [];
  const keys = new Set<string>();
  const inferredBindings = inferComfyBindings(graph);
  if (inferredBindings.seed) {
    const seedValue = graph[inferredBindings.seed.node]?.inputs?.[inferredBindings.seed.path[0]!];
    addParam(params, keys, {
      key: 'seed',
      label: 'Seed',
      kind: 'seed',
      binding: bindingString(inferredBindings.seed),
      ...(typeof seedValue === 'number' ? { placeholder: String(Math.trunc(seedValue)) } : {}),
      group: '基础采样',
    });
  }
  const samplers = new Set(COMMON_SAMPLERS);
  const schedulers = new Set(COMMON_SCHEDULERS);
  const samplerNodes = Object.entries(graph).filter(([, node]) => /ksampler|采样器/i.test(`${node.class_type} ${node._meta?.title}`));
  samplerNodes.forEach(([id, node], index) => {
    const inputs = node.inputs ?? {};
    const group = index === 0 ? '基础采样' : `细化采样 ${index}`;
    const prefix = index === 0 ? '' : `refine_${index}_`;
    if (typeof inputs.steps === 'number') numericParam(params, keys, { node: id, path: ['steps'], value: inputs.steps }, `${prefix}steps`, index === 0 ? 'Steps' : `Refine Steps ${index}`, group, { min: 1, max: 200 });
    if (typeof inputs.cfg === 'number') numericParam(params, keys, { node: id, path: ['cfg'], value: inputs.cfg }, `${prefix}cfg`, index === 0 ? 'CFG' : `Refine CFG ${index}`, group, { kind: 'float', min: 0, max: 30, step: 0.1 });
    if (typeof inputs.sampler_name === 'string') {
      samplers.add(inputs.sampler_name);
      addParam(params, keys, { key: `${prefix}sampler`, label: index === 0 ? 'Sampler' : `Refine Sampler ${index}`, kind: 'select', binding: bindingString(inputBinding(id, 'sampler_name')), default: inputs.sampler_name, options: [...samplers], group });
    }
    if (typeof inputs.scheduler === 'string') {
      schedulers.add(inputs.scheduler);
      addParam(params, keys, { key: `${prefix}scheduler`, label: index === 0 ? 'Scheduler' : `Refine Scheduler ${index}`, kind: 'select', binding: bindingString(inputBinding(id, 'scheduler')), default: inputs.scheduler, options: [...schedulers], group });
    }
    if (typeof inputs.denoise === 'number') numericParam(params, keys, { node: id, path: ['denoise'], value: inputs.denoise }, `${prefix}denoise`, index === 0 ? 'Denoise' : `Refine Denoise ${index}`, group, { kind: 'float', min: 0, max: 1, step: 0.01 });
  });
  for (const [id, node] of Object.entries(graph)) {
    const title = nodeTitle(node, id);
    const inputs = node.inputs ?? {};
    if (/resize|尺寸|缩放/i.test(`${node.class_type} ${title}`) && typeof inputs.target_size === 'number') {
      numericParam(params, keys, { node: id, path: ['target_size'], value: inputs.target_size }, 'output_size', '输出尺寸', '输出', { min: 64, max: 8192, step: 64 });
    }
    if (/lora/i.test(`${node.class_type} ${title}`)) {
      for (const [slot, value] of Object.entries(inputs)) {
        if (!/^lora_\d+$/.test(slot) || !isRecord(value)) continue;
        const number = slot.slice('lora_'.length);
        const currentName = typeof value.lora === 'string' ? value.lora : '';
        addParam(params, keys, { key: `${slot}_enabled`, label: `LoRA ${number} 启用`, kind: 'boolean', binding: bindingString({ node: id, path: [slot, 'on'] }), default: value.on === true, group: 'LoRA' });
        addParam(params, keys, { key: `${slot}_name`, label: `LoRA ${number} 文件`, kind: 'text', binding: bindingString({ node: id, path: [slot, 'lora'] }), default: currentName, placeholder: currentName || '填写 ComfyUI 中的 LoRA 文件名', group: 'LoRA' });
        if (typeof value.strength === 'number') numericParam(params, keys, { node: id, path: [slot, 'strength'], value: value.strength }, `${slot}_strength`, `LoRA ${number} 强度`, 'LoRA', { kind: 'float', min: -10, max: 10, step: 0.05 });
      }
    }
  }
  const groupOrder = (group?: string) => group === '基础采样' ? 0 : group?.startsWith('细化采样') ? 1 : group === '输出' ? 2 : group === 'LoRA' ? 3 : 4;
  params.sort((left, right) => groupOrder(left.group) - groupOrder(right.group));
  return applyComfyMetadata(graph, params.slice(0, 160), metadata);
}

function parseConfigObject(config: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(config); }
  catch { throw new Error('ComfyUI Provider 的 config 不是合法 JSON'); }
  if (!isRecord(parsed)) throw new Error('ComfyUI Provider 的 config 必须是对象');
  return parsed;
}

export function parseComfyConfig(config: string): ParsedComfyConfig {
  const parsed = parseConfigObject(config);
  const workflow = parseComfyWorkflow(parsed.workflow);
  const bindings = resolveComfyBindings(parsed.bindings, workflow);
  const params = parsed.params === undefined ? inferComfyWorkflowParams(workflow) : parseWorkflowParams(parsed.params);
  for (const [key, binding] of Object.entries(bindings)) {
    if (!Object.hasOwn(workflow, binding.node)) throw new Error(`ComfyUI 核心绑定 ${key} 指向不存在的节点 ${binding.node}`);
  }
  for (const param of params) {
    const binding = parseBinding(param.binding)!;
    if (!Object.hasOwn(workflow, binding.node)) throw new Error(`参数「${param.label}」指向不存在的节点 ${binding.node}`);
  }
  return { workflow, bindings, params };
}

export function normalizeComfyConfig(config: string) {
  const original = parseConfigObject(config);
  const parsed = parseComfyConfig(config);
  return JSON.stringify({
    ...original,
    workflow: parsed.workflow,
    bindings: Object.fromEntries(Object.entries(parsed.bindings).map(([key, binding]) => [key, bindingString(binding)])),
    params: parsed.params,
  });
}

export function summarizeComfyConfig(config: string) {
  const parsed = parseComfyConfig(config);
  return { params: parsed.params, workflowNodes: describeComfyWorkflow(parsed.workflow) };
}

function setInput(graph: WorkflowGraph, binding: ComfyBinding, value: unknown) {
  assertSafePathSegment(binding.node, '绑定');
  for (const segment of binding.path) assertSafePathSegment(segment, '绑定');
  if (!Object.hasOwn(graph, binding.node)) {
    throw new Error(`工作流中不存在节点 ${binding.node}（绑定 ${bindingString(binding)}）`);
  }
  const node = graph[binding.node]!;
  const inputs = (node.inputs ??= {});
  let target: Record<string, unknown> = inputs;
  for (const key of binding.path.slice(0, -1)) {
    const next = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isRecord(next)) target = next;
    else {
      const created: Record<string, unknown> = {};
      target[key] = created;
      target = created;
    }
  }
  target[binding.path.at(-1)!] = value;
}

export function validateWorkflowParamValues(declarations: ComfyWorkflowParam[], values: Record<string, Primitive>) {
  const declarationsByKey = new Map(declarations.map((param) => [param.key, param]));
  const result: Record<string, Primitive> = {};
  for (const key of Object.keys(values)) {
    const declaration = declarationsByKey.get(key);
    if (!declaration) throw new Error(`未知的 ComfyUI 工作流参数：${key}`);
    const raw = values[key];
    if (!scalar(raw)) throw new Error(`参数「${declaration.label}」必须是字符串、数字或布尔值`);
    result[key] = assertParamValue(declaration, raw);
  }
  return result;
}

export function applyWorkflowParams(graph: WorkflowGraph, declarations: ComfyWorkflowParam[], rawValues: Record<string, Primitive>) {
  const values = validateWorkflowParamValues(declarations, rawValues);
  for (const param of declarations) {
    const binding = parseBinding(param.binding);
    if (!binding) throw new Error(`参数「${param.label}」的绑定无效：${param.binding}`);
    const supplied = Object.hasOwn(values, param.key);
    if (param.kind === 'seed' && !supplied) continue;
    const value = supplied ? values[param.key] : param.default;
    if (value === undefined) continue;
    setInput(graph, binding, value);
    const slot = /^lora_\d+$/.test(binding.path[0] ?? '') ? binding.path[0]! : undefined;
    if (supplied && slot && binding.path[1] === 'lora' && !Object.hasOwn(values, `${slot}_enabled`)) {
      setInput(graph, { node: binding.node, path: [slot, 'on'] }, Boolean(String(value).trim()));
    }
  }
}

export function buildComfyPromptGraph(job: ComfyJob, config: string, providerParams: Record<string, Primitive> = {}) {
  const { workflow, bindings, params } = parseComfyConfig(config);
  const graph = structuredClone(workflow);
  setInput(graph, bindings.prompt, job.prompt);
  setInput(graph, bindings.width, job.width);
  setInput(graph, bindings.height, job.height);
  setInput(graph, bindings.seed, Math.floor(Math.random() * 2 ** 31));
  setInput(graph, bindings.batch, job.count);
  applyWorkflowParams(graph, params, providerParams);
  return graph;
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function inspectComfyWorkflow(baseUrl: string, workflow: unknown, request: Fetcher = fetch) {
  const graph = parseComfyWorkflow(workflow);
  const [objectInfoResult, loraResult] = await Promise.allSettled([
    request(endpoint(baseUrl, '/object_info'), { signal: AbortSignal.timeout(30_000) }).then(async (response) => {
      if (!response.ok) throw new Error(`/object_info 返回 HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!isRecord(payload)) throw new Error('/object_info 返回格式无效');
      return payload;
    }),
    request(endpoint(baseUrl, '/models/loras'), { signal: AbortSignal.timeout(30_000) }).then(async (response) => {
      if (!response.ok) throw new Error(`/models/loras 返回 HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error('/models/loras 返回格式无效');
      return payload.filter((value): value is string => typeof value === 'string');
    }),
  ]);
  const objectInfo = objectInfoResult.status === 'fulfilled' ? objectInfoResult.value : undefined;
  const loraModels = loraResult.status === 'fulfilled' ? loraResult.value : undefined;
  const warnings: string[] = [];
  if (objectInfoResult.status === 'rejected') warnings.push(`节点元数据读取失败：${errorMessage(objectInfoResult.reason)}`);
  if (loraResult.status === 'rejected') warnings.push(`LoRA 列表读取失败：${errorMessage(loraResult.reason)}`);
  const inferred = inferComfyBindings(graph);
  return {
    nodes: describeComfyWorkflow(graph),
    params: inferComfyWorkflowParams(graph, { objectInfo, loraModels }),
    bindings: Object.fromEntries(Object.entries(inferred).map(([key, binding]) => [key, bindingString(binding!)])),
    loraCount: loraModels?.length ?? 0,
    ...(warnings.length ? { metadataWarning: `${warnings.join('；')}。已使用工作流本身进行离线推断。` } : {}),
  };
}

export async function testComfy(baseUrl: string) {
  const response = await fetch(endpoint(baseUrl, '/system_stats'), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ComfyUI 返回 HTTP ${response.status}`);
}

async function submitPrompt(baseUrl: string, workflow: unknown): Promise<string> {
  const response = await fetch(endpoint(baseUrl, '/prompt'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    prompt_id?: string;
    error?: { message?: string };
    node_errors?: Record<string, { errors?: Array<{ message?: string }> }>;
  };
  if (!response.ok || !payload.prompt_id) {
    const nodeMessages = Object.values(payload.node_errors ?? {})
      .flatMap((node) => (node.errors ?? []).map((error) => error.message).filter(Boolean));
    const message = payload.error?.message || nodeMessages.join('；') || `ComfyUI 返回 HTTP ${response.status}`;
    throw new Error(`ComfyUI 校验失败: ${message}`);
  }
  return payload.prompt_id;
}

type HistoryEntry = {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, { exception_message?: string }?]> };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
};

async function waitResult(baseUrl: string, promptId: string): Promise<HistoryEntry> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(endpoint(baseUrl, `/history/${promptId}`), { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const history = await response.json() as Record<string, HistoryEntry>;
      const entry = history[promptId];
      if (entry) {
        if (entry.status?.status_str === 'error') {
          const detail = (entry.status.messages ?? [])
            .filter(([kind]) => kind === 'execution_error')
            .map(([, info]) => info?.exception_message)
            .filter(Boolean)
            .join('；');
          throw new Error(`ComfyUI 执行失败: ${detail || '未知错误'}`);
        }
        if (entry.status?.completed !== false) return entry;
      }
    }
    if (Date.now() > deadline) throw new Error('ComfyUI 出图超时（10 分钟）');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function downloadImages(baseUrl: string, entry: HistoryEntry): Promise<Buffer[]> {
  const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
  const outputs = images.filter((image) => image.type === 'output');
  const targets = outputs.length ? outputs : images;
  const buffers: Buffer[] = [];
  for (const image of targets) {
    const url = endpoint(baseUrl, `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${encodeURIComponent(image.type ?? 'output')}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`下载 ComfyUI 产物失败: HTTP ${response.status}`);
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }
  if (!buffers.length) throw new Error('ComfyUI 未产出图片');
  return buffers;
}

export async function runComfyJob(job: ComfyJob, provider: ComfyProvider, providerParams: Record<string, Primitive> = {}): Promise<Buffer[]> {
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const graph = buildComfyPromptGraph(job, provider.config, providerParams);
  const promptId = await submitPrompt(baseUrl, graph);
  const entry = await waitResult(baseUrl, promptId);
  return downloadImages(baseUrl, entry);
}
