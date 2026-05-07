/**
 * F8 Phase 5 Wave C · T128 + T129 — renewal confirm flow (client).
 *
 * Combines the plan-change selector (T128) with the confirm CTA (T129)
 * in a single client component so they share local React state. When
 * the member picks a different plan from the dropdown, the `newPlanId`
 * is threaded into the POST body (`/api/portal/renewal/[memberId]/confirm`,
 * T130) — the confirmRenewal use-case's plan-change branch (FR-021b)
 * atomically updates the cycle's frozen-plan fields before issuing the
 * F4 invoice.
 *
 * Why a single component (vs two siblings):
 *   - Selecting a plan in T128 is meaningless without a downstream CTA
 *     to confirm. Coupling them locally keeps the state surface small.
 *   - Server-passed `availablePlans` list is the only async dependency;
 *     the client reads/writes selection in `useState`.
 *
 * MVP scope: single-tier upgrade (current plan + 1 alternative). When
 * F2 has multiple active plans for the year, the dropdown surfaces all
 * of them; selecting "current plan" clears the change.
 */
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

/**
 * C6 review-fix (2026-05-07): map raw backend error codes to user-
 * friendly i18n keys so the UI never shows "server_error" /
 * "invoice_creation_failed" verbatim to the member. Unknown codes
 * fall through to the generic message; the raw code is logged via
 * console.warn so support can correlate.
 *
 * Codes match the route handler (`confirm/route.ts`) error envelope:
 *   feature_disabled, invalid_body, invalid_input, cycle_not_found,
 *   cycle_not_payable, plan_not_found, plan_inactive,
 *   invoice_creation_failed, server_error
 *   (+ client-side: network_error, missing_pay_url, http_<status>)
 */
const ERROR_CODE_TO_I18N_KEY: Readonly<Record<string, string>> = {
  cycle_not_found: 'errorCycleNotFound',
  cycle_not_payable: 'errorCycleNotPayable',
  plan_not_found: 'errorPlanUnavailable',
  plan_inactive: 'errorPlanUnavailable',
  invoice_creation_failed: 'errorInvoiceFailed',
  network_error: 'errorNetwork',
};

export interface RenewalPlanOption {
  readonly planId: string;
  readonly label: string;
  readonly annualFeeMinorUnits: number;
}

interface RenewalConfirmFlowProps {
  readonly memberId: string;
  readonly cycleId: string;
  readonly planYear: number;
  readonly currentPlanId: string;
  readonly currentPlanLabel: string;
  readonly availablePlans: ReadonlyArray<RenewalPlanOption>;
}

export function RenewalConfirmFlow({
  memberId,
  cycleId,
  planYear,
  currentPlanId,
  currentPlanLabel,
  availablePlans,
}: RenewalConfirmFlowProps) {
  const t = useTranslations('portal.renewal.confirm');
  const tSelector = useTranslations('portal.renewal.planChange');
  // Default selection = current plan (no plan-change). The selector
  // lists current + alternatives; selecting current is a no-op
  // matching `newPlanId === cycle.planIdAtCycleStart` in T122.
  const [selectedPlanId, setSelectedPlanId] = useState(currentPlanId);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const body: {
          cycleId: string;
          planYear: number;
          newPlanId?: string;
        } = { cycleId, planYear };
        if (selectedPlanId !== currentPlanId) {
          body.newPlanId = selectedPlanId;
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
          const code = payload.error?.code ?? `http_${r.status}`;
          // C6 review-fix: log raw code for support correlation; user
          // sees mapped i18n message (see ERROR_CODE_TO_I18N_KEY).
          console.warn('[renewal-confirm] error', { code, status: r.status });
          setError(code);
          return;
        }
        const payload = (await r.json()) as { pay_url?: string };
        if (payload.pay_url) {
          window.location.assign(payload.pay_url);
        } else {
          setError('missing_pay_url');
        }
      } catch {
        setError('network_error');
      }
    });
  };

  // Plans dropdown only renders when there is more than one option
  // (otherwise there's nothing to "change" to).
  const hasAlternatives = availablePlans.length > 1;

  return (
    <div className="flex flex-col gap-4">
      {hasAlternatives && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="renewal-plan-select" className="font-medium">
            {tSelector('label')}
          </Label>
          <Select
            value={selectedPlanId}
            onValueChange={(value: string | null) => {
              if (value) setSelectedPlanId(value);
            }}
            disabled={isPending}
          >
            <SelectTrigger id="renewal-plan-select" className="w-full">
              <SelectValue
                placeholder={tSelector('placeholder', {
                  defaultLabel: currentPlanLabel,
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {availablePlans.map((p) => (
                <SelectItem key={p.planId} value={p.planId}>
                  {p.label}
                  {p.planId === currentPlanId
                    ? ` · ${tSelector('currentSuffix')}`
                    : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedPlanId !== currentPlanId && (
            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
            >
              {tSelector('changeNotice')}
            </p>
          )}
        </div>
      )}
      <Button
        onClick={onConfirm}
        disabled={isPending}
        // S-6 polish: announce the loading state to assistive tech so a
        // screen reader user hears "busy" while the F4 invoice is being
        // issued (the network round-trip is typically 200-800ms — long
        // enough that silence is jarring).
        aria-busy={isPending}
      >
        {isPending ? t('busy') : t('cta')}
      </Button>
      {/*
        S-7 polish: when `selectedPlanId !== currentPlanId` the change
        notice already lives above the CTA. The plan-change-notice
        paragraph below the Select gets `aria-live='polite'` so a
        screen reader hears the price-lock warning the moment the user
        switches plans, instead of having to navigate back up.
      */}
      {error && (
        <p
          role="alert"
          aria-live="assertive"
          className="text-sm text-destructive"
          data-testid="confirm-error"
        >
          {t(ERROR_CODE_TO_I18N_KEY[error] ?? 'errorGeneric')}
        </p>
      )}
    </div>
  );
}
