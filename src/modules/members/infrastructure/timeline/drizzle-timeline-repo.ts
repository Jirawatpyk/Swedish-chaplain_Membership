/**
 * T130 infra — Drizzle implementation of TimelinePort (US6).
 *
 * Queries the F1+F2+F3 `audit_log` table filtered by
 * `payload->>'member_id' = $memberId`, ordered by `timestamp DESC, id DESC`,
 * using cursor-based pagination over the `(timestamp, id)` tuple.
 *
 * The existing index `audit_log_member_id_idx ON audit_log ((payload->>'member_id'))`
 * (created in migration 0009) accelerates this filter.
 *
 * Tenant scoping: uses `runInTenant` which sets `app.current_tenant` — the
 * audit_log RLS policy (`tenant_id IS NULL OR tenant_id = current_setting(...)`)
 * filters automatically.
 */
import { sql, inArray } from 'drizzle-orm';
import { ok, err } from '@/lib/result';
import { runInTenant, db } from '@/lib/db';
import { auditLog, users } from '@/modules/auth/infrastructure/db/schema';
import type {
  TimelinePort,
  TimelineFilter,
  TimelineResult,
  TimelineEvent,
} from '../../application/ports/timeline-port';

/**
 * Decode a base64-encoded cursor `<iso-timestamp>|<uuid>` into its
 * constituent parts. Returns null on malformed input (defensive — a
 * tampered cursor simply resets to page 1 from the API caller's POV).
 */
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const sep = decoded.indexOf('|');
    if (sep < 0) return null;
    const ts = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!ts || !id) return null;
    // Basic sanity check — ts should be ISO-ish
    if (Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

export const drizzleTimelineRepo: TimelinePort = {
  async listByMember(ctx, filter: TimelineFilter) {
    try {
      const { memberId, cursor, limit } = filter;

      const result = await runInTenant(ctx, async (tx) => {
        // Member-scoped WHERE — shared between count and page queries.
        const memberScope = sql`(${auditLog.payload}->>'member_id' = ${memberId} OR ${auditLog.payload}->>'related_member_id' = ${memberId})`;

        // Count runs against the full member-scoped set (no cursor) so
        // the number stays stable as the user pages through.
        const totalRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(memberScope);
        const total = totalRows[0]?.n ?? 0;

        // Build the WHERE clause fragments for the page query
        const conditions: ReturnType<typeof sql>[] = [memberScope];

        // Cursor pagination: `(timestamp, id) < ($cursor_ts, $cursor_id)`
        const cursorParts = cursor ? decodeCursor(cursor) : null;
        if (cursorParts) {
          conditions.push(
            sql`(${auditLog.timestamp}, ${auditLog.id}) < (${cursorParts.ts}::timestamptz, ${cursorParts.id}::uuid)`,
          );
        }

        const whereClause = conditions.reduce(
          (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`),
        );

        // Fetch limit+1 to determine if there's a next page
        const rows = await tx
          .select({
            id: auditLog.id,
            timestamp: auditLog.timestamp,
            eventType: auditLog.eventType,
            actorUserId: auditLog.actorUserId,
            summary: auditLog.summary,
            payload: auditLog.payload,
          })
          .from(auditLog)
          .where(whereClause)
          .orderBy(sql`${auditLog.timestamp} DESC, ${auditLog.id} DESC`)
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;

        // Resolve actor display names for UUID actors. Synthetic actors
        // ('system', 'anonymous', 'system:bootstrap') are skipped. Uses a
        // single IN-list query — cross-tenant safe because we only return
        // display_name + email, never expose full user records.
        const uuidActorIds = Array.from(
          new Set(
            pageRows
              .map((r) => r.actorUserId)
              .filter(
                (id) =>
                  typeof id === 'string' &&
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    id,
                  ),
              ),
          ),
        );

        const actorMap = new Map<string, string>();
        if (uuidActorIds.length > 0) {
          // Use the outer db (NOT the tx) because users live in the auth
          // schema with its own RLS-bypassing chamber_app grant — the
          // SET LOCAL app.current_tenant does not apply to users queries.
          const rows = await db
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
            })
            .from(users)
            .where(inArray(users.id, uuidActorIds));
          for (const r of rows) {
            actorMap.set(r.id, r.displayName ?? r.email);
          }
        }

        const events: TimelineEvent[] = pageRows.map((row) => ({
          id: row.id,
          timestamp: row.timestamp,
          eventType: row.eventType,
          actorUserId: row.actorUserId,
          actorDisplayName: actorMap.get(row.actorUserId) ?? null,
          summary: row.summary,
          payload: (row.payload as Record<string, unknown>) ?? null,
        }));

        const nextCursor = hasMore && pageRows.length > 0
          ? encodeCursor(
              pageRows[pageRows.length - 1]!.timestamp,
              pageRows[pageRows.length - 1]!.id,
            )
          : null;

        return { events, nextCursor, total } satisfies TimelineResult;
      });

      return ok(result);
    } catch (e) {
      return err({ code: 'repo.unexpected' as const, cause: e });
    }
  },
};
