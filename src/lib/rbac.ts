/**
 * RBAC v2 composition root (016-rbac-permissions T021).
 *
 * The GATE composition root: supplies the session, the audit sink, the metric
 * counter, and the request metadata the denial trail needs. PR 5 (T068)
 * deleted the `FEATURE_RBAC_V2` flag and the legacy-shim argument — the
 * evaluator is single-leg and every gate takes just the permission key.
 *
 * Every staff surface calls exactly one of:
 *
 *   const { user } = await requirePagePermission('members.read');
 *
 *   const ctx = await requireApiPermission(request, 'members.write');
 *   if ('response' in ctx) return ctx.response;   // 401 or 403
 *
 * The API result shape is deliberately identical to the old
 * `requireAdminContext`'s, which is what made the PR-2 sweep mechanical.
 *
 * ## Denial semantics
 *
 * Pages 404 (`notFound()`), APIs 403 — a page must not confirm that a surface
 * it cannot serve exists. Anonymous callers get 401 BEFORE any permission
 * evaluation so an unauthenticated probe cannot distinguish "route exists but
 * you lack the permission" from "no such route" (the enumeration-safety
 * ordering `requireAdminContext` already establishes).
 *
 * The denial audit is FAIL-OPEN: if the append throws, the 404/403 is still
 * served. An `audit_log` outage must never become an authorization bypass,
 * and must never become a 500 either.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getCurrentSession, type CurrentSession } from '@/lib/auth-session';
import { getClientIp } from '@/lib/client-ip';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { authMetrics, type PermissionDeniedLabels } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import type { Role } from '@/modules/auth/domain/role';
import type { UserId } from '@/modules/auth/domain/branded';

/** Injection seam — production values live in `defaultDeps` below. */
export interface RbacDeps {
  readonly getSession: () => Promise<CurrentSession | null>;
  readonly audit: { readonly append: (event: DenialAuditEvent) => Promise<void> };
  readonly countDenied: (labels: PermissionDeniedLabels) => void;
  /** Current route path WITHOUT the query string. */
  readonly routePath: (request?: NextRequest) => Promise<string> | string;
  readonly requestId: (request?: NextRequest) => Promise<string> | string;
  readonly sourceIp: (request?: NextRequest) => string | null;
}

export interface DenialAuditEvent {
  readonly eventType: 'permission_denied';
  readonly actorUserId: UserId;
  readonly sourceIp: string | null;
  readonly summary: string;
  readonly requestId: string;
}

/**
 * The pinned denial summary. `audit_log` has no structured-metadata column
 * (F1 folds detail into `summary`), so the three payload fields that are not
 * already columns are encoded here in a stable, greppable order.
 * `tests/contract/rbac/permission-denied-audit.test.ts` owns this format.
 */
export function denialSummary(role: string, permissionKey: string, routePath: string): string {
  return `role=${role} permission=${permissionKey} route=${routePath}`;
}

export function buildDenialAudit(input: {
  readonly actorUserId: string;
  readonly role: Role | (string & {});
  readonly permissionKey: PermissionKey;
  readonly routePath: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
}): DenialAuditEvent {
  // Query strings routinely carry filter values (member ids, emails in search
  // params); the trail records the ROUTE, never the arguments. `!`: split with
  // a non-empty separator always yields ≥1 element — the assertion only
  // silences noUncheckedIndexedAccess, it is not a reachable fallback.
  const path = input.routePath.split('?')[0]!;
  return {
    eventType: 'permission_denied',
    actorUserId: input.actorUserId as UserId,
    sourceIp: input.sourceIp,
    // The REAL role — an unknown value must stay visible to forensics rather
    // than be coerced into a known one.
    summary: denialSummary(String(input.role), input.permissionKey, path),
    requestId: input.requestId,
  };
}

