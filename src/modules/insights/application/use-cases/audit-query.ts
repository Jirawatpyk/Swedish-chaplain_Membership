/**
 * F9 US2 (T042 / T046) — `auditQuery` + `auditExport` use-cases.
 *
 * The read/export path over F1's append-only `audit_log` that backs the staff
 * audit viewer (FR-008..013). Staff-only (member → forbidden); keyset-paginated
 * `(timestamp DESC, id DESC)` (FR-008, p95 < 1 s @ 50k); per-role payload
 * redaction (FR-011, via `audit-redaction`); each call emits its own audit trail
 * (`audit_log_queried` / `audit_log_exported`) — the viewer never mutates the log
 * (FR-010, no mutation path exists here).
 *
 * Placement (deviation from tasks.md T042's `src/modules/auth/**` path): the F9
 * audit taxonomy (`audit_log_queried`/`audit_log_exported`, 5-y retention) is
 * owned by the insights `InsightsAuditPort`, and insights → auth is the correct
 * dependency direction (auth is the lower-level module). Putting the use-case in
 * auth would invert that (auth → insights) and split the F9 taxonomy across two
 * modules. The auth module keeps only the audit_log READER (`auditQueryReadAdapter`,
 * consumed here via the `AuditEventSource` port) — matching the note in
 * `src/modules/insights/index.ts` ("the audit-query reader lives in auth").
 *
 * Application layer: no ORM/framework imports (Principle III). The source
 * self-scopes (its auth reader runs in its own `runInTenant`).
 */
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import {
  redactPayloadForRole,
  redactSummaryForRole,
  type AuditViewerRole,
} from '../audit-redaction';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ActorDirectory, ActorIdentityView } from '../ports/actor-directory';
import type {
  AuditEventSource,
  AuditSourceCursor,
  AuditSourceFilters,
  AuditSourceRow,
} from '../ports/audit-source';

export type AuditQueryActorRole = 'admin' | 'manager' | 'member';

/** Largest sync (streamed) export; a filtered set above this routes to an async job (US6). */
export const AUDIT_EXPORT_SYNC_CAP = 10_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface AuditQueryMeta {
  readonly actorUserId: string;
  readonly actorRole: AuditQueryActorRole;
  readonly requestId: string;
}

export interface AuditQueryInput {
  readonly eventType?: readonly string[];
  readonly actorUserId?: string;
  /** Target record/entity ref (maps to `audit_log.target_user_id`). */
  readonly targetRef?: string;
  /** ISO 8601 instant (inclusive lower bound). */
  readonly from?: string;
  /** ISO 8601 instant (inclusive upper bound). */
  readonly to?: string;
  /** Opaque keyset cursor from a prior page's `nextCursor` / `prevCursor`. */
  readonly cursor?: string;
  /**
   * Paging direction relative to `cursor` (default `'forward'`): `'forward'`
   * follows `nextCursor` to OLDER rows; `'backward'` follows `prevCursor` to
   * NEWER rows (the Previous page). Ignored without a cursor.
   */
  readonly direction?: 'forward' | 'backward';
  readonly limit?: number;
}

export interface AuditQueryRow {
  readonly id: string;
  readonly eventType: string;
  /** Raw actor id — never redacted (visible to admin + manager, FR-011). */
  readonly actorUserId: string;
  /** Human-readable actor (display name / email; falls back to the raw id or
   *  a `system:*`/`anonymous` sentinel). */
  readonly actorLabel: string;
  readonly targetUserId: string | null;
  /** Human-readable target (resolved when the target id is a user; `null` when
   *  there is no target, or the raw id when it resolves to no user — e.g. a
   *  member id, which this user-directory does not cover). */
  readonly targetLabel: string | null;
  readonly summary: string;
  /** ISO 8601 UTC; presentation renders UTC + a locale-local string (FR-012). */
  readonly occurredAt: string;
  readonly requestId: string;
  /** Payload projected for the viewing role (FR-011). */
  readonly payload: Record<string, unknown> | null;
}

export interface AuditQueryResult {
  readonly rows: readonly AuditQueryRow[];
  /** Opaque cursor for the NEXT (older) page, or `null` when this is the oldest page. */
  readonly nextCursor: string | null;
  /**
   * Opaque cursor for the PREVIOUS (newer) page, or `null` when there are no
   * newer rows (the first/newest page). Pair with `direction: 'backward'`.
   */
  readonly prevCursor: string | null;
}

