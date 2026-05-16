/**
 * F5 Phase 5 (T097+T098+T099) — Admin invoice payment timeline panel.
 *
 * Server Component. Reads the F5 payment + refund rows tied to the
 * invoice via the `loadInvoicePaymentActivity` use-case (NO direct
 * Drizzle access here — Constitution Principle III), synthesizes the
 * chronological event list, resolves staff actor emails, and renders
 * a shadcn `<Card>` timeline with:
 *   - Per-event icon (Lucide) + i18n title + actor + ISO timestamp
 *     (Thai Buddhist Era for `th` locale via existing F4 formatDate).
 *   - Processor charge id chip with copy-to-clipboard action +
 *     "View in Stripe" dashboard click-through (target=_blank +
 *     rel=noopener,noreferrer).
 *   - Empty-state when there is no payment activity.
 *
 * Manager + admin both render the timeline (read-only RBAC); the
 * mutating triggers (record-payment / void / refund) are gated
 * elsewhere by `isAdmin` checks on the parent page.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowDownToLineIcon,
  BanknoteIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  InfoIcon,
  RefreshCcwIcon,
  XCircleIcon,
  XOctagonIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  SYSTEM_ACTOR_STRIPE_WEBHOOK,
  SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
  type LoadInvoicePaymentActivityOutput,
  type RefundActivityDto,
} from '@/modules/payments';
// E1: request-scoped cached loader
// dedups the activity query between page.tsx (refund-button gating)
// and this Suspense'd timeline panel — same args within one request
// → one DB roundtrip instead of two.
import { getInvoicePaymentActivity } from '../_lib/cached-payment-activity';
// Same direct-repo escape hatch already used elsewhere in the admin
// detail page (settings repo, credit-note repo) — F1 has no
// Application-layer `getStaffUser` use-case yet, and we only need a
// read-only `userId → email` resolution for actor display.
// eslint-disable-next-line no-restricted-imports
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asUserId } from '@/modules/auth';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { CopyChargeIdButton } from './copy-charge-id-button';

type SyntheticEventType =
  | 'payment_initiated'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_canceled'
  | 'invoice_paid'
  | 'refund_initiated'
  | 'refund_succeeded'
  | 'refund_failed';

export interface TimelineEvent {
  readonly id: string;
  readonly type: SyntheticEventType;
  readonly timestamp: Date;
  readonly actorUserId: string;
  readonly subjectId: string; // paymentId or refundId
}

// Detect non-human actors: either the legacy "system:..." string prefix
// (used by some F5 audit emit paths) OR the canonical reserved UUID
// `SYSTEM_ACTOR_STRIPE_WEBHOOK` from migration 0041 — which is what F4
// `payment_recorded_by_user_id` actually carries on online payments.
// Pre-fix: only the prefix branch matched, so the UUID slipped past the
// filter into `userRepo.findById` and rendered the seeded internal email
// `system-stripe-webhook@chamber-os.internal` instead of the i18n
// `actorSystem` label.
const SYSTEM_ACTOR_PREFIX = 'system:';
function isSystemActor(actorUserId: string): boolean {
  return (
    actorUserId.startsWith(SYSTEM_ACTOR_PREFIX) ||
    actorUserId === SYSTEM_ACTOR_STRIPE_WEBHOOK
  );
}

/**
 * Format an event timestamp for display on the timeline.
 *
 * Verify-fix U-I6 (2026-04-26): the previous comment claimed this used
 * "Thai Buddhist Era for `th` locale via existing F4 formatDate" but
 * the code was actually a fresh `toLocaleString` call. Modern V8 / ICU
 * (Node 22 LTS, current Chrome / Firefox / Safari) DOES return BE for
 * the `th-TH` locale by default — verified via `new Date().toLocaleString('th-TH', {year:'numeric'})` → `"2569"` — so the off-by-543-years
 * concern is a false positive on the runtime targets we ship to. The
 * comment is now explicit so future readers don't repeat the audit.
 *
 * Storage stays ISO UTC (CLAUDE.md). This helper is display-only.
 */
