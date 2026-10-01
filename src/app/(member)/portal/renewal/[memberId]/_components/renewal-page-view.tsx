/**
 * Spec 122 US7c (T741) — the renewal page's presentation (board `Portal-renewal`).
 *
 * Split from `page.tsx`, which keeps the session guard, the data loading and
 * the payability decision, so the same layout renders in the preview harness
 * and in unit tests (the page wraps it in its `DetailContainer`, which
 * `check:layout` reads there). Top to bottom: the page header, the first-renewal
 * welcome, then the board's grid — "Membership plan" and "Benefit summary"
 * on the left and the Confirm card (or the gate notice that replaces it) in a
 * 420px column on the right from `lg`; one column below.
 */
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { formatDatePreset } from '@/lib/format-date-localised';
import type { BenefitConsumptionEntry } from '@/modules/renewals';
import { BenefitSummary } from './benefit-summary';
import { OnboardingBanner } from './onboarding-banner';
import { RenewalConfirmFlow, type RenewalConfirmFlowProps } from './renewal-confirm-flow';

/** What the right-hand column shows: the confirm card, or the notice that replaces it. */
export type RenewalGate =
  | { readonly kind: 'payable'; readonly flow: RenewalConfirmFlowProps }
  | { readonly kind: 'pending_review' }
  | { readonly kind: 'rejected_refund' }
  | { readonly kind: 'not_yet_open' };

export interface RenewalPageViewProps {
  readonly locale: string;
  readonly isFirstTimeRenewer: boolean;
  readonly plan: {
    readonly label: string;
    readonly tierLabel: string;
    readonly termMonths: number;
    readonly expiresAt: string;
  };
  readonly benefits: ReadonlyArray<BenefitConsumptionEntry>;
  readonly benefitsAvailable: boolean;
  readonly gate: RenewalGate;
}

export function RenewalPageView({
  locale,
  isFirstTimeRenewer,
  plan,
  benefits,
  benefitsAvailable,
  gate,
}: RenewalPageViewProps) {
  const t = useTranslations('portal.renewal.page');
  const tField = useTranslations('portal.renewal.fields');
  const tConfirm = useTranslations('portal.renewal.confirm');

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} size="hero" />

      {/* After the h1, so the heading order stays h1 → h2 (I18). */}
      {isFirstTimeRenewer && <OnboardingBanner />}

      <div className="grid grid-cols-1 gap-[var(--aura-space-6)] lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-[var(--aura-space-6)]">
          <Card
            as="section"
            title={t('membershipPlanHeading')}
            titleId="plan-summary-heading"
            headingLevel={2}
          >
            {/* Board: two columns, each label stacked over its value. */}
            <dl className="grid grid-cols-2 gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-4)] text-sm">
              <div className="flex min-w-0 flex-col gap-[var(--aura-space-1)]">
                <dt className="text-[var(--aura-fg-secondary)]">{tField('plan')}</dt>
                <dd className="font-medium">{plan.label}</dd>
              </div>
              <div className="flex min-w-0 flex-col items-start gap-[var(--aura-space-1)]">
                <dt className="text-[var(--aura-fg-secondary)]">{tField('tier')}</dt>
                <dd>
                  {/* A tier is a category, never a status tone (US7a decision). */}
                  <Badge tone="accent" variant="soft">
                    {plan.tierLabel}
                  </Badge>
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-[var(--aura-space-1)]">
                <dt className="text-[var(--aura-fg-secondary)]">{tField('term')}</dt>
                <dd>{tField('termMonths', { count: plan.termMonths })}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-[var(--aura-space-1)]">
                <dt className="text-[var(--aura-fg-secondary)]">{tField('expiry')}</dt>
                <dd>
                  <time dateTime={plan.expiresAt}>
                    {formatDatePreset(plan.expiresAt, locale, 'dateLong')}
                  </time>
                </dd>
              </div>
            </dl>
          </Card>

          <BenefitSummary benefits={benefits} benefitsAvailable={benefitsAvailable} />
        </div>

        {gate.kind === 'payable' ? (
          <Card
            as="section"
            title={tConfirm('cardTitle')}
            titleId="renewal-confirm-heading"
            headingLevel={2}
          >
            <RenewalConfirmFlow {...gate.flow} />
          </Card>
        ) : (
          <GateNotice gate={gate} />
        )}
      </div>
    </>
  );
}

/**
 * A gate notice in place of the confirm card: an h2 card (so the right
 * column keeps its heading — UX review) holding the notice as an AURA alert.
 */
function GateNotice({ gate }: { gate: Exclude<RenewalGate, { kind: 'payable' }> }) {
  const t = useTranslations('portal.renewal');
  // UX-A Bug 2: while the reject-with-refund marker is set the reactivation
  // was NOT approved and a refund is under way, so "being verified" would be false.
  const copy =
    gate.kind === 'pending_review'
      ? { title: t('pendingReviewTitle'), body: t('pendingReviewBody'), tone: 'info' as const }
      : gate.kind === 'rejected_refund'
        ? { title: t('rejectedRefundTitle'), body: t('rejectedRefundBody'), tone: 'warning' as const }
        : { title: t('notYetOpenTitle'), body: t('notYetOpenBody'), tone: 'info' as const };
  return (
    <Card as="section" title={copy.title} titleId="renewal-gate-heading" headingLevel={2}>
      <Alert tone={copy.tone} role="none">
        {copy.body}
      </Alert>
    </Card>
  );
}
