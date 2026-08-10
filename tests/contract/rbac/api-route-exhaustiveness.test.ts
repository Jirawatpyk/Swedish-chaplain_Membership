/**
 * T016 — API route exhaustiveness (016-rbac-permissions PR 2, US2).
 *
 * Walks every `src/app/api/**​/route.ts`, extracts every exported handler, and
 * requires each one to resolve to exactly ONE expected-class. There is no
 * exempt list: a route added without a class fails the build, and a route
 * classified `role-matrix` that is missing from the frozen T015 baseline fails
 * too. That second rule is what stops a new staff surface from shipping
 * ungated — the class alone would be satisfiable by a comment.
 *
 * Classes (contracts/authorization-surfaces.md § 2):
 *   role-matrix        staff surface — carries a PermissionKey; in the baseline
 *   portal-member      member self-service (untouched by 016)
 *   cron-bearer        Vercel Cron, Bearer CRON_SECRET
 *   webhook-signature  Stripe / Resend / EventCreate signature-verified
 *   public             unauthenticated by design (sign-in, invite redeem, …)
 *   session-any        any authenticated session, no role differentiation
 *
 * `session-any` is an amendment to the contract's original five (see the
 * SESSION_ANY list below for the four handlers and why each one is genuinely
 * role-agnostic). Recorded so the class cannot become a dumping ground.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OBSERVED_BASELINE } from '../../helpers/rbac-observed-baseline';

const API_DIR = join(process.cwd(), 'src', 'app', 'api');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Next.js route-segment config exports — never request handlers. */
const CONFIG_EXPORTS = new Set([
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
  'config',
]);

/**
 * Non-handler functions a route file exports so a unit test can reach them.
 * Next.js ignores any export whose name is not a reserved method or config
 * key, so these are inert at runtime — but they must be named here rather than
 * waved through, otherwise a real handler added under an unrecognised name
 * (e.g. a lower-case `post`) would slip past this gate.
 */
const TEST_VISIBLE_EXPORTS = new Set([
  '/api/cron/invoicing/redact-expired-member-invoices::redactExpiredMemberDocumentsForTenant',
  '/api/webhooks/stripe::extractLatestChargeId',
  '/api/webhooks/stripe::reprojectDataObject',
]);

type ExpectedClass =
  | 'role-matrix'
  | 'portal-member'
  | 'cron-bearer'
  | 'webhook-signature'
  | 'public'
  | 'session-any';

