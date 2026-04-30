/**
 * Audit timeline (T124 helper) — server component renders lifecycle
 * events for a broadcast from `audit_log` table.
 *
 * Shows: drafted → submitted → approved → sending → sent / rejected /
 * cancelled / failed_to_dispatch.
 */
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/lib/db';
import { CheckCircle2, Circle } from 'lucide-react';

interface AuditRow {
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly created_at: Date;
}

const RELEVANT_EVENTS = new Set([
  'broadcast_drafted',
  'broadcast_submitted',
  'broadcast_approved',
  'broadcast_send_started',
  'broadcast_sent',
  'broadcast_rejected',
  'broadcast_cancelled',
  'broadcast_failed_to_dispatch',
]);

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

  const rows = (await db.execute(sql`
    SELECT event_type::text AS event_type,
           actor_user_id,
           created_at
      FROM audit_log
     WHERE tenant_id = ${tenantId}
       AND payload->>'broadcastId' = ${broadcastId}
     ORDER BY created_at ASC
  `)) as unknown as ReadonlyArray<AuditRow>;

  const events = rows.filter((r) => RELEVANT_EVENTS.has(r.event_type));

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
          {events.map((r, idx) => (
            <li key={`${r.event_type}-${idx}`} className="flex items-start gap-3">
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
                  {eventLabel[r.event_type] ?? r.event_type}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {fmt.format(new Date(r.created_at))}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
