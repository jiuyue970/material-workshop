export type Provider = { id: string; name: string; baseUrl: string; model: string; isDefault: boolean; status: string; error: string; hasApiKey: boolean };
export type Asset = { id: string; filename: string; mimeType: string; width: number; height: number; sizeBytes: number; source: string; status: string; createdAt: string };
export type Job = { id: string; providerId: string; model: string; prompt: string; width: number; height: number; quality: string; format: string; count: number; status: string; error: string; createdAt: string; finishedAt: string | null; outputs: string[] };