function formatTimestamp(date: Date, locale: string): string {
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * F5R1-S8 — record-driven event visual table. The previous two
 * switch statements (`eventIcon` + `eventIconClass`) duplicated the
 * 8-value SyntheticEventType key list across ~40 lines. The
 * `Record<SyntheticEventType, ...>` shape forces compile-time
 * exhaustiveness: if a new SyntheticEventType variant is added, the
 * Record literal must list it OR the file fails to compile.
 *
 * emerald-600 + dark:emerald-400 keeps the success-icon contrast
 * ≥ 4.5:1 in both themes (WCAG 1.4.11) — pre-fix emerald-600 alone
 * failed dark-mode on `bg-card`.
 */
const EVENT_VISUAL: Record<
  SyntheticEventType,
  { icon: typeof BanknoteIcon; cls: string }
> = {
  payment_initiated: { icon: BanknoteIcon, cls: 'text-foreground' },
  payment_succeeded: {
    icon: CheckCircle2Icon,
    cls: 'text-emerald-600 dark:text-emerald-400',
  },
  payment_failed: { icon: XCircleIcon, cls: 'text-destructive' },
  payment_canceled: { icon: XOctagonIcon, cls: 'text-muted-foreground' },
  invoice_paid: {
    icon: CheckCircle2Icon,
    cls: 'text-emerald-600 dark:text-emerald-400',
  },
  refund_initiated: { icon: RefreshCcwIcon, cls: 'text-foreground' },
  refund_succeeded: {
    icon: ArrowDownToLineIcon,
    cls: 'text-emerald-600 dark:text-emerald-400',
  },
  refund_failed: { icon: XCircleIcon, cls: 'text-destructive' },
};

function eventIcon(type: SyntheticEventType) {
  return EVENT_VISUAL[type]?.icon ?? InfoIcon;
}

function eventIconClass(type: SyntheticEventType): string {
  return EVENT_VISUAL[type]?.cls ?? 'text-foreground';
}

function buildStripeDashboardUrl(
  environment: 'test' | 'live',
  chargeOrIntentId: string,
): string {
  // Stripe dashboard accepts both charge ids (`ch_*`) and PaymentIntent
  // ids (`pi_*`) on `/payments/{id}`. Test-mode lives under `/test/`.
  const segment = environment === 'test' ? 'test/' : '';
  return `https://dashboard.stripe.com/${segment}payments/${chargeOrIntentId}`;
}

export function buildEvents(
  payments: LoadInvoicePaymentActivityOutput['payments'],
  refunds: readonly RefundActivityDto[],
  invoicePaidAtIso: string | null,
  invoicePaymentRecordedByUserId: string | null,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const p of payments) {
    events.push({
      id: `${p.id}-init`,
      type: 'payment_initiated',
      timestamp: p.initiatedAt,
      actorUserId: p.actorUserId,
      subjectId: p.id,
    });
    if (p.completedAt !== null) {
      let terminalType: SyntheticEventType | null = null;
      if (p.status === 'succeeded') terminalType = 'payment_succeeded';
      else if (p.status === 'failed') terminalType = 'payment_failed';
      else if (p.status === 'canceled') terminalType = 'payment_canceled';
      // 'pending' / 'processing' / 'requires_action' carry no terminal event.
      if (terminalType !== null) {
        events.push({
          id: `${p.id}-${terminalType}`,
          type: terminalType,
          timestamp: p.completedAt,
          actorUserId:
            terminalType === 'payment_canceled'
              ? p.actorUserId
              : SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
          subjectId: p.id,
        });
      }
    }
  }

  // Surface the F4 invoice_paid transition once if any payment succeeded
  // AND the F4 row has paidAt populated.
  const hasSucceeded = payments.some((p) => p.status === 'succeeded');
  if (hasSucceeded && invoicePaidAtIso !== null) {
    events.push({
      id: 'invoice-paid',
      type: 'invoice_paid',
      timestamp: new Date(invoicePaidAtIso),
      actorUserId:
        invoicePaymentRecordedByUserId ?? SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
      subjectId: 'invoice',
    });
  }

  for (const r of refunds) {
    events.push({
      id: `${r.refundId}-init`,
      type: 'refund_initiated',
      timestamp: r.initiatedAt,
      actorUserId: r.initiatorUserId,
      subjectId: r.refundId,
    });
    if (r.completedAt !== null) {
      const terminalType: SyntheticEventType =
        r.status === 'succeeded' ? 'refund_succeeded' : 'refund_failed';
      events.push({
        id: `${r.refundId}-${terminalType}`,
        type: terminalType,
        timestamp: r.completedAt,
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
        subjectId: r.refundId,
      });
    }
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return events;
}

/** Subset of the F4 `Invoice` aggregate the timeline reads. */
export interface InvoiceForTimeline {
  readonly invoiceId: string;
  readonly status: string;
  /** ISO UTC. Null when invoice has not transitioned to paid. */
  readonly paidAt: string | null;
  /**
   * Canonical actor for the `invoice_paid` event. Online payments
   * carry `SYSTEM_ACTOR_STRIPE_WEBHOOK`; manual record-payment carries
   * the admin's userId.
   */
  readonly paymentRecordedByUserId: string | null;
}

export async function PaymentTimeline({
  invoice,
  tenantId,
  isAdmin = false,
}: {
  readonly invoice: InvoiceForTimeline;
  readonly tenantId: string;
  /**
   * Drives the admin-only "Record a payment manually" CTA in the empty
   * state when invoice is `issued`. Defaults to false (manager view).
   */
  readonly isAdmin?: boolean;
}) {
  const { invoiceId, paidAt: invoicePaidAt, paymentRecordedByUserId: invoicePaymentRecordedByUserId, status: invoiceStatus } = invoice;
  const t = await getTranslations('admin.paymentReconciliation.timeline');
  const tEvents = await getTranslations(
    'admin.paymentReconciliation.timeline.events',
  );
  const tCharge = await getTranslations(
    'admin.paymentReconciliation.timeline.chargeId',
  );
  const userLocale = await getLocale();

  const result = await getInvoicePaymentActivity(tenantId, invoiceId);
  // R2-fix C1 (2026-04-26): post verify-fix C2 the use-case CAN return
  // `Result.err({kind:'repo_unavailable', cause})` when the underlying
  // F5 repo throws (DB outage, RLS misconfiguration, schema drift). The
  // previous comment claimed `error: never` which became stale after
  // C2 — and the fallback silently degraded to an empty timeline,
  // making a DB outage look identical to "no payment activity yet" to
  // the admin. Now: structured pino warn so the operator sees the
  // outage in observability, plus the empty fallback so the page
  // continues to render rather than 500-ing the whole detail view.
  let activity: LoadInvoicePaymentActivityOutput;
  if (result.ok) {
    activity = result.value;
  } else {
    logger.warn(
      {
        kind: result.error.kind,
        cause: result.error.cause,
        invoiceId,
        tenantId,
      },
      'payment-timeline: repo unavailable, rendering empty state',
    );
    activity = { payments: [], refunds: [] };
  }

  const events = buildEvents(
    activity.payments,
    activity.refunds,
    invoicePaidAt,
    invoicePaymentRecordedByUserId,
  );

  // Resolve unique non-system actor user ids → email for display.
  const userIds = Array.from(
    new Set(
      events
        .map((e) => e.actorUserId)
        .filter((id) => !isSystemActor(id) && id !== 'anonymous'),
    ),
  );
  const userEmailMap = new Map<string, string>();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const row = await userRepo.findById(asUserId(uid));
        userEmailMap.set(uid, row?.email ?? uid);
      } catch (cause) {
        // R-I1 verify-fix (2026-04-26): the previous catch silently swallowed
        // every userRepo failure, hiding DB outages from operators. Log a
        // structured warning so a flapping users-table or schema-grant break
        // surfaces in pino aggregation; the UI still degrades gracefully by
        // falling back to the raw uuid.
        logger.warn(
          { cause, userIdHash: hashId(uid) },
          'payment-timeline: user lookup failed, falling back to actor uuid',
        );
        userEmailMap.set(uid, uid);
      }
    }),
  );

  function resolveActor(actorUserId: string): string {
    if (isSystemActor(actorUserId)) return t('actorSystem');
    if (actorUserId === 'anonymous') return t('actorAnonymous');
    return userEmailMap.get(actorUserId) ?? actorUserId;
  }

  // Latest succeeded payment carries the canonical processor reference
  // for the dashboard link. Fall back to processorPaymentIntentId when
  // chargeId is null (PromptPay) — the dashboard URL accepts both.
  const succeeded = activity.payments
    .filter((p) => p.status === 'succeeded')
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    );
  const latestSucceeded = succeeded[0];
  const processorRef =
    latestSucceeded?.processorChargeId ??
    latestSucceeded?.processorPaymentIntentId ??
    null;
  const dashboardUrl =
    processorRef && latestSucceeded
      ? buildStripeDashboardUrl(latestSucceeded.processorEnvironment, processorRef)
      : null;

  return (
    // `role="region"` only — `aria-live="polite"` on a Server Component
    // re-announces the whole timeline on every soft-nav remount. Proper
    // delta-aware announcer needs a Client Component (post-MVP).
    <Card
      data-testid="payment-timeline"
      role="region"
      aria-labelledby="payment-timeline-heading"
    >
      <CardHeader>
        <CardTitle id="payment-timeline-heading" className="text-base">
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* processor charge id chip + copy + dashboard link.
            Hidden when no succeeded payment exists. */}
        {processorRef && dashboardUrl && latestSucceeded && (
          // Verify-fix S8 (2026-04-26): on narrow viewports (<sm) the chip
          // + copy + external-link wrap onto 3 lines unevenly. Stack
          // vertically below sm; revert to row at sm+. The chip itself
          // gets `select-text` (S6) so power users can triple-click the
          // charge id without hitting the copy button.
          <div className="flex flex-col items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm sm:flex-row sm:flex-wrap sm:items-center">
            <Badge
              variant="outline"
              data-testid="processor-charge-id"
              // R2-fix N4 (2026-04-26): on 320px viewports the 27-char
              // pi_/ch_ ids overflow the Badge horizontally even with
              // flex-wrap. `break-all` lets the value wrap mid-token
              // so the chip stays inside the row container.
              className="font-mono text-xs select-text break-all"
            >
              <span className="text-muted-foreground mr-1">
                {tCharge('label')}:
              </span>
              {processorRef}
            </Badge>
            {/* Verify-fix S10 (2026-04-26): test-mode chip surfaces test
                vs live unambiguously to admins reconciling on prod. */}
            {latestSucceeded.processorEnvironment === 'test' && (
              <Badge variant="secondary" className="text-[10px] uppercase">
                {t('testModeBadge')}
              </Badge>
            )}
            <CopyChargeIdButton chargeId={processorRef} />
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="view-in-stripe-link"
              // Verify-fix M-3 (2026-04-26): `outline-2 outline-ring` was
              // not valid Tailwind v4 + diverged from shadcn pattern.
              // Switched to `ring-2 ring-ring ring-offset-2` (ux-standards
              // § 7.5).
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              aria-label={t('viewInStripeAria')}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              {t('viewInStripe')}
            </a>
          </div>
        )}

        {/* empty state.
            Verify-fix S4 (2026-04-26): admin viewers get a secondary
            "Record payment manually" CTA when the invoice is still
            `issued` — it's the most likely next action when no online
            payment has settled (chamber admin reconciling a wire). */}
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <BanknoteIcon
              className="size-12 text-muted-foreground"
              aria-hidden="true"
            />
            {/* F5R1-UX4 — distinguish two empty-state semantics:
                  (a) Invoice not paid yet (issued/overdue) — current
                      copy "no online payment activity yet" + record-
                      manually CTA. Bookkeeper expects this when they
                      first issue an invoice.
                  (b) Invoice paid via manual record (cash, bank xfer,
                      cheque) — no F5 events were emitted (manual
                      record-payment bypasses the F5 webhook pipeline).
                      Previously the timeline showed the "no online
                      payment activity yet" copy here, suggesting the
                      record-payment action had silently failed. Show
                      a paid-manually copy instead so the bookkeeper
                      sees the action took effect. */}
            {invoicePaidAt !== null ? (
              <>
                <p className="text-sm font-medium">{t('emptyPaidManual.title')}</p>
                <p className="text-xs text-muted-foreground max-w-md">
                  {t('emptyPaidManual.body')}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">{t('empty.title')}</p>
                <p className="text-xs text-muted-foreground max-w-md">
                  {t('empty.body')}
                </p>
                {isAdmin && invoiceStatus === 'issued' && (
                  <a
                    href={`/admin/invoices/${invoiceId}#record-payment`}
                    data-testid="empty-state-record-payment-link"
                    className="text-sm font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                  >
                    {t('empty.recordManualLink')}
                  </a>
                )}
              </>
            )}
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {events.map((event) => {
              const Icon = eventIcon(event.type);
              return (
                <li
                  key={event.id}
                  data-testid={`timeline-event-${event.type}`}
                  className="flex items-start gap-3 rounded-md border bg-card px-3 py-2.5"
                >
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${eventIconClass(event.type)}`}
                    aria-hidden="true"
                  />
                  <div className="flex-1 text-sm">
                    <div className="font-medium">{tEvents(event.type)}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatTimestamp(event.timestamp, userLocale)} ·{' '}
                      {resolveActor(event.actorUserId)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
