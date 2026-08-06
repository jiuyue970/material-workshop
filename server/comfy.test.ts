import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildComfyPromptGraph,
  describeComfyWorkflow,
  inferComfyWorkflowParams,
  inspectComfyWorkflow,
  normalizeComfyConfig,
  parseComfyConfig,
  validateWorkflowParamValues,
} from './comfy.js';

let workflow: Record<string, { inputs?: Record<string, unknown> }>;

beforeAll(async () => {
  workflow = JSON.parse(await readFile(new URL('../workflows/创作方案.json', import.meta.url), 'utf8')) as typeof workflow;
});

describe('ComfyUI workflow inspection', () => {
  it('describes the saved workflow and infers its editable controls', () => {
    const nodes = describeComfyWorkflow(workflow);
    const params = inferComfyWorkflowParams(workflow);

    expect(nodes).toHaveLength(18);
    expect(params).toHaveLength(90);
    expect(params.find((param) => param.key === 'steps')).toMatchObject({ binding: '254.inputs.steps', group: '基础采样' });
    expect(params.find((param) => param.key === 'output_size')).toMatchObject({ binding: '285.inputs.target_size', default: 4096 });
    expect(params.find((param) => param.key === 'lora_26_strength')).toMatchObject({ binding: '266.inputs.lora_26.strength' });
    expect(nodes.find((node) => node.id === '254')?.inputKeys).toContain('steps');
    expect(nodes.find((node) => node.id === '254')?.inputKeys).not.toContain('model');
  });

  it('normalizes missing bindings and params into provider config', () => {
    const normalized = JSON.parse(normalizeComfyConfig(JSON.stringify({ workflow }))) as {
      bindings: Record<string, string>;
      params: unknown[];
      workflow: unknown;
    };

    expect(normalized.workflow).toEqual(workflow);
    expect(normalized.bindings).toMatchObject({
      prompt: '271.inputs.string',
      seed: '210.inputs.seed',
      width: '264.inputs.width',
      height: '264.inputs.height',
      batch: '264.inputs.batch_size',
    });
    expect(normalized.params).toHaveLength(90);
  });

  it('uses live object metadata and LoRA model names when available', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/models/loras')) return new Response(JSON.stringify(['one.safetensors', 'two.safetensors']));
      return new Response(JSON.stringify({
        KSampler: {
          input: {
            required: {
              steps: ['INT', { min: 2, max: 80, step: 2 }],
              sampler_name: [['live_sampler', 'other_sampler']],
            },
          },
        },
      }));
    });

    const result = await inspectComfyWorkflow('http://127.0.0.1:8188', workflow, request);

    expect(result.loraCount).toBe(2);
    expect(result.metadataWarning).toBeUndefined();
    expect(result.params.find((param) => param.key === 'steps')).toMatchObject({ min: 2, max: 80, step: 2 });
    expect(result.params.find((param) => param.key === 'sampler')).toMatchObject({ kind: 'select', options: ['live_sampler', 'other_sampler'] });
    expect(result.params.find((param) => param.key === 'lora_1_name')).toMatchObject({
      kind: 'select',
      options: expect.arrayContaining(['one.safetensors', 'two.safetensors']),
    });
  });

  it('falls back to offline inference when ComfyUI metadata is unavailable', async () => {
    const request = vi.fn(async () => { throw new Error('connection refused'); });

    const result = await inspectComfyWorkflow('http://127.0.0.1:8188', workflow, request);

    expect(result.nodes).toHaveLength(18);
    expect(result.params).toHaveLength(90);
    expect(result.bindings.prompt).toBe('271.inputs.string');
    expect(result.loraCount).toBe(0);
    expect(result.metadataWarning).toContain('离线推断');
  });
});

describe('ComfyUI parameter application and validation', () => {
  it('applies dynamic values after core task inputs', () => {
    const config = normalizeComfyConfig(JSON.stringify({
      workflow,
      params: [
        { key: 'forced_width', label: '覆盖宽度', kind: 'int', binding: '264.inputs.width', min: 256, max: 4096 },
        { key: 'steps', label: 'Steps', kind: 'int', binding: '254.inputs.steps', min: 1, max: 200 },
        { key: 'lora_1_name', label: 'LoRA 1 文件', kind: 'text', binding: '266.inputs.lora_1.lora' },
      ],
    }));
    const graph = buildComfyPromptGraph({ id: 'job', prompt: 'new prompt', width: 512, height: 768, count: 3 }, config, {
      forced_width: 1024,
      steps: 8,
      lora_1_name: 'custom.safetensors',
    });

    expect(graph['271']?.inputs?.string).toBe('new prompt');
    expect(graph['264']?.inputs).toMatchObject({ width: 1024, height: 768, batch_size: 3 });
    expect(graph['254']?.inputs?.steps).toBe(8);
    expect(graph['266']?.inputs?.lora_1).toMatchObject({ lora: 'custom.safetensors', on: true });
  });

  it('does not enable LoRA slots merely because the workflow has default file names', () => {
    const config = normalizeComfyConfig(JSON.stringify({ workflow }));
    const graph = buildComfyPromptGraph({ id: 'job', prompt: 'prompt', width: 512, height: 768, count: 1 }, config);

    expect(graph['266']?.inputs?.lora_1).toMatchObject({
      lora: 'krea2_lora_ 布丁.safetensors',
      on: false,
    });
  });

  it('rejects unknown keys, out-of-range numbers, and invalid selections', () => {
    const declarations = parseComfyConfig(normalizeComfyConfig(JSON.stringify({ workflow }))).params;

    expect(() => validateWorkflowParamValues(declarations, { unexpected: true })).toThrow('未知的 ComfyUI 工作流参数');
    expect(() => validateWorkflowParamValues(declarations, { steps: 0 })).toThrow('不能小于 1');
    expect(() => validateWorkflowParamValues(declarations, { sampler: 'not-a-sampler' })).toThrow('不是允许的选项');
  });

  it('rejects unsafe nested bindings without polluting object prototypes', () => {
    expect(() => normalizeComfyConfig(JSON.stringify({
      workflow,
      params: [{ key: 'attack', label: 'Attack', kind: 'text', binding: '266.inputs.__proto__.polluted' }],
    }))).toThrow('binding 无效');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('rejects bindings to nodes that are not in the bound workflow', () => {
    expect(() => normalizeComfyConfig(JSON.stringify({
      workflow,
      bindings: { prompt: 'missing.inputs.text' },
    }))).toThrow('指向不存在的节点 missing');
    expect(() => normalizeComfyConfig(JSON.stringify({
      workflow,
      params: [{ key: 'missing', label: 'Missing', kind: 'text', binding: 'missing.inputs.value' }],
    }))).toThrow('指向不存在的节点 missing');
  });
});
