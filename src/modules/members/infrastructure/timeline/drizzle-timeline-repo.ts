/**
 * F9 US3 — Drizzle implementation of the unified TimelinePort.
 *
 * Reads `member_timeline_v` (migrations 0189 + 0192) — a `security_invoker`
 * UNION ALL of six sources (audit · invoice · payment · event · broadcast ·
 * renewal). Filtered by `member_id`, optionally by `source` / `actor_kind` /
 * date range (FR-015), ordered `(occurred_at DESC, ref_id DESC)` with keyset
 * pagination over the TEXT `ref_id`.
 *
 * Tenant scoping: runs under `runInTenant` (sets `app.current_tenant`); the
 * view is `security_invoker = on` so each base table's RLS applies to the
 * querying `chamber_app` role — tenant isolation holds inside the view
 * (Principle I).
 *
 * Cursor precision: the cursor carries the FULL `occurred_at::text`
 * (microsecond) value, not a millisecond-truncated `Date.toISOString()` — a
 * same-millisecond, sub-millisecond-apart boundary would otherwise drop or
 * duplicate rows (the F9 US2 keyset lesson). `ref_id` is the text tiebreaker.
 *
 * Audit-row fidelity: the 0192 view lifts `event_type` / `summary` /
 * `actor_user_id` into the audit payload. This repo promotes `event_type` →
 * `eventType` and `actor_user_id` → `actorUserId` (resolving a display name),
 * strips them from the returned payload, and keeps the F3 plan-name
 * enrichment so the audit half renders exactly as before.
 */
import { sql, inArray } from 'drizzle-orm';
import { ok, err } from '@/lib/result';
import { runInTenant, db } from '@/lib/db';
import { insightsMetrics } from '@/lib/metrics';
import { TIMELINE_SOURCES, TIMELINE_ACTOR_KINDS } from '@/lib/timeline-shared';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans';

const isTimelineSource = (s: string): s is TimelineSource =>
  (TIMELINE_SOURCES as readonly string[]).includes(s);
const isTimelineActorKind = (k: string): k is TimelineActorKind =>
  (TIMELINE_ACTOR_KINDS as readonly string[]).includes(k);
import type {
  TimelinePort,
  TimelineFilter,
  TimelineResult,
  TimelineEvent,
  TimelineSource,
  TimelineActorKind,
} from '../../application/ports/timeline-port';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raw `member_timeline_v` row shape (snake_case from `tx.execute`). */
type ViewRow = {
  readonly ref_id: string;
  /** `occurred_at::text` — full µs precision for the keyset cursor. */
  readonly occurred_at_iso: string;
  readonly source: TimelineSource;
  readonly actor_kind: TimelineActorKind;
  readonly payload: Record<string, unknown> | null;
};

/**
 * Decode `<occurred_at::text>|<ref_id>` (base64url). Returns null on a
 * malformed / value-invalid cursor (resets to page 1 from the caller's POV).
 */
function decodeCursor(cursor: string): { iso: string; ref: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const sep = decoded.indexOf('|');
    if (sep < 0) return null;
    const iso = decoded.slice(0, sep);
    const ref = decoded.slice(sep + 1);
    if (!iso || !ref) return null;
    // VALUE-validate the timestamp before it reaches the `::timestamptz` cast
    // (a shape-valid-but-impossible value would 500 instead of resetting).
    if (Number.isNaN(new Date(iso).getTime())) return null;
    return { iso, ref };
  } catch {
    return null;
  }
}

function encodeCursor(occurredAtIso: string, refId: string): string {
  return Buffer.from(`${occurredAtIso}|${refId}`).toString('base64url');
}

/** Source-specific event-kind for the `timeline.<source>.<eventKind>` i18n key. */
function nonAuditEventKind(
  source: TimelineSource,
  payload: Record<string, unknown> | null,
): string {
  const status = typeof payload?.status === 'string' ? payload.status : null;
  switch (source) {
    case 'invoice':
      return status ?? 'issued';
    case 'payment':
      return status ?? 'succeeded';
    case 'event':
      return 'attended';
    case 'broadcast':
      return status ?? 'sent';
    case 'renewal':
      return status ?? 'updated';
    default:
      return 'updated';
  }
}

