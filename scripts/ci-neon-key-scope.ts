/**
 * Prove that NEON_CI_API_KEY reaches only the CI Neon project, before
 * e2e-critical.yml uses it to create a branch (PR #586 review M3, the
 * security sign-off condition). Two-sided and fail-closed:
 *
 *   (i)  GET /projects answers 404 or 403 (a project-scoped key cannot list
 *        projects; Neon answers 404, run 39107806086), OR 200 with exactly
 *        one project whose id is NEON_CI_PROJECT_ID. Any other status (a 500,
 *        429, 503 or 401) proves nothing about the key's scope, so it fails;
 *   (ii) GET /projects/{NEON_CI_PROJECT_ID} answers 200 with that id.
 *
 * Both legs always run; anything else fails, including a network error. An
 * org-wide key fails (i); a wrong or revoked key fails (ii). Output is the
 * HTTP statuses, a project count and ok/fail: never the key, never a body,
 * never another project's id.
 *
 *   node --import tsx scripts/ci-neon-key-scope.ts   (env: NEON_API_KEY, PROJECT_ID)
 */
import { fileURLToPath } from 'node:url';

export interface ScopeResponse {
  readonly status: number;
  readonly body: unknown;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const API = 'https://console.neon.tech/api/v2';
/** Per request: a hung Neon API must not hang the job. */
const REQUEST_TIMEOUT_MS = 15_000;
/** The only listing refusals that mean "this key is scoped to one project". */
const SCOPED_LISTING_STATUSES = new Set([404, 403]);

function listedIds(body: unknown): string[] | null {
  const projects = (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) return null;
  return projects.map((p) => String((p as { id?: unknown } | null)?.id ?? ''));
}

export function keyScopeVerdict(
  list: ScopeResponse,
  project: ScopeResponse,
  projectId: string,
): { ok: boolean; reason: string } {
  if (projectId === '') return { ok: false, reason: 'NEON_CI_PROJECT_ID is empty' };

  // (i) the listing
  let listLeg: string;
  if (list.status === 200) {
    const ids = listedIds(list.body);
    if (ids === null) return { ok: false, reason: 'GET /projects answered 200 without a projects array' };
    if (ids.length !== 1 || ids[0] !== projectId) {
      return { ok: false, reason: `GET /projects lists ${ids.length} project(s), not exactly the CI project` };
    }
    listLeg = 'lists exactly the CI project';
  } else if (SCOPED_LISTING_STATUSES.has(list.status)) {
    listLeg = `cannot list projects (HTTP ${list.status}): a project-scoped key`;
  } else {
    return { ok: false, reason: `GET /projects answered HTTP ${list.status}, which proves nothing about the key's scope` };
  }

  // (ii) the CI project itself
  const ownId = (project.body as { project?: { id?: unknown } } | null)?.project?.id;
  if (project.status !== 200 || ownId !== projectId) {
    return { ok: false, reason: `GET /projects/{NEON_CI_PROJECT_ID} answered HTTP ${project.status} without that project` };
  }
  return { ok: true, reason: `${listLeg}; opens the CI project` };
}

async function get(fetchImpl: FetchLike, url: string, apiKey: string): Promise<ScopeResponse> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function checkKeyScope(deps: {
  apiKey: string;
  projectId: string;
  fetchImpl: FetchLike;
  log: (line: string) => void;
}): Promise<boolean> {
  const { apiKey, projectId, fetchImpl, log } = deps;
  if (apiKey === '' || projectId === '') {
    log('::error title=CI key scope::fail: NEON_CI_API_KEY and NEON_CI_PROJECT_ID are both required.');
    return false;
  }
  try {
    const list = await get(fetchImpl, `${API}/projects`, apiKey);
    const project = await get(fetchImpl, `${API}/projects/${encodeURIComponent(projectId)}`, apiKey);
    const verdict = keyScopeVerdict(list, project, projectId);
    if (!verdict.ok) {
      log(`::error title=CI key scope::fail: ${verdict.reason}.`);
      return false;
    }
    log(`CI key scope: ok (${verdict.reason}).`);
    return true;
  } catch (error) {
    // The message could echo a URL or header; report only the kind.
    const name = (error as { name?: unknown } | null)?.name;
    log(`::error title=CI key scope::fail: request error (${typeof name === 'string' ? name : 'unknown'}).`);
    return false;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('ci-neon-key-scope.ts'));

if (isMain) {
  void checkKeyScope({
    apiKey: process.env.NEON_API_KEY ?? '',
    projectId: process.env.PROJECT_ID ?? '',
    fetchImpl: (url, init) => fetch(url, init),
    log: (line) => console.log(line),
  }).then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