/**
 * Plausible same-origin path shape. Deliberately excludes CR/LF (log-injection,
 * CWE-117) and anything that is not a URL path character, and caps the length so
 * a forged header cannot dominate the 500-char audit summary.
 *
 * Two shapes the character class alone admits are rejected separately
 * (re-review round 2):
 *   - a `//host/…` prefix — protocol-relative, so a consumer that ever renders
 *     `route=` as an href would link OFF-origin;
 *   - percent-encoded CR/LF (`%0d`/`%0a`) — inert in the summary itself, but it
 *     re-materialises as a real line break in any consumer that URL-decodes,
 *     which would reopen CWE-117 one hop downstream.
 *
 * ## Shape here, provenance in `pathFromHeaders`
 *
 * This validates SHAPE only. Provenance is enforced one layer up
 * (016 post-ship review finding #5): `pathFromHeaders` refuses to read
 * `x-pathname` at all on prefetch-marked requests — the only requests whose
 * header can reach the RSC render without the proxy's server-side overwrite —
 * so a well-formed-but-forged path can no longer be laundered into the
 * append-only `permission_denied` trail. A recorded non-empty `route=` is
 * therefore proxy-written (server-derived) on the page leg, and
 * `request.url`-derived on the API leg.
 */
const SAFE_ROUTE_PATH_RE = /^\/[A-Za-z0-9\-._~/%[\]@!$&'()*+,;=:]{0,255}$/;
const PCT_ENCODED_CRLF_RE = /%0[da]/i;

/**
 * 016 review I2 — `x-pathname` is normally set by the proxy
 * (`src/proxy.ts` sets it to `pathname + search`), but the PAGE matcher
 * deliberately skips the proxy for Next.js router prefetch requests
 * (`missing: next-router-prefetch / purpose: prefetch`). On those requests the
 * header arrives straight from the CLIENT — which is why `pathFromHeaders`
 * refuses to read it when either prefetch marker is present (016 post-ship
 * finding #5): without that gate a signed-in caller about to be denied could
 * forge the `route=` field of an append-only `permission_denied` row.
 * (`/api/*` is exempt from that skip and uses `request.url`, so only the page
 * leg was exposed.)
 *
 * Strip the query string here too, so the `routePath` contract above — "WITHOUT
 * the query string" — is true on BOTH legs rather than only after
 * `buildDenialAudit` re-strips it. Anything that fails the shape check is
 * dropped rather than recorded, because an attacker-chosen string in an
 * append-only trail is worse than a missing one.
 */
export function sanitiseRoutePath(raw: string | null | undefined): string {
  if (!raw) return '';
  // `!`: split always yields ≥1 element (see buildDenialAudit above).
  const path = raw.split('?')[0]!;
  if (path.startsWith('//')) return '';
  if (PCT_ENCODED_CRLF_RE.test(path)) return '';
  return SAFE_ROUTE_PATH_RE.test(path) ? path : '';
}

/**
 * Exported for exactly one consumer besides `defaultDeps`: the wiring pin in
 * `permission-denied-audit.test.ts`. The re-review proved that testing
 * `sanitiseRoutePath` in isolation lets `return h.get('x-pathname') ?? ''`
 * come back here unnoticed — the same test-the-artefact-not-the-wiring shape
 * as the original C1. Do not add production callers; pages get the value via
 * `RbacDeps.routePath`.
 */
export async function pathFromHeaders(): Promise<string> {
  const h = await headers();
  // 016 post-ship review finding #5 — provenance gate. The proxy matcher
  // skips requests carrying either prefetch marker (proxy.ts `missing:`
  // rules), and ONLY on those skipped requests does a client-supplied
  // `x-pathname` survive to this render un-overwritten. So the marker's
  // presence is exactly the condition under which the header is forgeable:
  // clamp to unattributed rather than record an attacker-chosen path in an
  // append-only trail. Cost: a denial fired during a genuine router
  // prefetch loses route attribution — the real navigation that follows is
  // attributed normally (the proxy runs and overwrites the header).
  if (h.get('next-router-prefetch') !== null || h.get('purpose') === 'prefetch') {
    return '';
  }
  return sanitiseRoutePath(h.get('x-pathname'));
}

const defaultDeps: RbacDeps = {
  // Called through, not captured. `getSession: getCurrentSession` dereferenced
  // the export at module-eval time, which (a) blew up any test that partially
  // mocks '@/lib/auth-session' — the module is imported transitively by every
  // swept page — and (b) froze the binding before a mock could replace it.
  getSession: () => getCurrentSession(),
  audit: {
    // Imported on demand, not at module scope. A static import would drag the
    // audit repo — and through it the Postgres client, which builds itself at
    // module eval — into the import graph of EVERY staff page, whether or not
    // that request ever denies. The dynamic import keeps the DB out of the
    // happy path entirely and is paid for only on the denial branch.
    append: async (event) => {
      const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
      await auditRepo.append(event);
    },
  },
  countDenied: (labels) => authMetrics.permissionDenied(labels),
  routePath: async (request) =>
    request === undefined ? await pathFromHeaders() : new URL(request.url).pathname,
  requestId: async (request) =>
    request === undefined
      ? requestIdFromHeaders(await headers())
      : requestIdFromHeaders(request.headers),
  sourceIp: (request) => (request === undefined ? null : getClientIp(request)),
};

/**
 * Record the denial. Never throws: the caller has already decided to deny and
 * must be able to serve that decision regardless of the audit sink's health.
 */
async function recordDenial(
  deps: RbacDeps,
  current: CurrentSession,
  key: PermissionKey,
  routePath: string,
  requestId: string,
  sourceIp: string | null,
): Promise<void> {
  try {
    await deps.audit.append(
      buildDenialAudit({
        actorUserId: current.user.id,
        role: current.user.role,
        permissionKey: key,
        routePath,
        requestId,
        sourceIp,
      }),
    );
  } catch (error) {
    // pino serialises a raw Error as `{}` — errKind keeps the class name
    // visible without risking PII from a message (memory: log-hygiene).
    logger.error({ err: errKind(error), requestId }, 'rbac.permission-denied-audit-failed');
  }
  try {
    deps.countDenied({ role: String(current.user.role), permission: key });
  } catch {
    // A metrics backend hiccup is not a reason to serve a different status.
  }
}

/**
 * Gate a `(staff)` page. Returns the session so the page does not need a
 * second `requireSession('staff')` call (and second session round-trip).
 *
 * On denial: emits the trail, then `notFound()` — which throws, so this never
 * returns to a denied caller.
 */
export async function requirePagePermission(
  key: PermissionKey,
  deps: RbacDeps = defaultDeps,
): Promise<CurrentSession> {
  const current = await deps.getSession();
  if (!current) {
    // No session at all: the staff shell's `requireSession` redirect is the
    // right UX here, not a 404 — but this helper is called INSIDE that shell,
    // so reaching it without a session means the shell was bypassed.
    notFound();
  }

  if (hasPermission(current.user.role, key)) {
    return current;
  }

  const routePath = await deps.routePath();
  const requestId = await deps.requestId();
  await recordDenial(deps, current, key, routePath, requestId, deps.sourceIp());
  notFound();
}

export interface ApiPermissionContext {
  /**
   * Seals the discriminant so `'response' in ctx` narrowing stays sound —
   * the same guard `AdminContext` uses. A future edit that adds a real
   * `response` field becomes a compile error instead of a silent 403 on
   * every route.
   */
  readonly response?: never;
  readonly current: CurrentSession;
  /**
   * Always a string — `AdminContext.sourceIp` was, and this shape must stay a
   * drop-in for the ~130-site sweep. `getClientIp` never returns null for a
   * real request ('0.0.0.0' fallback); a test dep that does is coalesced to
   * the same sentinel.
   */
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface ApiPermissionRejection {
  readonly response: NextResponse;
}

/** Gate a staff API route handler. */
export async function requireApiPermission(
  request: NextRequest,
  key: PermissionKey,
  deps: RbacDeps = defaultDeps,
): Promise<ApiPermissionContext | ApiPermissionRejection> {
  const requestId = await deps.requestId(request);
  const sourceIp = deps.sourceIp(request);

  let current: CurrentSession | null;
  try {
    current = await deps.getSession();
  } catch (error) {
    logger.error({ err: errKind(error), requestId }, 'rbac.session-lookup-failed');
    return { response: NextResponse.json({ error: 'server-error' }, { status: 500 }) };
  }

  // 401 before any permission evaluation — an anonymous probe must not learn
  // which permission gates the route (enumeration safety).
  if (!current) {
    return { response: NextResponse.json({ error: 'no-session' }, { status: 401 }) };
  }

  if (hasPermission(current.user.role, key)) {
    return { current, sourceIp: sourceIp ?? '0.0.0.0', requestId };
  }

  const routePath = await deps.routePath(request);
  await recordDenial(deps, current, key, routePath, requestId, sourceIp);
  return { response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
}

/**
 * Read-only check for render decisions (does this staff user get the button?).
 * No audit, no denial — callers use it to shape a page, never to gate one.
 *
 * Pure since PR 5: with the flag gone this is a direct alias of the Domain
 * evaluator, kept as the composition-layer name ~48 call sites already use.
 */
export function canPerform(role: Role | (string & {}), key: PermissionKey): boolean {
  return hasPermission(role, key);
}
