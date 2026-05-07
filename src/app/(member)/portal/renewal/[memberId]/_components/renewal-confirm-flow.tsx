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
          setError(payload.error?.code ?? `http_${r.status}`);
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
            <p className="text-xs text-muted-foreground">
              {tSelector('changeNotice')}
            </p>
          )}
        </div>
      )}
      <Button onClick={onConfirm} disabled={isPending}>
        {isPending ? t('busy') : t('cta')}
      </Button>
      {error && (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="confirm-error"
        >
          {t('errorPrefix')} {error}
        </p>
      )}
    </div>
  );
}
