/**
 * Audit timeline (T124 helper) — server component renders lifecycle
 * events for a broadcast from the F1-owned `audit_log` table.
 *
 * Shows: drafted → submitted → approved → sending → sent / rejected /
 * cancelled / failed_to_dispatch, plus the approval round's own steps
 * (spec 122 US12c-1 follow-up, 20 Oct): the member's approval or request
 * for changes and marketing's send-time confirmation. A round never emits
 * `broadcast_approved` (that is approve-as-submitted only).
 *
 * F1's `auditLog` schema is intentionally NOT exposed in the public
 * `@/modules/auth` barrel (Constitution Principle III — append-only
 * audit trail is owned by F1's repos). F7 reads via `db.execute(sql\`...\`)`
 * with a typed cast — same pattern F4's `audit-timeline.tsx` uses.
 */
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { CheckCircle2, Circle, CircleX } from 'lucide-react';
import { Card, Icon } from '@jirawatpyk/aura-react/server';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';

interface AuditRow {
  readonly eventType: string;
  readonly actorUserId: string;
  // Raw SQL via `db.execute` returns the column as a string when the
  // query goes through postgres.js's untyped pipeline — not a Date.
  readonly timestamp: string | Date;
  /** Resolved via LEFT JOIN users (UX-C6). Null for system actors. */
  readonly actorEmail: string | null;
  /** `broadcast_schedule_confirmed` only: how marketing set the time (`cancel` clears it). */
  readonly mode: string | null;
}

function formatActor(row: AuditRow, t: (key: string) => string): string {
  // IMP-4 (round-3) — guard against null/empty actorUserId. SQL coerces
  // via COALESCE but historical rows or future malformed inserts could
  // still arrive empty; render a stable label instead of crashing or
  // returning empty string.
  if (!row.actorUserId || row.actorUserId.length === 0) {
    return t('actorUnknown');
  }
  if (row.actorUserId.startsWith('system:')) {
    return t('actorSystem');
  }
  if (row.actorEmail !== null && row.actorEmail.length > 0) {
    return row.actorEmail;
  }
  // UX-R2-8 (round-3) — when the LEFT JOIN didn't resolve (deleted user
  // or cross-system actor), render a meaningful label. The 8-char hash
  // was opaque to SR users (read letter-by-letter); 'actorUnknown' is
  // honest. The full id stays in the title attribute for ops debugging.
  return t('actorUnknown');
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
  // The approval round's steps; these rows key the E-Blast as `broadcast_id`.
  'broadcast_member_approved',
  'broadcast_member_changes_requested',
  'broadcast_schedule_confirmed',
] as const;

type TimelineLabelKey =
  | 'drafted'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'sendStarted'
  | 'sent'
  | 'failedToDispatch'
  | 'memberApproved'
  | 'memberChangesRequested'
  | 'scheduleConfirmed'
  | 'scheduleCancelled';

const LABEL_KEY: Record<string, TimelineLabelKey> = {
  broadcast_drafted: 'drafted',
  broadcast_submitted: 'submitted',
  broadcast_approved: 'approved',
  broadcast_rejected: 'rejected',
  broadcast_cancelled: 'cancelled',
  broadcast_send_started: 'sendStarted',
  broadcast_sent: 'sent',
  broadcast_failed_to_dispatch: 'failedToDispatch',
  broadcast_member_approved: 'memberApproved',
  broadcast_member_changes_requested: 'memberChangesRequested',
};