export type AuditQueryError = 'forbidden' | 'invalid_range';

export interface AuditQueryDeps {
  readonly source: AuditEventSource;
  readonly audit: InsightsAuditPort;
  readonly actorDirectory: ActorDirectory;
}

/**
 * Only UUID-shaped actor ids are resolvable `users` rows. Sentinels —
 * `system:*`, `anonymous`, the bare `system`, `''`, or ANY non-UUID string —
 * are rendered raw and MUST NOT reach the `inArray(users.id, …)` lookup:
 * `users.id` is a `uuid` column, so a non-UUID value throws Postgres
 * `invalid input syntax for type uuid` (a DrizzleQueryError that degraded the
 * entire identity-resolve to raw ids — e.g. an `actor_user_id = 'system'` row
 * that slipped the old `startsWith('system:')` check, which required the colon).
 * Exported for unit testing.
 */
const ACTOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isResolvableActor(actorUserId: string): boolean {
  return ACTOR_UUID_RE.test(actorUserId);
}

function actorLabelOf(
  actorUserId: string,
  identities: ReadonlyMap<string, ActorIdentityView>,
): string {
  // Data minimisation (PDPA §19 / GDPR Art. 5(1)(c)): fall back to the raw id —
  // NEVER the email — when no display name is resolved. The id is the forensic
  // anchor; the email is more PII than the audit-viewer purpose requires.
  const found = identities.get(actorUserId);
  return found?.displayName ?? actorUserId;
}

export interface AuditExportResult {
  readonly rows: readonly AuditQueryRow[];
}

export type AuditExportError = 'forbidden' | 'invalid_range' | 'export_too_large';

// --- cursor codec ------------------------------------------------------------
// Opaque `iso|id` base64url token (`|` separates — the µs `timestamptz` text
// contains colons/spaces/`+` but never `|`, and a UUID never contains `|`).
// Keeps the client from depending on the keyset shape; a malformed/tampered
// cursor surfaces as `invalid_range`.

