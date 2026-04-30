/**
 * Audit timeline (T124 helper) — server component renders lifecycle
 * events for a broadcast from `audit_log`.
 *
 * Shows: drafted → submitted → approved → sending → sent / rejected /
 * cancelled / failed_to_dispatch.
 *
 * Uses Drizzle ORM with the F1-owned `auditLog` schema + JSONB
 * predicate via `sql` template literal (Drizzle's documented escape
 * hatch — there is no first-class `->>` operator in core ORM as of
 * drizzle-orm@latest). The schema import keeps cross-module access
 * within the public Drizzle surface; raw `db.execute(sql\`SELECT…\`)`
 * is avoided so the column projection stays type-checked.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { CheckCircle2, Circle } from 'lucide-react';

interface AuditRow {
  readonly eventType: string;
  readonly actorUserId: string;
  readonly timestamp: Date;
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

  // Drizzle ORM query against the F1-owned `auditLog` schema. JSON-path
  // predicate uses `sql\`...\`` template (no first-class JSONB `->>`
  // operator in Drizzle core) but the SELECT/WHERE/ORDER BY use typed
  // column refs so any rename of the schema is caught at compile time.
  const events = (await db
    .select({
      eventType: auditLog.eventType,
      actorUserId: auditLog.actorUserId,
      timestamp: auditLog.timestamp,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        sql`${auditLog.payload}->>'broadcastId' = ${broadcastId}`,
        inArray(
          auditLog.eventType,
          RELEVANT_EVENTS as unknown as Array<typeof auditLog.eventType._.data>,
        ),
      ),
    )
    .orderBy(asc(auditLog.timestamp))) as ReadonlyArray<AuditRow>;

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
            <li
              key={`${r.eventType}-${r.timestamp.getTime()}`}
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
                  {fmt.format(new Date(r.timestamp))}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