/** The label key for one audit row; a schedule `cancel` reads differently from a confirmation. */
export function timelineLabelKey(eventType: string, mode: string | null): TimelineLabelKey | null {
  if (eventType === 'broadcast_schedule_confirmed') return mode === 'cancel' ? 'scheduleCancelled' : 'scheduleConfirmed';
  return LABEL_KEY[eventType] ?? null;
}

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
    getDateFormatLocale(locale),
    // Tenant-TZ pin (#315 follow-up, server-UTC display class): audit
    // instants rendered by the UTC Vercel runtime were 7h off for the
    // Bangkok admin. Canonical tenant TZ (erasure-log precedent).
    { dateStyle: 'medium', timeStyle: 'short', timeZone: env.tenant.timezone },
  );

  // Raw SQL via Drizzle `sql` template (auditLog schema is NOT exposed
  // by the F1 barrel — Principle III preserves append-only ownership).
  // LEFT JOIN users to surface actor email for SR users (UX-C6 — "who
  // approved?"). System actors (`system:cron`) carry their literal
  // string in actorUserId so the display falls back to `t('actorSystem')`.
  //
  // CRIT-1 (round-3) — query goes through `runInTenant` so RLS+FORCE on
  // `audit_log` applies (Constitution v1.4.0 Principle I two-layer
  // isolation; the `WHERE al.tenant_id = ...` clause is the in-app
  // filter; RLS is the database-layer enforcement).
  // postgres.js `sql` template tag does not auto-cast JS string[] into
  // PG `text[]`; pass it as an explicit ARRAY[...] literal so the
  // `= ANY(...)` operator gets the correct type. RELEVANT_EVENTS is a
  // const tuple of safe enum literals — string-interpolation here is
  // safe (no user input).
  const tenantCtx = asTenantContext(tenantId);
  const eventList = sql.raw(
    `(${RELEVANT_EVENTS.map((e) => `'${e}'`).join(',')})`,
  );
  const rows = (await runInTenant(tenantCtx, async (tx) =>
    tx.execute(sql`
      SELECT al.event_type::text                           AS "eventType",
             COALESCE(al.actor_user_id, '')                AS "actorUserId",
             al.timestamp                                  AS "timestamp",
             u.email                                       AS "actorEmail",
             al.payload->>'mode'                           AS "mode"
        FROM audit_log al
        LEFT JOIN users u ON u.id::text = al.actor_user_id
       WHERE al.tenant_id = ${tenantId}
         AND (al.payload->>'broadcastId' = ${broadcastId}
              OR al.payload->>'broadcast_id' = ${broadcastId})
         AND al.event_type::text IN ${eventList}
       ORDER BY al.timestamp ASC
    `),
  )) as unknown as ReadonlyArray<AuditRow>;
  const events = rows;

  return (
    <AuditTimelineView
      title={t('title')}
      events={events.map((r) => {
        const ts = new Date(r.timestamp);
        const labelKey = timelineLabelKey(r.eventType, r.mode);
        return {
          key: `${r.eventType}-${ts.getTime()}`,
          failed: r.eventType === 'broadcast_failed_to_dispatch',
          label: labelKey === null ? r.eventType : t(labelKey),
          instant: ts.toISOString(),
          when: fmt.format(ts),
          actor: t('actorBy', { actor: formatActor(r, t) }),
          actorId: r.actorUserId,
        };
      })}
    />
  );
}

export interface AuditTimelineEvent {
  readonly key: string;
  readonly label: string;
  /** ISO 8601 UTC instant, for `<time dateTime>`. */
  readonly instant: string;
  /** The instant formatted in the tenant's time zone. */
  readonly when: string;
  /** "by …", already localised. */
  readonly actor: string;
  /** The raw actor id, kept in the title attribute for ops debugging. */
  readonly actorId: string;
  /** A failed dispatch: a danger cross, never the success check (board `Admin-eblast-failed`). */
  readonly failed?: boolean;
}

/**
 * Spec 122 US12c-1 (parity comment, 20 Oct; board `Admin-broadcast-review`)
 * — the timeline as an AURA card titled at h2 like the page's other cards: a
 * hollow circle per past step, a check on the latest. Split from the loader so
 * the preview harness can render it without a database.
 */
export function AuditTimelineView({
  title,
  events,
}: {
  readonly title: string;
  readonly events: ReadonlyArray<AuditTimelineEvent>;
}): React.ReactElement {
  return (
    <Card titleId="eblast-audit-title" title={title} headingLevel={2}>
      {events.length === 0 ? (
        <p className="aura-text-body text-[var(--aura-fg-secondary)]">—</p>
      ) : (
        <ol className="flex flex-col gap-[var(--aura-space-4)]">
          {events.map((e, idx) => {
            const latest = idx === events.length - 1;
            return (
              <li key={e.key} data-step={latest ? 'latest' : 'past'} className="flex items-start gap-[var(--aura-space-3)]">
                <span
                  className={
                    e.failed === true
                      ? 'mt-0.5 shrink-0 text-[var(--aura-fg-danger)]'
                      : latest
                        ? 'mt-0.5 shrink-0 text-[var(--aura-fg-positive)]'
                        : 'mt-0.5 shrink-0 text-[var(--aura-fg-secondary)]'
                  }
                >
                  <Icon name={e.failed === true ? <CircleX /> : latest ? <CheckCircle2 /> : <Circle />} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="aura-text-body font-semibold">{e.label}</p>
                  <div className="aura-text-caption text-[var(--aura-fg-secondary)] break-words tabular-nums">
                    <time dateTime={e.instant}>{e.when}</time>
                    <span className="mx-1.5" aria-hidden="true">
                      ·
                    </span>
                    <span title={e.actorId || undefined}>{e.actor}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
