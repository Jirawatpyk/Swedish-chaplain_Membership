/**
 * Post-deploy smoke (spec 123 US1, DW-2).
 *
 *   node scripts/post-deploy-smoke.ts https://<production-domain>
 *   BASE_URL=http://localhost:3400 node scripts/post-deploy-smoke.ts
 *
 * Checks, all public and read-only:
 *   admin-sign-in   GET /admin/sign-in  → 200 and the HTML holds a password input
 *   portal-sign-in  GET /portal/sign-in → 200 and the HTML holds a password input
 *   health          GET /api/health     → 200 and the body is exactly {"status":"ok"}
 *
 * The whole set is retried (3 attempts, 20 s apart in the CLI) to cover alias
 * lag right after a deploy. The CLI prints one line per check for the FINAL
 * attempt — `PASS <check> <status>` or `FAIL <check> <reason>` — and exits 1
 * on any FAIL. A response body is never printed: the lines end up in a GitHub
 * issue on a public repo. Retry notices go through `log` and never start with
 * `FAIL`, so the workflow can grep `^FAIL ` for the issue body.
 *
 * Zero dependencies (plain `fetch`), no `@/` imports, so it runs under plain
 * Node 22.18+ (type stripping is on by default; keep the TypeScript erasable — no
 * enums, no parameter properties, no namespaces). `pnpm exec tsx` also works.
 * Runbook: docs/runbooks/post-deploy-smoke.md.
 */
import { fileURLToPath } from 'node:url';

export interface SmokeOptions {
  readonly fetchImpl: typeof fetch;
  readonly attempts: number;
  readonly delayMs: number;
  readonly log: (line: string) => void;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

interface Check {
  readonly name: string;
  readonly path: string;
  /** Returns null when the body is acceptable, else a short reason suffix. */
  readonly judge: (body: string) => string | null;
}

const PASSWORD_INPUT = 'type="password"';
const HEALTH_OK_BODY = '{"status":"ok"}';
const REQUEST_TIMEOUT_MS = 15_000;

const CHECKS: readonly Check[] = [
  {
    name: 'admin-sign-in',
    path: '/admin/sign-in',
    judge: (body) => (body.includes(PASSWORD_INPUT) ? null : 'no-password-input'),
  },
  {
    name: 'portal-sign-in',
    path: '/portal/sign-in',
    judge: (body) => (body.includes(PASSWORD_INPUT) ? null : 'no-password-input'),
  },
  {
    name: 'health',
    path: '/api/health',
    judge: (body) => (body === HEALTH_OK_BODY ? null : 'unexpected-body'),
  },
];

/**
 * An http(s) URL with no credentials, else null. Only its ORIGIN is used:
 * `new URL('/api/health', base)` drops any path on the base, so pass the
 * origin (`PROD_BASE_URL` is documented as origin-only).
 */
function parseBaseUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

async function runCheck(base: URL, check: Check, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(check.path, base).toString(), {
      method: 'GET',
      // A redirect is a failure: every checked path must answer 200 itself.
      redirect: 'manual',
      headers: { 'user-agent': 'chamber-os-post-deploy-smoke' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return `FAIL ${check.name} network-error`;
  }
  if (res.status !== 200) {
    // Release the connection: an unread body keeps the socket busy until GC.
    await res.body?.cancel().catch(() => {});
    return `FAIL ${check.name} ${res.status}`;
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    return `FAIL ${check.name} 200-unreadable-body`;
  }
  const reason = check.judge(body);
  return reason === null ? `PASS ${check.name} 200` : `FAIL ${check.name} 200-${reason}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSmoke(baseUrl: string, options: SmokeOptions): Promise<SmokeResult> {
  const base = parseBaseUrl(baseUrl);
  if (base === null) return { ok: false, lines: ['FAIL base-url invalid'] };

  const attempts = Math.max(1, Math.floor(options.attempts));
  let lines: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lines = [];
    for (const check of CHECKS) {
      lines.push(await runCheck(base, check, options.fetchImpl));
    }
    const failed = lines.filter((l) => l.startsWith('FAIL ')).length;
    if (failed === 0) return { ok: true, lines };
    if (attempt < attempts) {
      options.log(
        `attempt ${attempt}/${attempts}: ${failed} check(s) failed, retrying in ${Math.round(options.delayMs / 1000)}s`,
      );
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }
  return { ok: false, lines };
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? process.env.BASE_URL ?? '';
  const result = await runSmoke(baseUrl, {
    fetchImpl: fetch,
    attempts: 3,
    delayMs: 20_000,
    log: (line) => console.log(line),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.ok ? 0 : 1;
}

const invokedDirectly =
  (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) ||
  process.argv[1]?.endsWith('post-deploy-smoke.ts') === true ||
  process.argv[1]?.endsWith('post-deploy-smoke.js') === true;

if (invokedDirectly) {
  main().catch(() => {
    // Never print the error: it can carry a URL or a response fragment.
    console.log('FAIL smoke internal-error');
    process.exitCode = 1;
  });
}