export const drizzleTimelineRepo: TimelinePort = {
  async listByMember(ctx, filter: TimelineFilter) {
    const startedAt = performance.now();
    try {
      const { memberId, cursor, limit } = filter;

      const result = await runInTenant(ctx, async (tx) => {
        // --- shared filter fragments (count + page) ---------------------
        // Explicit tenant predicate (Principle I second wall, defence-in-depth
        // behind the view's security_invoker RLS). `member_timeline_v` emits a
        // `tenant_id` column (0192), and `audit_log`'s RLS is NULL-permissive
        // (`tenant_id IS NULL OR ...`), so without this an RLS misconfig / a
        // pooled connection missing app.current_tenant could surface another
        // tenant's rows. `ctx.slug` is what every tenant_id column stores.
        // (code-review max F9 — finding #12)
        const conditions = [sql`tenant_id = ${ctx.slug}`, sql`member_id = ${memberId}`];
        if (filter.source) conditions.push(sql`source = ${filter.source}`);
        if (filter.actorKind) conditions.push(sql`actor_kind = ${filter.actorKind}`);
        if (filter.fromTs) conditions.push(sql`occurred_at >= ${filter.fromTs}::timestamptz`);
        if (filter.toTs) conditions.push(sql`occurred_at <= ${filter.toTs}::timestamptz`);
        const baseWhere = conditions.reduce(
          (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`),
        );

        // Count over the full filtered set (no cursor) — stable across pages.
        const countRows = (await tx.execute(
          sql`SELECT count(*)::int AS n FROM member_timeline_v WHERE ${baseWhere}`,
        )) as unknown as Array<{ n: number }>;
        const total = countRows[0]?.n ?? 0;

        // Page query adds the keyset cursor predicate.
        let pageWhere = baseWhere;
        const cur = cursor ? decodeCursor(cursor) : null;
        if (cur) {
          pageWhere = sql`${pageWhere} AND (occurred_at, ref_id) < (${cur.iso}::timestamptz, ${cur.ref})`;
        }

        const rows = (await tx.execute(sql`
          SELECT
            ref_id,
            occurred_at::text AS occurred_at_iso,
            source,
            actor_kind,
            payload
          FROM member_timeline_v
          WHERE ${pageWhere}
          ORDER BY occurred_at DESC, ref_id DESC
          LIMIT ${limit + 1}
        `)) as unknown as ViewRow[];

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;

        // --- actor display-name resolution (audit rows only) -----------
        // The 0192 view lifts `actor_user_id` into the audit payload.
        const auditPayloads = pageRows
          .filter((r) => r.source === 'audit')
          .map((r) => (r.payload ?? {}) as Record<string, unknown>);

        const uuidActorIds = Array.from(
          new Set(
            auditPayloads
              .map((p) => p.actor_user_id)
              .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
          ),
        );

        const actorMap = new Map<string, string>();
        if (uuidActorIds.length > 0) {
          // `users` is a platform table with no tenant_id → query the outer
          // db. Safe: these UUIDs came from audit rows already RLS-scoped to
          // this tenant in the page select above, so no cross-tenant leak.
          const userRows = await db
            .select({ id: users.id, email: users.email, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, uuidActorIds));
          for (const u of userRows) actorMap.set(u.id, u.displayName ?? u.email);
        }

        // --- plan display-name enrichment (audit rows only) -------------
        const planKeys = new Set<string>();
        const collectPlan = (id: unknown, year: unknown): void => {
          if (typeof id === 'string' && id.length > 0) {
            const yearNum = typeof year === 'number' ? year : 0;
            planKeys.add(`${id}|${yearNum}`);
          }
        };
        for (const p of auditPayloads) {
          collectPlan(p.old_plan_id, p.old_plan_year);
          collectPlan(p.new_plan_id, p.new_plan_year);
          collectPlan(p.plan_id, p.plan_year);
          collectPlan(p.old_includes_corporate_plan_id, p.old_plan_year);
          collectPlan(p.new_includes_corporate_plan_id, p.new_plan_year);
        }

        const planMap = new Map<string, string>();
        if (planKeys.size > 0) {
          const planIds = Array.from(
            new Set(
              Array.from(planKeys).map((k) => k.slice(0, k.lastIndexOf('|'))),
            ),
          );
          if (planIds.length > 0) {
            const planRows = await tx
              .select({
                planId: membershipPlans.planId,
                planYear: membershipPlans.planYear,
                planName: membershipPlans.planName,
              })
              .from(membershipPlans)
              .where(inArray(membershipPlans.planId, planIds))
              .orderBy(sql`${membershipPlans.planYear} DESC`);
            for (const pr of planRows) {
              const pn = (pr.planName ?? {}) as Record<string, string>;
              const display = pn.en ?? pn.th ?? pn.sv ?? pr.planId;
              planMap.set(`${pr.planId}|${pr.planYear}`, display);
              if (!planMap.has(`${pr.planId}|0`)) planMap.set(`${pr.planId}|0`, display);
            }
          }
        }

        const resolvePlanName = (id: unknown, year: unknown): string | undefined => {
          if (typeof id !== 'string' || id.length === 0) return undefined;
          const yearNum = typeof year === 'number' ? year : 0;
          return planMap.get(`${id}|${yearNum}`) ?? planMap.get(`${id}|0`);
        };

        // --- map rows → TimelineEvent -----------------------------------
        const events: TimelineEvent[] = pageRows.map((row) => {
          // Guard the union discriminants at the view boundary — a migration
          // drift that emits an unknown source/actor_kind becomes a caught,
          // logged error (→ repo.unexpected) instead of an invalid union value
          // flowing downstream (review-run types-LOW).
          if (!isTimelineSource(row.source) || !isTimelineActorKind(row.actor_kind)) {
            throw new Error(
              `member_timeline_v emitted unknown source/actor_kind: ${row.source}/${row.actor_kind}`,
            );
          }
          const rawPayload = (row.payload ?? null) as Record<string, unknown> | null;

          if (row.source === 'audit') {
            const p = rawPayload ?? {};
            const eventType = typeof p.event_type === 'string' ? p.event_type : '';
            const actorUserId = typeof p.actor_user_id === 'string' ? p.actor_user_id : '';

            // Strip the lifted columns from the returned payload (promoted to
            // top-level fields); `summary` stays as the i18n fallback value.
            const { event_type: _et, actor_user_id: _au, ...rest } = p;
            const enriched: Record<string, unknown> = { ...rest };
            const add = (key: string, id: unknown, year: unknown): void => {
              const name = resolvePlanName(id, year);
              if (name) enriched[key] = name;
            };
            add('old_plan_name', rest.old_plan_id, rest.old_plan_year);
            add('new_plan_name', rest.new_plan_id, rest.new_plan_year);
            add('plan_name', rest.plan_id, rest.plan_year);
            add('old_includes_corporate_plan_name', rest.old_includes_corporate_plan_id, rest.old_plan_year);
            add('new_includes_corporate_plan_name', rest.new_includes_corporate_plan_id, rest.new_plan_year);

            return {
              id: row.ref_id,
              timestamp: new Date(row.occurred_at_iso),
              source: 'audit',
              eventType,
              actorKind: row.actor_kind,
              actorUserId,
              actorDisplayName: actorMap.get(actorUserId) ?? null,
              payload: Object.keys(enriched).length > 0 ? enriched : null,
            };
          }

          // Non-audit sources: no single acting user → the discriminated
          // union omits `actorUserId`; the UI renders a localized actor-kind
          // label from `actorKind`.
          return {
            id: row.ref_id,
            timestamp: new Date(row.occurred_at_iso),
            source: row.source,
            eventType: nonAuditEventKind(row.source, rawPayload),
            actorKind: row.actor_kind,
            actorDisplayName: null,
            payload: rawPayload,
          };
        });

        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last ? encodeCursor(last.occurred_at_iso, last.ref_id) : null;

        return { events, nextCursor, total } satisfies TimelineResult;
      });

      // FR-016 p95<500ms/page SLO signal — recorded on BOTH outcomes so a
      // slow-then-erroring query is visible to the latency histogram, not just
      // the error log (review-run R2 I-1).
      insightsMetrics.timelineQueryDurationMs(performance.now() - startedAt, 'ok');
      return ok(result);
    } catch (e) {
      insightsMetrics.timelineQueryDurationMs(performance.now() - startedAt, 'error');
      return err({ code: 'repo.unexpected' as const, cause: e });
    }
  },
};
