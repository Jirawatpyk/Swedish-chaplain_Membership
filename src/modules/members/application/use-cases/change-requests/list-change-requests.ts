/**
 * F114 — the read use cases for change-request history (US4; FR-026,
 * FR-027, FR-029, FR-033; contracts/admin-change-requests-api.md § queue +
 * per-member history, portal-change-requests-api.md § history).
 *
 * Three read models over `ChangeRequestRepo`:
 *   - the staff QUEUE (FR-027): tenant-wide, `pending` oldest-first by
 *     default (the oldest waiting on top), any other state newest-first;
 *     filterable by state / outcome / member / submitter / date range; each
 *     row carries `waitingSeconds` + `overdue` (> 3 days pending); the page
 *     also carries `pendingCount` + `oldestPendingAgeSeconds` (the dashboard
 *     / nav facts, FR-033);
 *   - the per-MEMBER history (FR-026): every state, newest first;
 *   - the PORTAL history (FR-029): the caller's own requests + the member's
 *     `company` / `mixed` ones — the repo applies the predicate in SQL, and
 *     this layer applies it AGAIN (fail closed) and projects a row shown to
 *     a NON-submitter: a `mixed` row down to its company fields, so a
 *     colleague's proposed name / phone never leaves the server (whole-branch
 *     round 3, F-10), and EVERY row down to no reason / note — FR-014 makes
 *     the reviewer's reason the SUBMITTING person's (review round 1, C2).
 *
 * Paging is keyset on `(submitted_at, id)` — the cursor is an OPAQUE string
 * (base64url of `iso|uuid`) so a client cannot craft one; a malformed cursor
 * is `invalid_cursor` (a 400), never page one silently. Limits are clamped
 * here, not trusted from the wire.
 *
 * Reads only — no tx; staff reads are not audited (FR-026). The one write is
 * the by-id miss: `getPortalChangeRequest` on an id the repo cannot see
 * (foreign tenant or unknown — indistinguishable under RLS) is audited
 * `member_cross_tenant_probe` like every other change-request miss (FR-035;
 * review round 1, SEC-I3); an in-tenant row outside the caller's scope is
 * counted `refused{not_owner}` and NOT audited (a colleague's row is not a
 * probe — the acknowledge precedent).
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { membersMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { OVERDUE_AFTER_DAYS, type ChangeRequest, type ChangeRequestId, type ChangeRequestState } from '../../../domain/change-request/change-request';
import type { MemberId } from '../../../domain/member';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { AuditPort } from '../../ports/audit-port';
import type {
  ChangeRequestCursor,
  ChangeRequestListFilter,
  ChangeRequestListRow,
  ChangeRequestRepo,
} from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { RepoError } from '../../ports/member-repo';
import { auditChangeRequestProbe } from './decide-change-request';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ListChangeRequestsDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'listQueue' | 'listByMember' | 'listVisibleToUser' | 'pendingStats' | 'findListRowById'>;
  readonly clock: ClockPort;
};

/** `getPortalChangeRequest` also audits a miss — it needs the audit port. */
export type GetPortalChangeRequestDeps = ListChangeRequestsDeps & { readonly audit: Pick<AuditPort, 'record'> };

export type ListChangeRequestsError =
  | { readonly type: 'invalid_cursor' }
  | { readonly type: 'server_error'; readonly message: string };

/** A queue / history row plus the derived waiting facts (FR-027). */
export type ChangeRequestQueueItem = {
  readonly row: ChangeRequestListRow;
  /** Seconds the request waited: to now while pending, to its decision / withdrawal otherwise. */
  readonly waitingSeconds: number;
  /** Pending for more than `OVERDUE_AFTER_DAYS` (FR-027 "visually flagged"). */
  readonly overdue: boolean;
};

export type ChangeRequestQueuePage = {
  readonly items: readonly ChangeRequestQueueItem[];
  readonly nextCursor: string | null;
  /** The tenant's pending count (not the page's) — the dashboard / nav fact (FR-033). */
  readonly pendingCount: number;
  readonly oldestPendingAgeSeconds: number | null;
};

export type ChangeRequestHistoryPage = {
  readonly items: readonly ChangeRequestQueueItem[];
  readonly nextCursor: string | null;
};

export type PortalChangeRequestPage = {
  readonly items: readonly ChangeRequestListRow[];
  readonly nextCursor: string | null;
};

