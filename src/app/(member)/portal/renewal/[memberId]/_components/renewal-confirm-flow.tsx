/**
 * F8 Phase 5 Wave C · T128 + T129 — renewal confirm flow (client).
 *
 * Combines the plan-change selector (T128) with the confirm CTA (T129) in a
 * single client component so they share local React state.
 *
 * WP5 (plan-change UX):
 *   - The price panel (`<PriceDiffPanel>`) renders ALWAYS, outside the
 *     `hasAlternatives` gate (C-6), so the current locked-in price never
 *     vanishes for a single-plan tenant or a `listPlans` failure.
 *   - The plan options are grouped into higher-priced / current / lower-priced
 *     blocks and each shows its price.
 *   - Choosing a LOWER-priced plan and pressing Confirm opens a
 *     downgrade-acknowledgement dialog instead of submitting; only after the
 *     member confirms does the POST carry `acknowledgeDowngrade: true`. This
 *     mirrors the server gate (`confirmRenewal` → 409), classified by the
 *     SAME `classifyPlanPriceChange` predicate so the two cannot diverge.
 *
 * Spec 122 US7c (board `Portal-renewal`, Confirm card): the two-step stepper,
 * the AURA select (option groups kept, the board's option text), the change
 * warning, the price panel, the full-width primary CTA and the next-step line.
 * The request, its body and every error mapping are unchanged.
 */
'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  classifyPlanPriceChange,
  requiresDowngradeAck,
} from '@/modules/renewals/client';
import { Alert, Button, Select } from '@jirawatpyk/aura-react';
import { groupPlanOptions } from '../_lib/group-plan-options';
import { formatThbMinorUnits } from '../_lib/format-thb';
import { PriceDiffPanel } from './price-diff-panel';
import { DowngradeConfirmDialog } from './downgrade-confirm-dialog';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';

/**
 * Map raw backend error codes to user-friendly i18n keys so the UI never
 * shows a raw code to the member. Unknown codes fall through to the generic
 * message; the raw code is logged for support correlation.
 *
 * Codes match the route handler (`confirm/route.ts`) error envelope:
 *   feature_disabled, invalid_body, invalid_input, cycle_not_found,
 *   cycle_not_payable, plan_not_found, plan_inactive, invoice_creation_failed,
 *   downgrade_not_acknowledged, rate_limited, server_error
 *   (+ client-side: network_error, missing_pay_url, http_<status>)
 */
const ERROR_CODE_TO_I18N_KEY: Readonly<Record<string, string>> = {
  cycle_not_found: 'errorCycleNotFound',
  cycle_not_payable: 'errorCycleNotPayable',
  plan_not_found: 'errorPlanUnavailable',
  plan_inactive: 'errorPlanUnavailable',
  invoice_creation_failed: 'errorInvoiceFailed',
  // WP4/WP5 — a 409 when the member reached the server with a lower-priced
  // plan but no ack (e.g. a stale client, or the ack lost in flight).
  downgrade_not_acknowledged: 'errorDowngradeNotAcknowledged',
  rate_limited: 'errorRateLimited',
  network_error: 'errorNetwork',
  // The write freeze, either envelope — normalised in `submitConfirm`.
  read_only_mode: 'errorReadOnly',
};

export interface RenewalPlanOption {
  readonly planId: string;
  readonly label: string;
  readonly annualFeeMinorUnits: number;
  // WP5 — per-plan yearly benefit quotas for the downgrade dialog's "what
  // changes" deltas. OPTIONAL: `listPlans` (the page's source) does not
  // project `benefit_matrix`, so alternatives currently carry no quotas and
  // the dialog shows only the price change (the concrete fact). Populated the
  // moment the page has a benefit_matrix source. `null` = unlimited.
  readonly quotas?: {
    readonly eblast: number | null;
    readonly culturalTickets: number | null;
  };
}

export interface RenewalConfirmFlowProps {
  readonly memberId: string;
  readonly cycleId: string;
  readonly currentPlanId: string;
  readonly currentPlanLabel: string;
  readonly availablePlans: ReadonlyArray<RenewalPlanOption>;
  // WP5 — the cycle's current frozen price (THB minor units). The price panel
  // + the downgrade classification compare against this, NOT a live catalogue
  // price, so what the member sees matches what the server bills.
  readonly frozenPriceMinorUnits: number;
  // WP5 — the member's current-cycle benefit consumption + current-plan quota,
  // for the downgrade dialog's over-quota warning.
  readonly benefitUsage: {
    readonly eblast: { readonly used: number; readonly quota: number | null };
    readonly culturalTickets: { readonly used: number; readonly quota: number | null };
  };
}

