/**
 * Audit timeline (T124 helper) — server component renders lifecycle
 * events for a broadcast from the F1-owned `audit_log` table.
 *
 * Shows: drafted → submitted → approved → sending → sent / rejected /
 * cancelled / failed_to_dispatch.
 *
 * F1's `auditLog` schema is intentionally NOT exposed in the public
 * `@/modules/auth` barrel (Constitution Principle III — append-only
 * audit trail is owned by F1's repos). F7 reads via `db.execute(sql\`...\`)`
 * with a typed cast — same pattern F4's `audit-timeline.tsx` uses.
 */
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/lib/db';
import { CheckCircle2, Circle } from 'lucide-react';

interface AuditRow {
  readonly eventType: string;
  readonly actorUserId: string;
  // Raw SQL via `db.execute` returns the column as a string when the
  // query goes through postgres.js's untyped pipeline — not a Date.
  readonly timestamp: string | Date;
}

const RELEVANT_EVENTS = [
  'broadcast_drafted',
  'broadcast_submitted',
  'broadcast_approved',
  'broadcast_send_started',
  'broadcast_sent',
  'broadcast_rejected',
  'broadcast_cancelled',
  'broadcast_failed_to_dispatch',
] as const;

export interface AuditTimelineProps {
  readonly tenantId: string;
  readonly broadcastId: string;
}

export async function AuditTimeline({
  tenantId,
  broadcastId,
}: AuditTimelineProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.review.audit');
  const locale = await getLocale();
  const fmt = new Intl.DateTimeFormat(
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium', timeStyle: 'short' },
  );

  // Raw SQL via Drizzle `sql` template (auditLog schema is NOT exposed
  // by the F1 barrel — Principle III preserves append-only ownership).
  // The result is cast to a typed `AuditRow` shape; SELECT columns
  // mirror the F1-defined audit_log table (id, timestamp, event_type,
  // actor_user_id, summary, request_id, payload, tenant_id).
  const rows = (await db.execute(sql`
    SELECT event_type::text AS "eventType",
           actor_user_id    AS "actorUserId",
           timestamp        AS "timestamp"
      FROM audit_log
     WHERE tenant_id = ${tenantId}
       AND payload->>'broadcastId' = ${broadcastId}
       AND event_type::text = ANY(${sql.raw(`ARRAY[${RELEVANT_EVENTS.map((e) => `'${e}'`).join(', ')}]::text[]`)})
     ORDER BY timestamp ASC
  `)) as unknown as ReadonlyArray<AuditRow>;
  const events = rows;

  const eventLabel: Record<string, string> = {
    broadcast_drafted: t('drafted'),
    broadcast_submitted: t('submitted'),
    broadcast_approved: t('approved'),
    broadcast_rejected: t('rejected'),
    broadcast_cancelled: t('cancelled'),
    broadcast_send_started: t('sendStarted'),
    broadcast_sent: t('sent'),
    broadcast_failed_to_dispatch: t('failedToDispatch'),
  };

  return (
    <section
      aria-label={t('title')}
      className="rounded-md border bg-muted/20 p-4"
    >
      <h3 className="mb-3 text-sm font-semibold">{t('title')}</h3>
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <ol className="space-y-2">
          {events.map((r, idx) => {
            const ts = new Date(r.timestamp);
            return (
              <li
                key={`${r.eventType}-${ts.getTime()}`}
                className="flex items-start gap-3"
              >
                {idx === events.length - 1 ? (
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {eventLabel[r.eventType] ?? r.eventType}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {fmt.format(ts)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