function encodeCursor(c: AuditSourceCursor): string {
  return Buffer.from(`${c.iso}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): AuditSourceCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const iso = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (iso.length === 0 || id.length === 0) return null;
    // VALUE-validate the iso (not just its shape) BEFORE it reaches the DB
    // `::timestamptz` cast — a shape-valid-but-impossible time like
    // `2026-01-01 99:99:99+99` would otherwise hit Postgres (ERROR 22007) → 500
    // instead of a clean invalid_range. `new Date` parses the `timestamptz::text`
    // grammar Postgres mints (space separator, `+00` offset, µs fraction) and
    // returns Invalid Date (NaN) for impossible values — verified to accept
    // every legitimate server-minted cursor, so no false-negative on real pages.
    if (Number.isNaN(new Date(iso).getTime())) return null;
    return { iso, id };
  } catch {
    return null;
  }
}

// --- shared filter resolution ------------------------------------------------

type ResolvedFilters = {
  readonly base: Omit<AuditSourceFilters, 'limit'>;
  /** Filter field NAMES applied (for the audit-trail payload — never values). */
  readonly appliedFilters: readonly string[];
};

/** Parse + validate the public input into reader filters. `Date` is invalid → null. */
function resolveFilters(
  input: AuditQueryInput,
): { ok: true; value: ResolvedFilters } | { ok: false } {
  const applied: string[] = [];
  // Keep the bounds as the VALIDATED full-precision ISO string (µs), not a JS
  // Date — a Date holds only ms and would truncate `tenantDayEndUtc`'s .999999
  // cap back to .999, re-dropping the day's final-µs window. The reader casts
  // `${from|to}::timestamptz` (like the keyset cursor). (Round 2 — #14-dead fix)
  let from: string | undefined;
  let to: string | undefined;

  if (input.from !== undefined) {
    if (Number.isNaN(new Date(input.from).getTime())) return { ok: false };
    from = input.from;
    applied.push('from');
  }
  if (input.to !== undefined) {
    if (Number.isNaN(new Date(input.to).getTime())) return { ok: false };
    to = input.to;
    applied.push('to');
  }
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) return { ok: false };

  let cursor: AuditSourceCursor | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) return { ok: false };
    cursor = decoded;
  }

  const eventType =
    input.eventType && input.eventType.length > 0 ? input.eventType : undefined;
  if (eventType) applied.push('eventType');
  if (input.actorUserId) applied.push('actorUserId');
  if (input.targetRef) applied.push('targetRef');

  return {
    ok: true,
    value: {
      base: {
        ...(eventType ? { eventType } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        ...(input.targetRef ? { targetUserId: input.targetRef } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(cursor ? { cursor } : {}),
      },
      appliedFilters: applied,
    },
  };
}

function toRow(
  r: { id: string; eventType: string; actorUserId: string; targetUserId: string | null; summary: string; occurredAt: Date; requestId: string; payload: Record<string, unknown> | null },
  role: AuditViewerRole,
  identities: ReadonlyMap<string, ActorIdentityView>,
): AuditQueryRow {
  return {
    id: r.id,
    eventType: r.eventType,
    actorUserId: r.actorUserId,
    actorLabel: actorLabelOf(r.actorUserId, identities),
    targetUserId: r.targetUserId,
    targetLabel:
      r.targetUserId && isResolvableActor(r.targetUserId)
        ? actorLabelOf(r.targetUserId, identities)
        : null,
    summary: redactSummaryForRole(r.summary, role),
    occurredAt: r.occurredAt.toISOString(),
    requestId: r.requestId,
    payload: redactPayloadForRole(r.eventType, r.payload, role),
  };
}

/** Batch-resolve the resolvable (non-sentinel) actor + target ids in a row set. */
async function resolveIdentityLabels(
  deps: AuditQueryDeps,
  rows: ReadonlyArray<{ actorUserId: string; targetUserId: string | null }>,
): Promise<ReadonlyMap<string, ActorIdentityView>> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (isResolvableActor(r.actorUserId)) ids.add(r.actorUserId);
    if (r.targetUserId && isResolvableActor(r.targetUserId)) ids.add(r.targetUserId);
  }
  if (ids.size === 0) return new Map();
  return deps.actorDirectory.labelsFor([...ids]);
}

/**
 * Identity resolution is COSMETIC enrichment over the already-fetched audit
 * rows — `toRow` falls back to the raw id when an identity is absent. So a
 * `users`-lookup failure (Neon blip, pool exhaustion) must degrade to raw ids,
 * never reject the whole audit read (which would replace a complete compliance
 * record with a generic error). Mirrors the best-effort `emit()` pattern.
 */
async function resolveIdentityLabelsSafe(
  deps: AuditQueryDeps,
  ctx: TenantContext,
  meta: AuditQueryMeta,
  rows: ReadonlyArray<{ actorUserId: string; targetUserId: string | null }>,
): Promise<ReadonlyMap<string, ActorIdentityView>> {
  try {
    return await resolveIdentityLabels(deps, rows);
  } catch (e) {
    logger.warn(
      { tenantId: ctx.slug, requestId: meta.requestId, errKind: errKind(e) },
      'insights.audit_query.identity_resolve_threw',
    );
    return new Map();
  }
}

/** Emit best-effort; an audit-write failure must never fail the read (FR-036). */
async function emit(
  deps: AuditQueryDeps,
  ctx: TenantContext,
  meta: AuditQueryMeta,
  event:
    | { kind: 'queried'; appliedFilters: readonly string[]; resultCount: number }
    | { kind: 'exported'; appliedFilters: readonly string[]; rowCount: number },
): Promise<void> {
  try {
    if (event.kind === 'queried') {
      await deps.audit.record({
        tenantId: ctx.slug,
        requestId: meta.requestId,
        eventType: 'audit_log_queried',
        actorUserId: meta.actorUserId,
        retentionYears: f9RetentionFor('audit_log_queried'),
        summary: `audit log queried by ${meta.actorRole}`,
        payload: {
          applied_filters: event.appliedFilters,
          result_count: event.resultCount,
        },
      });
    } else {
      await deps.audit.record({
        tenantId: ctx.slug,
        requestId: meta.requestId,
        eventType: 'audit_log_exported',
        actorUserId: meta.actorUserId,
        retentionYears: f9RetentionFor('audit_log_exported'),
        summary: `audit log exported by ${meta.actorRole}`,
        payload: {
          applied_filters: event.appliedFilters,
          row_count: event.rowCount,
          delivery: 'sync',
        },
      });
    }
  } catch (e) {
    logger.error(
      { tenantId: ctx.slug, errKind: errKind(e) },
      'insights.audit_query.audit_emit_threw',
    );
  }
}

export async function auditQuery(
  input: AuditQueryInput,
  meta: AuditQueryMeta,
  ctx: TenantContext,
  deps: AuditQueryDeps,
): Promise<Result<AuditQueryResult, AuditQueryError>> {
  if (meta.actorRole === 'member') return err('forbidden');
  const role: AuditViewerRole = meta.actorRole;

  const resolved = resolveFilters(input);
  if (!resolved.ok) return err('invalid_range');

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Backward (Previous) only makes sense with a cursor — a dir=backward request
  // without one degrades to the forward first page (newest, DESC).
  const hadCursor = resolved.value.base.cursor !== undefined;
  const backward = input.direction === 'backward' && hadCursor;

  const start = Date.now();
  // Fetch limit + 1 to detect (and not over-render) the adjacent page.
  const raw = await deps.source.query(ctx, {
    ...resolved.value.base,
    ...(backward ? { direction: 'backward' as const } : {}),
    limit: limit + 1,
  });
  insightsMetrics.auditQueryDurationMs(Date.now() - start);

  const hasMore = raw.length > limit; // more rows beyond this page IN the scan direction
  const slice = hasMore ? raw.slice(0, limit) : raw;
  // Backward pages arrive ASC (closest-newer first) — reverse to the always
  // newest-first display order so the table looks identical either way.
  const pageRaw = backward ? [...slice].reverse() : slice;

  const identities = await resolveIdentityLabelsSafe(deps, ctx, meta, pageRaw);
  const rows = pageRaw.map((r) => toRow(r, role, identities));

  const cur = (r: AuditSourceRow): string =>
    encodeCursor({ iso: r.occurredAtIso, id: r.id });
  const newest = pageRaw[0]; // first displayed row
  const oldest = pageRaw.at(-1); // last displayed row

  let nextCursor: string | null;
  let prevCursor: string | null;
  if (backward) {
    // Scanned newer-than-cursor: OLDER rows always exist (we came from there);
    // `hasMore` here means even-NEWER pages remain → a Previous exists.
    nextCursor = oldest ? cur(oldest) : null;
    prevCursor = hasMore && newest ? cur(newest) : null;
  } else {
    // Forward: `hasMore` means OLDER rows remain → a Next exists. A Previous
    // exists iff we arrived via a cursor (there is a newer page we came from).
    nextCursor = hasMore && oldest ? cur(oldest) : null;
    prevCursor = hadCursor && newest ? cur(newest) : null;
  }

  await emit(deps, ctx, meta, {
    kind: 'queried',
    appliedFilters: resolved.value.appliedFilters,
    resultCount: rows.length,
  });

  return ok({ rows, nextCursor, prevCursor });
}

export async function auditExport(
  input: AuditQueryInput,
  meta: AuditQueryMeta,
  ctx: TenantContext,
  deps: AuditQueryDeps,
): Promise<Result<AuditExportResult, AuditExportError>> {
  if (meta.actorRole === 'member') return err('forbidden');
  const role: AuditViewerRole = meta.actorRole;

  const resolved = resolveFilters(input);
  if (!resolved.ok) return err('invalid_range');

  // Export ignores the page cursor — it streams the whole filtered set. Fetch
  // cap + 1 so an overflow is detected without materialising the excess.
  const { cursor: _drop, ...exportBase } = resolved.value.base;
  void _drop;
  const raw = await deps.source.query(ctx, {
    ...exportBase,
    limit: AUDIT_EXPORT_SYNC_CAP + 1,
  });
  if (raw.length > AUDIT_EXPORT_SYNC_CAP) return err('export_too_large');

  const identities = await resolveIdentityLabelsSafe(deps, ctx, meta, raw);
  const rows = raw.map((r) => toRow(r, role, identities));
  await emit(deps, ctx, meta, {
    kind: 'exported',
    appliedFilters: resolved.value.appliedFilters,
    rowCount: rows.length,
  });

  return ok({ rows });
}
