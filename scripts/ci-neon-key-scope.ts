/** RED stub — implemented next. */
export interface ScopeResponse {
  readonly status: number;
  readonly body: unknown;
}

export function keyScopeVerdict(
  _list: ScopeResponse,
  _project: ScopeResponse,
  _projectId: string,
): { ok: boolean; reason: string } {
  throw new Error('not implemented');
}

export async function checkKeyScope(_deps: {
  apiKey: string;
  projectId: string;
  fetchImpl: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  log: (line: string) => void;
}): Promise<boolean> {
  throw new Error('not implemented');
}