export const QUEUE_PAGE_MAX = 100;
export const QUEUE_PAGE_DEFAULT = 50;
export const PORTAL_PAGE_MAX = 50;
export const PORTAL_PAGE_DEFAULT = 20;

// ---------------------------------------------------------------------------
// Cursor + derived facts (pure)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeChangeRequestCursor(cursor: ChangeRequestCursor): string {
  return Buffer.from(`${cursor.submittedAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/** `null` for anything that is not an `iso|uuid` pair — the caller answers `invalid_cursor`. */
export function decodeChangeRequestCursor(raw: string): ChangeRequestCursor | null {
  if (raw.length === 0 || raw.length > 200) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const at = decoded.indexOf('|');
  if (at <= 0) return null;
  const iso = decoded.slice(0, at);
  const id = decoded.slice(at + 1);
  const submittedAt = new Date(iso);
  if (Number.isNaN(submittedAt.getTime()) || submittedAt.toISOString() !== iso || !UUID_RE.test(id)) return null;
  return { submittedAt, id: id as ChangeRequestId };
}

function clamp(limit: number, max: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.trunc(limit), max));
}

/** Seconds a request waited — to now while pending, to its terminal transition otherwise. */
export function waitingSecondsOf(request: ChangeRequest, now: Date): number {
  const end =
    request.state === 'decided' ? (request.decidedAt ?? now) : request.state === 'withdrawn' ? (request.withdrawnAt ?? now) : now;
  return Math.max(0, Math.floor((end.getTime() - request.submittedAt.getTime()) / 1000));
}

/** FR-027 — a PENDING request older than three days. */
export function isOverdue(request: ChangeRequest, now: Date): boolean {
  return request.state === 'pending' && now.getTime() - request.submittedAt.getTime() > OVERDUE_AFTER_DAYS * 86_400_000;
}

function toItem(row: ChangeRequestListRow, now: Date): ChangeRequestQueueItem {
  return { row, waitingSeconds: waitingSecondsOf(row.request, now), overdue: isOverdue(row.request, now) };
}

/**
 * FR-029 / FR-014 — what a viewer may see of a row: the SUBMITTER sees their
 * own request in full (the same reference). Anyone else — a colleague on the
 * portal, or the company-level AUDIENCE of an on-behalf GDPR export
 * (`viewerUserId: null`) — sees a `company` request's fields, a `mixed`
 * request's company fields only (the colleague's own name / phone / job
 * title are theirs), and NEVER the reviewer's reason or note: FR-014 gives
 * the reason to the submitting person, and it may quote their proposed
 * values (review round 1, C2 — the queue / export reuse this one rule).
 */
export function projectChangeRequestForViewer(row: ChangeRequestListRow, viewerUserId: UserId | null): ChangeRequestListRow {
  const r = row.request;
  if (viewerUserId !== null && r.submittedByUserId === viewerUserId) return row;
  return {
    ...row,
    request: {
      ...r,
      fields: r.scope === 'mixed' ? r.fields.filter((f) => f.target === 'member') : r.fields,
      decisionReason: null,
      decisionNote: null,
    },
  };
}

function visibleTo(row: ChangeRequestListRow, viewerUserId: UserId, memberId: MemberId): boolean {
  const r = row.request;
  if (r.memberId !== memberId) return false;
  return r.submittedByUserId === viewerUserId || r.scope === 'company' || r.scope === 'mixed';
}

function serverError(deps: ListChangeRequestsDeps, what: string, error: RepoError): ListChangeRequestsError {
  logger.error(
    { tenantId: deps.tenant.slug, err: error.code, cause: errKind('cause' in error ? error.cause : undefined) },
    `change-request.list.${what}_failed`,
  );
  return { type: 'server_error', message: `${what}: ${error.code}` };
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function listChangeRequestQueue(
  deps: ListChangeRequestsDeps,
  input: { readonly filter: ChangeRequestListFilter; readonly cursor: string | null; readonly limit: number },
): Promise<Result<ChangeRequestQueuePage, ListChangeRequestsError>> {
  const cursor = input.cursor === null ? null : decodeChangeRequestCursor(input.cursor);
  if (input.cursor !== null && cursor === null) return err({ type: 'invalid_cursor' });
  const now = deps.clock.now();
  const [page, stats] = await Promise.all([
    deps.changeRequestRepo.listQueue(deps.tenant, input.filter, { cursor, limit: clamp(input.limit, QUEUE_PAGE_MAX, QUEUE_PAGE_DEFAULT) }),
    deps.changeRequestRepo.pendingStats(deps.tenant),
  ]);
  if (!page.ok) return err(serverError(deps, 'queue', page.error));
  if (!stats.ok) return err(serverError(deps, 'pending_stats', stats.error));
  return ok({
    items: page.value.items.map((row) => toItem(row, now)),
    nextCursor: page.value.nextCursor ? encodeChangeRequestCursor(page.value.nextCursor) : null,
    pendingCount: stats.value.count,
    oldestPendingAgeSeconds: stats.value.oldestSubmittedAt ? Math.max(0, Math.floor((now.getTime() - stats.value.oldestSubmittedAt.getTime()) / 1000)) : null,
  });
}

export async function listMemberChangeRequests(
  deps: ListChangeRequestsDeps,
  input: { readonly memberId: MemberId; readonly cursor: string | null; readonly limit: number },
): Promise<Result<ChangeRequestHistoryPage, ListChangeRequestsError>> {
  const cursor = input.cursor === null ? null : decodeChangeRequestCursor(input.cursor);
  if (input.cursor !== null && cursor === null) return err({ type: 'invalid_cursor' });
  const now = deps.clock.now();
  const page = await deps.changeRequestRepo.listByMember(deps.tenant, input.memberId, { cursor, limit: clamp(input.limit, QUEUE_PAGE_MAX, QUEUE_PAGE_DEFAULT) });
  if (!page.ok) return err(serverError(deps, 'member_history', page.error));
  return ok({
    items: page.value.items.map((row) => toItem(row, now)),
    nextCursor: page.value.nextCursor ? encodeChangeRequestCursor(page.value.nextCursor) : null,
  });
}

export async function listPortalChangeRequests(
  deps: ListChangeRequestsDeps,
  input: { readonly userId: UserId; readonly memberId: MemberId; readonly state?: ChangeRequestState; readonly cursor: string | null; readonly limit: number },
): Promise<Result<PortalChangeRequestPage, ListChangeRequestsError>> {
  const cursor = input.cursor === null ? null : decodeChangeRequestCursor(input.cursor);
  if (input.cursor !== null && cursor === null) return err({ type: 'invalid_cursor' });
  const page = await deps.changeRequestRepo.listVisibleToUser(deps.tenant, input.userId, input.memberId, {
    cursor,
    limit: clamp(input.limit, PORTAL_PAGE_MAX, PORTAL_PAGE_DEFAULT),
    ...(input.state ? { state: input.state } : {}),
  });
  if (!page.ok) return err(serverError(deps, 'portal_history', page.error));
  return ok({
    // the SQL predicate already excluded a colleague's own-contact rows; a
    // privacy control fails CLOSED, so the same rule runs here too
    items: page.value.items.filter((row) => visibleTo(row, input.userId, input.memberId)).map((row) => projectChangeRequestForViewer(row, input.userId)),
    nextCursor: page.value.nextCursor ? encodeChangeRequestCursor(page.value.nextCursor) : null,
  });
}

export async function getPortalChangeRequest(
  deps: GetPortalChangeRequestDeps,
  input: {
    readonly changeRequestId: ChangeRequestId;
    readonly userId: UserId;
    readonly memberId: MemberId;
    readonly actorRole: string | null;
    readonly requestId: string;
  },
): Promise<Result<ChangeRequestListRow, { readonly type: 'not_found' } | ListChangeRequestsError>> {
  const found = await deps.changeRequestRepo.findListRowById(deps.tenant, input.changeRequestId);
  if (!found.ok) {
    if (found.error.code === 'repo.not_found') {
      // a foreign tenant's id and an unknown id look the same under RLS —
      // every miss is a probe record (FR-035), best-effort like the others
      await auditChangeRequestProbe(deps.audit, deps.tenant, {
        changeRequestId: input.changeRequestId,
        actorUserId: input.userId,
        actorRole: input.actorRole,
        requestId: input.requestId,
        action: 'history_item',
      });
      return err({ type: 'not_found' });
    }
    return err(serverError(deps, 'portal_history_item', found.error));
  }
  // out of the caller's FR-029 scope → not_found, never 403 (no existence
  // leak); in-tenant, so not a probe — counted so an IDOR sweep is visible
  if (!visibleTo(found.value, input.userId, input.memberId)) {
    membersMetrics.changeRequests.refused(deps.tenant.slug, 'not_owner');
    return err({ type: 'not_found' });
  }
  return ok(projectChangeRequestForViewer(found.value, input.userId));
}
