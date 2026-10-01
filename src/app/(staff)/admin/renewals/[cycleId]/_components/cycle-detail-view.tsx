/**
 * 122 US7b-1 (T721) — the cycle detail page's body, shared by the page and the
 * no-DB preview route (`/test-fixtures/aura-admin?view=renewal-cycle`), so the
 * screenshots show the page itself. Boards `Admin-renewal-cycle` (+
 * `-reminded`, `-pending`, `-mobile`).
 *
 * The page keeps the data and the formatting (dates in the tenant's zone,
 * money through next-intl), its `DetailContainer` and its `PageHeader` with
 * the actions (check:layout reads the page file). This renders what sits
 * under the header: the state notices, the four cards and the phone danger
 * zone. Spec Clarifications, Session 2026-10-01 (US7b start).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BellOff } from 'lucide-react';
import { Alert, Badge, Card, StatusPill, type StatusPillProps } from '@jirawatpyk/aura-react/server';
import { EmptyState } from '@/components/shell/empty-state';
import { TierBadge } from '@/components/renewals/tier-badge';
import type { CycleStatus, TierBucket } from '@/modules/renewals/client';
import { CycleStatusBadge } from './cycle-status-badge';

type Tone = NonNullable<StatusPillProps['tone']>;

/** Invoice status pill tones, as the member-detail invoices table draws them. */
const INVOICE_TONE: Readonly<Record<string, Tone>> = {
  draft: 'neutral',
  issued: 'progress',
  paid: 'ready',
};

/** A sent reminder is done; a failed one needs a look; the rest are neutral. */
const REMINDER_TONE: Readonly<Record<string, Tone>> = {
  sent: 'ready',
  failed: 'blocked',
};

/** An open task is in progress; a done one is done; a skipped one is neutral. */
const TASK_TONE: Readonly<Record<string, Tone>> = {
  open: 'progress',
  done: 'ready',
};

/** An in-text link: accent, underlined on hover (the contact block's style). */
const LINK_CLASS = 'font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline';

export interface CycleDetailBadgesProps {
  readonly status: CycleStatus;
  readonly statusLabel: string;
  readonly statusSrSuffix: string | null;
  /** The already-rejected, refund-settling marker (its own badge). */
  readonly refundSettlingLabel: string | null;
}

/**
 * The status pill beside "Cycle detail · {company}" (C-2, UX R3; the board's
 * header). Passed to `PageHeader`'s `badge`, so it keeps the body type rather
 * than the heading's.
 */
export function CycleDetailBadges({
  status,
  statusLabel,
  statusSrSuffix,
  refundSettlingLabel,
}: CycleDetailBadgesProps) {
  return (
    <>
      <CycleStatusBadge status={status} label={statusLabel} srSuffix={statusSrSuffix} />
      {refundSettlingLabel ? <Badge tone="warning">{refundSettlingLabel}</Badge> : null}
    </>
  );
}

export interface CycleDetailViewProps {
  readonly status: CycleStatus;
  /** A pending cycle an admin already rejected; its refund is settling. */
  readonly refundSettling: boolean;
  /** The member / plan lookup failure line (with the request id), or null. */
  readonly lookupFailedMessage: string | null;
  readonly memberPlan: {
    readonly company: string;
    /** The member's detail page; null when the member lookup failed. */
    readonly memberHref: string | null;
    readonly primaryContact: string;
    readonly tier: TierBucket;
    readonly planName: string;
    readonly frozenPrice: string;
    readonly term: string;
    readonly currency: string;
    readonly technicalIds: {
      readonly cycleId: string;
      readonly memberId: string;
      readonly planId: string;
    };
  };
  readonly invoice: {
    /** The printed number, or the invoice id's first 8 characters. */
    readonly number: string;
    readonly status: string;
    readonly statusLabel: string;
    readonly total: string;
    readonly href: string;
  } | null;
  /** Why there is no invoice yet (not generated, or none linked). */
  readonly invoicePendingMessage: string;
  /** Period from / to, expiry, and the state's own dates, formatted. */
  readonly period: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly auditTimestamps: { readonly createdAt: string; readonly updatedAt: string };
  readonly reminders: ReadonlyArray<{
    readonly id: string;
    readonly stepId: string;
    readonly status: string;
    readonly statusLabel: string;
    readonly date: string | null;
    readonly channel: string;
  }>;
  readonly escalations: ReadonlyArray<{
    readonly id: string;
    readonly typeLabel: string;
    readonly status: string;
    readonly statusLabel: string;
    readonly date: string;
    readonly role: string;
  }>;
  /** The phone-only danger zone (Cancel cycle); null when there is none. */
  readonly dangerZone?: ReactNode;
}