/**
 * Fire-and-forget beacon to `/api/internal/client-error` for SRE + support
 * correlation. All failures are swallowed — the console.warn/error at the
 * callsite + the `setError` UI update are the user-visible handles.
 */
function reportClientError(payload: {
  tag: string;
  code: string;
  status: number;
  path: string;
}): void {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      '/api/internal/client-error',
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    );
  } catch {
    /* best-effort; see callsite for user-visible handle */
  }
}

export function RenewalConfirmFlow({
  memberId,
  cycleId,
  currentPlanId,
  currentPlanLabel,
  availablePlans,
  frozenPriceMinorUnits,
  benefitUsage,
}: RenewalConfirmFlowProps) {
  const t = useTranslations('portal.renewal.confirm');
  const tSelector = useTranslations('portal.renewal.planChange');
  const format = useFormatter();
  // Default selection = current plan (no plan-change).
  const [selectedPlanId, setSelectedPlanId] = useState(currentPlanId);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [downgradeDialogOpen, setDowngradeDialogOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  // Move focus to the error alert when it appears so a keyboard/SR user is
  // taken straight to the failure (the alert is not an aria-live region — it
  // is `role="alert"` + programmatically focused, C-7-adjacent).
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const selectedPlan = availablePlans.find((p) => p.planId === selectedPlanId);
  const newPriceMinorUnits = selectedPlan?.annualFeeMinorUnits ?? frozenPriceMinorUnits;
  const isChange = selectedPlanId !== currentPlanId;
  const isDowngrade =
    isChange &&
    requiresDowngradeAck(
      classifyPlanPriceChange({
        currentMinorUnits: frozenPriceMinorUnits,
        targetMinorUnits: newPriceMinorUnits,
      }),
    );

  const submitConfirm = (acknowledge: boolean) => {
    setDowngradeDialogOpen(false);
    setError(null);
    startTransition(async () => {
      try {
        const body: {
          cycleId: string;
          newPlanId?: string;
          acknowledgeDowngrade?: true;
        } = { cycleId };
        if (selectedPlanId !== currentPlanId) {
          body.newPlanId = selectedPlanId;
        }
        if (acknowledge) {
          body.acknowledgeDowngrade = true;
        }
        const r = await fetch(
          `/api/portal/renewal/${encodeURIComponent(memberId)}/confirm`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!r.ok) {
          const payload = (await r.json().catch(() => ({}))) as {
            error?: { code?: string };
          };
          const code = isReadOnlyRefusal(r.status, payload)
            ? 'read_only_mode'
            : (payload.error?.code ?? `http_${r.status}`);
          console.warn('[renewal-confirm] error', { code, status: r.status });
          reportClientError({
            tag: 'renewal-confirm',
            code,
            status: r.status,
            path: window.location.pathname,
          });
          setError(code);
          return;
        }
        let payload: { pay_url?: string };
        try {
          payload = (await r.json()) as { pay_url?: string };
        } catch (parseErr) {
          console.error('[renewal-confirm] malformed response body', parseErr);
          reportClientError({
            tag: 'renewal-confirm',
            code: 'malformed_response',
            status: r.status,
            path: window.location.pathname,
          });
          setError('malformed_response');
          return;
        }
        if (payload.pay_url) {
          window.location.assign(payload.pay_url);
        } else {
          setError('missing_pay_url');
        }
      } catch (e) {
        console.error('[renewal-confirm] network error', e);
        setError('network_error');
      }
    });
  };

  const onConfirm = () => {
    // A lower-priced switch requires the explicit two-step acknowledgement:
    // open the dialog instead of posting. Every other case (upgrade, sidegrade,
    // no change) submits immediately with no ack.
    if (isDowngrade) {
      setDowngradeDialogOpen(true);
      return;
    }
    submitConfirm(false);
  };

  const hasAlternatives = availablePlans.length > 1;
  const grouped = groupPlanOptions({
    plans: availablePlans,
    currentPlanId,
    currentPriceMinorUnits: frozenPriceMinorUnits,
  });

  const renderOption = (p: RenewalPlanOption) => {
    const price = formatThbMinorUnits(format, p.annualFeeMinorUnits);
    return (
      <option key={p.planId} value={p.planId}>
        {p.planId === currentPlanId
          ? tSelector('optionWithPriceCurrent', {
              label: p.label,
              price,
              current: tSelector('currentSuffix'),
            })
          : tSelector('optionWithPrice', { label: p.label, price })}
      </option>
    );
  };

  // Downgrade dialog quota deltas — only when the (target) plan carries quotas.
  const bodyQuotaProps = selectedPlan?.quotas
    ? {
        eblast: {
          from: benefitUsage.eblast.quota,
          to: selectedPlan.quotas.eblast,
          used: benefitUsage.eblast.used,
        },
        culturalTickets: {
          from: benefitUsage.culturalTickets.quota,
          to: selectedPlan.quotas.culturalTickets,
          used: benefitUsage.culturalTickets.used,
        },
      }
    : {};

  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]">
      {/* Board stepper: this page is step 1; paying the invoice is step 2. */}
      <ol aria-label={t('stepsLabel')} className="flex items-center gap-[var(--aura-space-2)] text-sm">
        <li aria-current="step" className="flex items-center gap-[var(--aura-space-2)] font-semibold">
          <span
            aria-hidden
            className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--aura-button-primary-bg)] text-xs text-[var(--aura-button-primary-fg)]"
          >
            1
          </span>
          {t('stepConfirm')}
        </li>
        <li className="flex flex-1 items-center gap-[var(--aura-space-2)] text-[var(--aura-fg-secondary)]">
          <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--aura-border-control)]" />
          <span
            aria-hidden
            className="grid size-6 shrink-0 place-items-center rounded-full border border-[var(--aura-border-control)] text-xs"
          >
            2
          </span>
          {t('stepPay')}
        </li>
      </ol>

      {hasAlternatives && (
        <Select
          label={tSelector('label')}
          value={selectedPlanId}
          onChange={(e) => setSelectedPlanId(e.target.value)}
          disabled={isPending}
        >
          {/* The current plan may be missing from this year's list (made
              inactive, or not carried into the catalogue). A controlled
              <select> whose value has no option shows the FIRST option, so
              the field would name another plan and price while the panel and
              the request keep the current one (financial review, US7c). */}
          {!availablePlans.some((p) => p.planId === currentPlanId) && (
            <option value={currentPlanId} disabled hidden>
              {currentPlanLabel}
            </option>
          )}
          {grouped.upgrade.length > 0 && (
            <optgroup label={tSelector('groupUpgrade')}>{grouped.upgrade.map(renderOption)}</optgroup>
          )}
          {grouped.current.length > 0 && (
            <optgroup label={tSelector('groupCurrent')}>{grouped.current.map(renderOption)}</optgroup>
          )}
          {grouped.downgrade.length > 0 && (
            <optgroup label={tSelector('groupDowngrade')}>{grouped.downgrade.map(renderOption)}</optgroup>
          )}
        </Select>
      )}

      {isChange && (
        <Alert tone="warning" role="status">
          {tSelector('changeNotice')}
        </Alert>
      )}

      {/* C-6 — mounted ALWAYS (outside `hasAlternatives`) so the price never
          disappears for a single-plan tenant or a listPlans failure. */}
      <PriceDiffPanel
        currentPriceMinorUnits={frozenPriceMinorUnits}
        newPriceMinorUnits={newPriceMinorUnits}
      />

      <div className="flex flex-col gap-[var(--aura-space-2)]">
        <Button
          icon="arrow-right"
          fullWidth
          onClick={onConfirm}
          loading={isPending}
        >
          {isPending ? t('busy') : t('cta')}
        </Button>
        <p className="text-xs text-[var(--aura-fg-secondary)]">{t('nextStep')}</p>
      </div>

      {error && (
        <Alert ref={errorRef} tone="danger" role="alert" tabIndex={-1} data-testid="confirm-error">
          {t(ERROR_CODE_TO_I18N_KEY[error] ?? 'errorGeneric')}
        </Alert>
      )}

      <DowngradeConfirmDialog
        open={downgradeDialogOpen}
        currentLabel={currentPlanLabel}
        newLabel={selectedPlan?.label ?? selectedPlanId}
        currentPriceMinorUnits={frozenPriceMinorUnits}
        newPriceMinorUnits={newPriceMinorUnits}
        submitting={isPending}
        onConfirm={() => submitConfirm(true)}
        onCancel={() => setDowngradeDialogOpen(false)}
        {...bodyQuotaProps}
      />
    </div>
  );
}