interface Handler {
  readonly route: string;
  readonly method: string;
  /** `fn` | `alias:<ident>` | `call` — the export form the parser matched. */
  readonly form: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

/**
 * Extract exported handlers. Recognises the three forms the repo actually
 * uses — `export async function GET`, `export const GET = POST` (alias, the
 * Vercel-Cron GET/POST idiom), and `export const GET = withFoo(...)` (call).
 */
function parseHandlers(route: string, src: string): { handlers: Handler[]; unknownExports: string[] } {
  const handlers: Handler[] = [];
  const unknownExports: string[] = [];

  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  const constRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([A-Za-z_$][\w$]*)?/g;

  for (const m of src.matchAll(fnRe)) {
    const name = m[1]!;
    if ((HTTP_METHODS as readonly string[]).includes(name)) {
      handlers.push({ route, method: name, form: 'fn' });
    } else if (!CONFIG_EXPORTS.has(name) && !TEST_VISIBLE_EXPORTS.has(`${route}::${name}`)) {
      unknownExports.push(`${route} :: export function ${name}`);
    }
  }

  for (const m of src.matchAll(constRe)) {
    const name = m[1]!;
    const rhs = m[2];
    if ((HTTP_METHODS as readonly string[]).includes(name)) {
      handlers.push({
        route,
        method: name,
        form: rhs !== undefined && rhs !== '' ? `alias:${rhs}` : 'call',
      });
    } else if (!CONFIG_EXPORTS.has(name)) {
      unknownExports.push(`${route} :: export const ${name}`);
    }
  }

  return { handlers, unknownExports };
}

/**
 * Four handlers that serve every authenticated session identically, by design.
 * Each is listed with the reason it carries no role differentiation — this is
 * an allow-list of INTENT, not of convenience.
 */
const SESSION_ANY: Readonly<Record<string, string>> = {
  'POST /api/auth/change-password': 'self-service on auth:self — every role changes its own password',
  'POST /api/auth/heartbeat': 'session keep-alive — no resource is read or written',
  'POST /api/internal/client-error': 'client telemetry sink — no tenant data is read',
  'GET /api/broadcasts/templates':
    'deliberately shared member+staff template picker (F7.1a T110 header) — anonymous 401, no role branch',
};

/** Routes that are unauthenticated by design. */
const PUBLIC_ROUTES: readonly string[] = [
  '/api/auth/sign-in',
  '/api/auth/sign-out',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/redeem-invite',
  '/api/auth/email-verification/[token]',
  '/api/auth/email-change/revert/[token]',
];

function classify(h: Handler): ExpectedClass | null {
  const id = `${h.method} ${h.route}`;
  if (id in SESSION_ANY) return 'session-any';
  if (PUBLIC_ROUTES.includes(h.route)) return 'public';
  if (h.route.startsWith('/api/cron/')) return 'cron-bearer';
  if (h.route.startsWith('/api/webhooks/')) return 'webhook-signature';
  if (h.route.startsWith('/api/portal/')) return 'portal-member';
  if (h.route.startsWith('/api/member/')) return 'portal-member';
  if (h.route.startsWith('/api/broadcasts/')) return 'portal-member';
  if (h.route.startsWith('/api/payments/')) return 'portal-member';
  // `/api/internal/exports/**` is a staff surface and is deliberately matched
  // by the baseline lookup below, not by this prefix.
  if (h.route.startsWith('/api/internal/') && !h.route.startsWith('/api/internal/exports/')) {
    return 'cron-bearer';
  }
  if (BASELINE_IDS.has(id)) return 'role-matrix';
  return null;
}

const BASELINE_IDS = new Set(OBSERVED_BASELINE.filter((s) => s.kind === 'api').map((s) => s.surface));

const ALL: Handler[] = [];
const UNKNOWN_EXPORTS: string[] = [];
for (const file of walk(API_DIR)) {
  const src = readFileSync(file, 'utf8');
  const route =
    '/' + relative(join(process.cwd(), 'src', 'app'), file).replace(/\\/g, '/').replace(/\/route\.ts$/, '');
  const parsed = parseHandlers(route, src);
  ALL.push(...parsed.handlers);
  UNKNOWN_EXPORTS.push(...parsed.unknownExports);
}

describe('T016 API route exhaustiveness', () => {
  it('finds every route file and at least one handler in each', () => {
    const routes = new Set(ALL.map((h) => h.route));
    expect(routes.size).toBeGreaterThanOrEqual(211);
    const files = walk(API_DIR).length;
    expect(routes.size).toBe(files);
  });

  it('recognises the alias export form (export const GET = POST)', () => {
    // The Vercel-Cron migration made GET the invocation verb, so POST handlers
    // are re-exported as GET. A parser blind to this form would silently miss
    // ~40 handlers; assert the form is actually present and matched.
    const aliases = ALL.filter((h) => h.form.startsWith('alias:'));
    expect(aliases.length).toBeGreaterThan(0);
  });

  it('exports nothing that is neither an HTTP handler nor Next.js route config', () => {
    expect(UNKNOWN_EXPORTS).toEqual([]);
  });

  it('classifies every handler — no unclassified export', () => {
    const unclassified = ALL.filter((h) => classify(h) === null).map((h) => `${h.method} ${h.route}`);
    expect(unclassified).toEqual([]);
  });

  it('every role-matrix handler carries a frozen baseline row', () => {
    const missing = ALL.filter((h) => classify(h) === 'role-matrix' && !BASELINE_IDS.has(`${h.method} ${h.route}`));
    expect(missing.map((h) => `${h.method} ${h.route}`)).toEqual([]);
  });

  it('every baseline API row still corresponds to a live handler', () => {
    const live = new Set(ALL.map((h) => `${h.method} ${h.route}`));
    const stale = [...BASELINE_IDS].filter((id) => !live.has(id));
    expect(stale).toEqual([]);
  });

  it('the session-any allow-list is exactly the four documented handlers', () => {
    expect(Object.keys(SESSION_ANY)).toHaveLength(4);
    const applied = ALL.filter((h) => classify(h) === 'session-any').map((h) => `${h.method} ${h.route}`);
    expect(applied.sort()).toEqual(Object.keys(SESSION_ANY).sort());
  });

  it('no staff-looking route hides in a member/public class', () => {
    // /api/admin/** and /api/auth/users/** are staff by construction; they must
    // never resolve to anything but role-matrix.
    const misfiled = ALL.filter(
      (h) =>
        (h.route.startsWith('/api/admin/') || h.route.startsWith('/api/auth/users/')) &&
        classify(h) !== 'role-matrix',
    );
    expect(misfiled.map((h) => `${h.method} ${h.route} -> ${classify(h)}`)).toEqual([]);
  });
});
