export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers); if (options?.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers }); const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data as T;
}
export const json = (value: unknown) => ({ body: JSON.stringify(value) });
