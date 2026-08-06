export type WorkflowParamValue = string | number | boolean;

export type WorkflowParam = {
  key: string;
  label: string;
  kind: 'text' | 'int' | 'float' | 'seed' | 'select' | 'boolean';
  binding: string;
  default?: WorkflowParamValue;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  options?: string[];
  group?: string;
};

export type WorkflowNode = {
  id: string;
  classType: string;
  title: string;
  inputKeys: string[];
};

export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  status: string;
  error: string;
  hasApiKey: boolean;
  type: string;
  hasConfig: boolean;
  params: WorkflowParam[];
  workflowNodes: WorkflowNode[];
  config?: string;
};

export type Asset = {
  id: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  source: string;
  status: string;
  createdAt: string;
};

export type Job = {
  id: string;
  providerId: string;
  inputAssetId: string | null;
  model: string;
  prompt: string;
  width: number;
  height: number;
  quality: string;
  format: string;
  count: number;
  status: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
  outputs: string[];
};

export type WorkflowInspection = {
  nodes: WorkflowNode[];
  params: WorkflowParam[];
  bindings: Record<string, string>;
  loraCount: number;
  metadataWarning?: string;
};
