/**
 * RBAC v2 composition root (016-rbac-permissions T021).
 *
 * The ONLY place in the application that reads `FEATURE_RBAC_V2`. The Domain
 * evaluator takes the flag as an explicit parameter so it stays pure; this
 * file supplies it, together with the session, the audit sink, the metric
 * counter, and the request metadata the denial trail needs.
 *
 * Every staff surface calls exactly one of:
 *
 *   const { user } = await requirePagePermission('members.read', legacySessionOnly);
 *
 *   const ctx = await requireApiPermission(request, 'members.write', mappedLegacy('members', 'write'));
 *   if ('response' in ctx) return ctx.response;   // 401 or 403
 *
 * The API result shape is deliberately identical to `requireAdminContext`'s,
 * so the PR-2 sweep is a mechanical substitution at ~130 call sites rather
 * than a rewrite of each handler's prologue.
 *
 * ## Why two arguments
 *
 * `key` governs the flag-ON leg. `legacy` is the shim row for the flag-OFF
 * leg — the call-site class this surface was guarded by before the sweep.
 * Keeping them separate is what makes "flag OFF is byte-identical" a
 * mechanically checkable claim: `tests/helpers/rbac-observed-baseline.ts`
 * pins the (surface, key, row) triple and the matrix test proves the row
 * reproduces the pre-sweep outcome for all five roles. Both arguments are
 * deleted together in PR 5 when the legacy leg goes.
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
import { env } from '@/lib/env';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { authMetrics, type PermissionDeniedLabels } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import type { LegacyRow } from '@/modules/auth/domain/permissions/legacy-shim';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import type { Role } from '@/modules/auth/domain/role';
import type { UserId } from '@/modules/auth/domain/branded';

/** Injection seam — production values live in `defaultDeps` below. */
export interface RbacDeps {
  readonly rbacV2: boolean;
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
  // params); the trail records the ROUTE, never the arguments.
  const path = input.routePath.split('?')[0] ?? input.routePath;
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

async function pathFromHeaders(): Promise<string> {
  const h = await headers();
  return h.get('x-pathname') ?? '';
}

const defaultDeps: RbacDeps = {
  rbacV2: env.features.rbacV2,
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
  legacy: LegacyRow,
  deps: RbacDeps = defaultDeps,
): Promise<CurrentSession> {
  const current = await deps.getSession();
  if (!current) {
    // No session at all: the staff shell's `requireSession` redirect is the
    // right UX here, not a 404 — but this helper is called INSIDE that shell,
    // so reaching it without a session means the shell was bypassed.
    notFound();
  }

  if (hasPermission(current.user.role, key, { rbacV2: deps.rbacV2, legacy })) {
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
  legacy: LegacyRow,
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

  if (hasPermission(current.user.role, key, { rbacV2: deps.rbacV2, legacy })) {
    return { current, sourceIp: sourceIp ?? '0.0.0.0', requestId };
  }

  const routePath = await deps.routePath(request);
  await recordDenial(deps, current, key, routePath, requestId, sourceIp);
  return { response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
}

/**
 * Read-only check for render decisions (does this staff user get the button?).
 * No audit, no denial — callers use it to shape a page, never to gate one.
 */
export function canPerform(
  role: Role | (string & {}),
  key: PermissionKey,
  legacy: LegacyRow,
  deps: Pick<RbacDeps, 'rbacV2'> = defaultDeps,
): boolean {
  return hasPermission(role, key, { rbacV2: deps.rbacV2, legacy });
}
