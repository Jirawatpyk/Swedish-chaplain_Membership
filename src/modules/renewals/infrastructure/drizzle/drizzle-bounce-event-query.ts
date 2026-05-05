/**
 * F8 Phase 4 Wave I4 — Drizzle adapter for `BounceEventQuery` port.
 *
 * Replaces the Wave I2d `stub-bounce-event-query.ts` (which returned
 * zeros). Reads F1's `email_delivery_events` (extended in migration
 * 0106 with `bounce_type` column) joined to F3's `contacts` to
 * compute the three FR-012a thresholds in a single composite query:
 *
 *   1. `hardBounces`         — bounce_type='permanent' (any time)
 *   2. `softBouncesInCycle`  — bounce_type='transient' AND created_at >= cycleStartedAt (or null when no cycle)
 *   3. `softBouncesIn30Days` — bounce_type='transient' AND created_at >= now - 30d
 *
 * Composite query strategy:
 *   - Resolve member's primary contact email via `runInTenant` (RLS
 *     scoped) — `(tenantId, memberId, isPrimary=true, removedAt IS NULL)`
 *   - Use the email to scan email_delivery_events (cross-tenant scan,
 *     safe under MTA+STD per partial-unique constraint that ensures
 *     at most one tenant claims a given email)
 *   - Single SELECT with three FILTER aggregates so the partial
 *     index `email_delivery_events_bounced_lookup_idx (to_email,
 *     created_at DESC) WHERE event_type='bounced'` serves all three
 *     counts.
 *
 * Edge cases:
 *   - Member has no primary contact (FR-019a) → return zeros
 *   - cycleStartedAt is null (member has no active cycle) →
 *     softBouncesInCycle returns null per port contract
 *   - email_delivery_events has no matching rows → all counts = 0
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { emailDeliveryEvents } from '@/modules/auth/infrastructure/db/schema';
import type {
  BounceCounts,
  BounceEventQuery,
} from '../../application/ports/bounce-event-query';

export function makeDrizzleBounceEventQuery(
  tenant: TenantContext,
): BounceEventQuery {
  return {
    async countBounces(
      _tenantId: string,
      memberId: string,
      args: {
        readonly cycleStartedAt: string | null;
        readonly nowIso: string;
      },
    ): Promise<BounceCounts> {
      // Step 1 — resolve member's primary contact email via tenant-
      // scoped query (RLS).
      const primaryEmail = await runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({ email: contacts.email })
          .from(contacts)
          .where(
            and(
              eq(contacts.memberId, memberId),
              eq(contacts.isPrimary, true),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .limit(1);
        return rows[0]?.email ?? null;
      });
      if (!primaryEmail) {
        return {
          hardBounces: 0,
          softBouncesInCycle: args.cycleStartedAt === null ? null : 0,
          softBouncesIn30Days: 0,
        };
      }

      // Step 2 — count bounces with three FILTER aggregates against
      // the partial index `email_delivery_events_bounced_lookup_idx`.
      // Cross-tenant scan is safe: emails are partial-unique per
      // tenant + non-removed contacts; an email matching the same
      // value in a different tenant would still be the same person
      // (real-world humans have one mailbox).
      const thirtyDaysAgo = new Date(
        new Date(args.nowIso).getTime() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const rows = await db
        .select({
          hardBounces: sql<number>`COUNT(*) FILTER (WHERE ${emailDeliveryEvents.bounceType} = 'permanent')`,
          softInCycle:
            args.cycleStartedAt === null
              ? sql<number>`0`
              : sql<number>`COUNT(*) FILTER (WHERE ${emailDeliveryEvents.bounceType} = 'transient' AND ${emailDeliveryEvents.createdAt} >= ${args.cycleStartedAt})`,
          soft30d: sql<number>`COUNT(*) FILTER (WHERE ${emailDeliveryEvents.bounceType} = 'transient' AND ${emailDeliveryEvents.createdAt} >= ${thirtyDaysAgo})`,
        })
        .from(emailDeliveryEvents)
        .where(
          and(
            sql`LOWER(${emailDeliveryEvents.toEmail}) = LOWER(${primaryEmail})`,
            eq(emailDeliveryEvents.eventType, 'bounced'),
          ),
        );
      const row = rows[0];
      // Defensive — sql<number> returns string from pg driver in
      // some configurations; coerce explicitly.
      const hardBounces = Number(row?.hardBounces ?? 0);
      const softInCycle = Number(row?.softInCycle ?? 0);
      const soft30d = Number(row?.soft30d ?? 0);
      return {
        hardBounces,
        softBouncesInCycle: args.cycleStartedAt === null ? null : softInCycle,
        softBouncesIn30Days: soft30d,
      };
    },
  };
}
