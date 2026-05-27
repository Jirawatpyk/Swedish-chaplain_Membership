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
  type AuditViewerRole,
} from '../audit-redaction';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ActorDirectory, ActorIdentityView } from '../ports/actor-directory';
import type {
  AuditEventSource,
  AuditSourceCursor,
  AuditSourceFilters,
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
  /** Opaque keyset cursor from a prior page's `nextCursor`. */
  readonly cursor?: string;
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
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  readonly nextCursor: string | null;
}

export type AuditQueryError = 'forbidden' | 'invalid_range';

export interface AuditQueryDeps {
  readonly source: AuditEventSource;
  readonly audit: InsightsAuditPort;
  readonly actorDirectory: ActorDirectory;
}

/** `system:*` / `anonymous` actors are sentinels, not resolvable user rows. */
function isResolvableActor(actorUserId: string): boolean {
  return !actorUserId.startsWith('system:') && actorUserId !== 'anonymous';
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
  let from: Date | undefined;
  let to: Date | undefined;

  if (input.from !== undefined) {
    from = new Date(input.from);
    if (Number.isNaN(from.getTime())) return { ok: false };
    applied.push('from');
  }
  if (input.to !== undefined) {
    to = new Date(input.to);
    if (Number.isNaN(to.getTime())) return { ok: false };
    applied.push('to');
  }
  if (from && to && from.getTime() > to.getTime()) return { ok: false };

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
    summary: r.summary,
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

  const start = Date.now();
  // Fetch limit + 1 to detect (and not over-render) the next page.
  const raw = await deps.source.query(ctx, { ...resolved.value.base, limit: limit + 1 });
  insightsMetrics.auditQueryDurationMs(Date.now() - start);

  const hasMore = raw.length > limit;
  const pageRaw = hasMore ? raw.slice(0, limit) : raw;
  const identities = await resolveIdentityLabelsSafe(deps, ctx, meta, pageRaw);
  const rows = pageRaw.map((r) => toRow(r, role, identities));

  const last = pageRaw.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ iso: last.occurredAtIso, id: last.id }) : null;

  await emit(deps, ctx, meta, {
    kind: 'queried',
    appliedFilters: resolved.value.appliedFilters,
    resultCount: rows.length,
  });

  return ok({ rows, nextCursor });
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
