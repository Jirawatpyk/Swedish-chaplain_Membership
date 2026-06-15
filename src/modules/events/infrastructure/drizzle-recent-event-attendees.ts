/**
 * Email-centric recent-attendee query (F6 → F7 broadcasts bridge).
 *
 * F7's `event_attendees_last_90d` recipient segment needs distinct
 * attendee EMAILS who attended ≥1 event in the last 90 days (the F6
 * at-risk query in `drizzle-event-attendees-by-member.ts` is keyed by
 * MEMBER, so it can't satisfy the email-centric shape). This module owns
 * the query over F6's own tables; the broadcasts events-bridge calls it
 * through the F6 barrel (Constitution Principle III — broadcasts depends
 * on events, never imports its schema directly).
 *
 * Tenant scope: `runInTenant` sets the RLS GUC + an explicit
 * `tenant_id = ctx.slug` WHERE is defence-in-depth (Principle I).
 * Excludes pseudonymised rows (FR-032 retention-purged — un-emailable)
 * and archived events. FAIL-LOUD: any DB fault throws so the broadcast
 * recipient resolution surfaces it (a masked `[]` would silently send to
 * zero recipients — the masked-zero class F9 also avoids).
 *
 * The 90-day window is measured against the EVENT date (`e.start_date`),
 * not the registration date — this is the "re-engage people who showed
 * up to a recent event" segment (per `docs/email-broadcast-analysis.md`).
 * It uses the DB clock (`now()`) deliberately: a fixed rolling window
 * needs no caller-supplied timestamp, unlike the F8/F9 by-member adapter
 * (`drizzle-event-attendees-by-member.ts`) which takes `input.since` for
 * the benefit-usage year boundary. `start_date` is `timestamptz`, so the
 * instant comparison is timezone-agnostic.
 *
 * Pure Infrastructure — Drizzle types confined to this file.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

export interface RecentEventAttendee {
  readonly emailLower: string;
  readonly displayName: string | null;
  readonly memberId: string | null;
  readonly mostRecentEventDate: Date;
  readonly mostRecentEventTitle: string | null;
}

interface RecentAttendeeRow {
  readonly email_lower: string;
  readonly display_name: string | null;
  readonly member_id: string | null;
  readonly most_recent_event_date: Date | string;
  readonly most_recent_event_title: string | null;
}

function mapRow(r: RecentAttendeeRow): RecentEventAttendee {
  return {
    emailLower: r.email_lower,
    displayName: r.display_name,
    memberId: r.member_id,
    mostRecentEventDate:
      r.most_recent_event_date instanceof Date
        ? r.most_recent_event_date
        : new Date(r.most_recent_event_date),
    mostRecentEventTitle: r.most_recent_event_title,
  };
}

/**
 * Distinct attendees (one row per email — the most recent event's title +
 * date) who attended an event whose start_date is within the last 90 days.
 */
export async function getRecentEventAttendees(
  tenantId: string,
): Promise<ReadonlyArray<RecentEventAttendee>> {
  const ctx = asTenantContext(tenantId);
  return runInTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (er.attendee_email_lower)
        er.attendee_email_lower    AS email_lower,
        er.attendee_name           AS display_name,
        er.matched_member_id::text AS member_id,
        e.start_date               AS most_recent_event_date,
        e.name                     AS most_recent_event_title
      FROM event_registrations er
      JOIN events e
        ON e.tenant_id = er.tenant_id AND e.event_id = er.event_id
      WHERE er.tenant_id = ${ctx.slug}
        AND er.attendee_email_lower IS NOT NULL
        AND er.pii_pseudonymised_at IS NULL
        AND e.archived_at IS NULL
        AND e.start_date >= now() - interval '90 days'
      ORDER BY er.attendee_email_lower, e.start_date DESC
    `)) as unknown as RecentAttendeeRow[];
    return rows.map(mapRow);
  });
}

/**
 * Lookup a single email — used by FR-015d custom-list validation to
 * verify a pasted recipient was an event attendee in the last 90 days.
 * Returns `null` if not found.
 */
export async function getRecentEventAttendeeByEmail(
  tenantId: string,
  emailLower: string,
): Promise<RecentEventAttendee | null> {
  const ctx = asTenantContext(tenantId);
  return runInTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        er.attendee_email_lower    AS email_lower,
        er.attendee_name           AS display_name,
        er.matched_member_id::text AS member_id,
        e.start_date               AS most_recent_event_date,
        e.name                     AS most_recent_event_title
      FROM event_registrations er
      JOIN events e
        ON e.tenant_id = er.tenant_id AND e.event_id = er.event_id
      WHERE er.tenant_id = ${ctx.slug}
        AND er.attendee_email_lower = ${emailLower}
        AND er.pii_pseudonymised_at IS NULL
        AND e.archived_at IS NULL
        AND e.start_date >= now() - interval '90 days'
      ORDER BY e.start_date DESC
      LIMIT 1
    `)) as unknown as RecentAttendeeRow[];
    const first = rows[0];
    return first ? mapRow(first) : null;
  });
}