export async function renderCycleDetailView({
  status,
  refundSettling,
  lookupFailedMessage,
  memberPlan,
  invoice,
  invoicePendingMessage,
  period,
  auditTimestamps,
  reminders,
  escalations,
  dangerZone,
}: CycleDetailViewProps) {
  const t = await getTranslations('admin.renewals.cycleDetail');
  const f = (key: string) => t(`fields.${key}`);

  return (
    <>
      {/* UX-A Bug 2: an already-rejected pending cycle reads as settling, not
          as a decision still to make. Both notices are standing page text. */}
      {status === 'pending_admin_reactivation' &&
        (refundSettling ? (
          <Alert tone="warning" role="status" title={t('refundSettlingNoticeTitle')}>
            {t('refundSettlingNoticeBody')}
          </Alert>
        ) : (
          <Alert tone="warning" role="status" title={t('pendingNoticeTitle')}>
            {t('pendingNoticeBody')}
          </Alert>
        ))}
      {/* 066 §4.4(4) — a terminated membership's bill can't be paid in place;
          the reactivate-first path is spelled out. */}
      {status === 'lapsed' && (
        <Alert tone="warning" role="note" title={t('terminatedCallout.title')}>
          {t('terminatedCallout.body')}
        </Alert>
      )}
      {lookupFailedMessage ? (
        <Alert tone="info" title={t('lookupFailedTitle')}>
          {lookupFailedMessage}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-[var(--aura-space-5)] lg:grid-cols-2">
        {/* I-4 (UX R3): always rendered, so a missing invoice is explained.
            First in the DOM, so on a phone it is first for sight, keyboard and
            screen reader alike (board Admin-renewal-cycle-mobile); from 1024px
            Member & plan takes the top left. */}
        <Card
          as="section"
          title={t('sectionInvoice')}
          headingLevel={2}
          titleId="cycle-detail-invoice-heading"
        >
          {invoice ? (
            <div className="flex flex-col gap-[var(--aura-space-4)]">
              <FieldList>
                <Field label={f('invoiceNumber')}>
                  <span className="aura-text-mono">{invoice.number}</span>
                </Field>
                <Field label={f('invoiceStatus')}>
                  <StatusPill tone={INVOICE_TONE[invoice.status] ?? 'neutral'}>{invoice.statusLabel}</StatusPill>
                </Field>
                <Field label={f('invoiceTotal')}>
                  <span className="font-semibold tabular-nums">{invoice.total}</span>
                </Field>
              </FieldList>
              <Link href={invoice.href} className={`inline-flex self-start text-sm max-sm:min-h-11 max-sm:items-center ${LINK_CLASS}`}>
                {t('fields.viewInvoice', { number: invoice.number })}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-[var(--aura-fg-secondary)]">{invoicePendingMessage}</p>
          )}
        </Card>

        <Card
          as="section"
          title={t('sectionMemberPlan')}
          headingLevel={2}
          titleId="cycle-detail-card-heading"
          className="lg:order-first"
        >
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            <FieldList>
              <Field label={f('companyName')}>
                {memberPlan.memberHref ? (
                  <Link href={memberPlan.memberHref} className={LINK_CLASS}>
                    {memberPlan.company}
                  </Link>
                ) : (
                  memberPlan.company
                )}
              </Field>
              <Field label={f('primaryContact')}>{memberPlan.primaryContact}</Field>
              <Field label={f('tier')}>
                <TierBadge tier={memberPlan.tier} />
              </Field>
              <Field label={f('planName')}>{memberPlan.planName}</Field>
              <Field label={f('frozenPrice')}>
                <span className="tabular-nums">{memberPlan.frozenPrice}</span>
              </Field>
              <Field label={f('frozenTerm')}>{memberPlan.term}</Field>
              <Field label={f('frozenCurrency')}>{memberPlan.currency}</Field>
            </FieldList>
            {/* Forensic ids for support tickets (UX R5 / S6: deep-linkable). */}
            <Disclosure id="cycle-technical-ids" summary={f('showTechnicalIds')}>
              <Field label={f('cycleId')} mono>{memberPlan.technicalIds.cycleId}</Field>
              <Field label={f('memberId')} mono>{memberPlan.technicalIds.memberId}</Field>
              <Field label={f('planId')} mono>{memberPlan.technicalIds.planId}</Field>
            </Disclosure>
          </div>
        </Card>

        <Card as="section" title={t('sectionPeriod')} headingLevel={2} titleId="cycle-detail-period-heading">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            <FieldList>
              {period.map((row) => (
                <Field key={row.label} label={row.label}>
                  {row.value}
                </Field>
              ))}
            </FieldList>
            {/* S-2 (UX R3): audit timestamps are forensic-only. */}
            <Disclosure summary={f('showAuditTimestamps')}>
              <Field label={f('createdAt')}>{auditTimestamps.createdAt}</Field>
              <Field label={f('updatedAt')}>{auditTimestamps.updatedAt}</Field>
            </Disclosure>
          </div>
        </Card>

        <Card as="section" title={t('sectionActivity')} headingLevel={2} titleId="cycle-detail-activity-heading">
          {reminders.length === 0 && escalations.length === 0 ? (
            <EmptyState
              icon={BellOff}
              title={t('noActivityTitle')}
              description={t('noActivityDescription')}
              bordered={false}
            />
          ) : (
            <div className="flex flex-col gap-[var(--aura-space-2)]">
              {reminders.length > 0 && (
                <ActivityList headingId="cycle-detail-reminders-heading" heading={t('reminders.heading')}>
                  {reminders.map((r) => (
                    <ActivityRow
                      key={r.id}
                      name={<span className="aura-text-mono [overflow-wrap:anywhere]">{r.stepId}</span>}
                      pill={<StatusPill tone={REMINDER_TONE[r.status] ?? 'neutral'}>{r.statusLabel}</StatusPill>}
                      meta={[r.date, r.channel]}
                    />
                  ))}
                </ActivityList>
              )}
              {escalations.length > 0 && (
                <ActivityList headingId="cycle-detail-escalations-heading" heading={t('escalations.heading')}>
                  {escalations.map((task) => (
                    <ActivityRow
                      key={task.id}
                      name={task.typeLabel}
                      pill={<StatusPill tone={TASK_TONE[task.status] ?? 'neutral'}>{task.statusLabel}</StatusPill>}
                      meta={[task.date, task.role]}
                    />
                  ))}
                </ActivityList>
              )}
            </div>
          )}
        </Card>
      </div>

      {dangerZone ? (
        <section
          aria-label={t('dangerZone')}
          className="flex flex-col gap-[var(--aura-space-2)] border-t border-[var(--aura-border-default)] pt-[var(--aura-space-3)] sm:hidden"
        >
          {dangerZone}
        </section>
      ) : null}
    </>
  );
}

/** Two columns of label-over-value pairs (the board's card lists). */
function FieldList({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-[var(--aura-space-6)] gap-y-[var(--aura-space-4)]">{children}</dl>
  );
}

function Field({
  label,
  mono = false,
  children,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className={mono ? 'm-0 aura-text-mono text-xs [overflow-wrap:anywhere]' : 'm-0 text-sm break-words'}>
        {children}
      </dd>
    </div>
  );
}

function Disclosure({
  id,
  summary,
  children,
}: {
  readonly id?: string;
  readonly summary: string;
  readonly children: ReactNode;
}) {
  return (
    <details {...(id ? { id } : {})}>
      <summary className="flex min-h-11 cursor-pointer items-center text-[13px] text-[var(--aura-fg-secondary)]">
        {summary}
      </summary>
      <div className="pt-[var(--aura-space-2)]">
        <FieldList>{children}</FieldList>
      </div>
    </details>
  );
}

function ActivityList({
  headingId,
  heading,
  children,
}: {
  readonly headingId: string;
  readonly heading: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="not-first:mt-[var(--aura-space-2)]">
      <h3 id={headingId} className="m-0 pb-[var(--aura-space-2)] text-sm font-semibold">
        {heading}
      </h3>
      <ul className="m-0 list-none p-0">{children}</ul>
    </section>
  );
}

/**
 * One activity row: name, pill, then date and channel or role. A row on a
 * desktop; on a phone the name and pill share the first line and the rest
 * reads "2 Sep 2026 · Task" underneath (board Admin-renewal-cycle-mobile).
 */
function ActivityRow({
  name,
  pill,
  meta,
}: {
  readonly name: ReactNode;
  readonly pill: ReactNode;
  readonly meta: ReadonlyArray<string | null>;
}) {
  const parts = meta.filter((m): m is string => m !== null && m !== '');
  return (
    <li className="flex flex-col gap-1 border-t border-[var(--aura-border-default)] py-2.5 text-[13px] sm:grid sm:min-h-11 sm:grid-cols-[minmax(0,1fr)_5.5rem_12rem_9rem] sm:items-center sm:gap-x-[var(--aura-space-3)] sm:py-1">
      <span className="flex min-w-0 items-center justify-between gap-[var(--aura-space-2)] sm:contents">
        <span className="min-w-0 text-sm sm:text-[13px]">{name}</span>
        <span className="shrink-0">{pill}</span>
      </span>
      <span className="text-xs text-[var(--aura-fg-secondary)] sm:hidden">{parts.join(' · ')}</span>
      {parts.map((part) => (
        <span key={part} className="hidden text-[var(--aura-fg-secondary)] sm:inline">
          {part}
        </span>
      ))}
    </li>
  );
}
