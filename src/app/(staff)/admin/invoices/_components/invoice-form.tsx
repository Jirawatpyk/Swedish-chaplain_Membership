/**
 * T058 — Invoice draft form (F4, Pattern C — spec-correct).
 *
 * Spec (US1 header): "Admin staff pick a member, CONFIRM the
 * membership tier and period, and the system generates a draft
 * invoice". "Confirm" — not "pick". The tier comes from the member's
 * F3 record, not an independent form field.
 *
 * UX:
 *  - Member picker is a cmdk-backed searchable combobox (scales to
 *    hundreds of members).
 *  - Plan + Plan-year are READ-ONLY and derived from the selected
 *    member's F3 record. To invoice for a different tier, admin MUST
 *    first go to `/admin/members/[id]/edit` and run the F3
 *    `changePlan` use case (which emits `member_plan_changed` audit
 *    with an override_reason). Keeping invoice issuance and plan
 *    change as separate flows preserves audit clarity and prevents
 *    admins from silently billing for a tier that doesn't match
 *    the member's subscription state.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { InfoIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { InlineAlert, InlineAlertDescription } from '@/components/ui/inline-alert';
import { toast } from 'sonner';
import { addMonthsUtc, bangkokDateOnly } from '@/lib/dates';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';

export type MemberOption = {
  readonly memberId: string;
  readonly label: string;
  readonly currentPlanId: string;
  readonly currentPlanYear: number;
};

export type PlanOption = {
  readonly planId: string;
  readonly label: string;
  readonly annualFeeMinorUnits: number;
};

function formatSatang(satang: number): string {
  const whole = Math.floor(satang / 100);
  const rem = satang % 100;
  // N11 — explicit 'en-US' pins thousand-separator output. FR-005.
  return `${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) — wire shape
 * returned by `GET /api/invoices/member-renewal-context`. Deliberately a
 * plain client-side mirror of `MemberRenewalContext` (the server module
 * imports `runInTenant` + Drizzle-backed repos and cannot be imported into
 * this `'use client'` file) — same decoupling convention as
 * `AttendeeRow` in `event-attendee-picker.tsx`.
 */
export type RenewalContextDto = {
  readonly classification:
    | { readonly kind: 'first_payment' }
    | { readonly kind: 'renewal' }
    | { readonly kind: 'heal_no_cycle' }
    | { readonly kind: 'not_applicable'; readonly reason: 'erased' | 'terminal_only' };
  readonly periodTo: string | null;
  readonly termMonths: number | null;
  readonly hasUnpaidMembershipInvoice: boolean;
};

/** `YYYY-MM-DD` slice (dates are ISO instants or date-only strings); '—' when absent — same missing-value convention used across the admin app. */
function formatPeriodDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** Maps the classifier's 4 kinds onto the 3 i18n copy variants (spec §3b groups `first_payment` + `heal_no_cycle` under one "not started yet" message). */
function renewalContextMessageKey(
  kind: RenewalContextDto['classification']['kind'],
): 'renewal' | 'firstPayment' | 'notApplicable' {
  if (kind === 'renewal') return 'renewal';
  if (kind === 'first_payment' || kind === 'heal_no_cycle') return 'firstPayment';
  return 'notApplicable';
}

/**
 * Duplicate-billing warning condition (spec §3b): an existing unpaid
 * membership invoice, OR (for a renewal-classified member) a current period
 * end more than 6 months away — either way "another paid bill buys a
 * further year", which is legitimate, so this warns but never blocks.
 * `todayIso` is injected (not read via `new Date()` internally) so the
 * threshold is unit-testable without faking the system clock — mirrors
 * `isPastVatFilingDeadline` in `event-fee-form.tsx`.
 */
export function shouldShowRenewalDuplicateWarning(
  context: Pick<RenewalContextDto, 'classification' | 'periodTo' | 'hasUnpaidMembershipInvoice'>,
  todayIso: string,
): boolean {
  if (context.hasUnpaidMembershipInvoice) return true;
  if (context.classification.kind !== 'renewal' || context.periodTo === null) return false;
  // Lexicographic compare is chronological for YYYY-MM-DD-prefixed strings.
  return context.periodTo.slice(0, 10) > addMonthsUtc(todayIso, 6).slice(0, 10);
}

/**
 * Renewal-context informational line + duplicate-billing warning (spec
 * §3b). Presentational-only — the parent owns the fetch; this component
 * just renders a resolved `RenewalContextDto`. Exported so the component
 * test can render each classification variant directly without mocking
 * `fetch`.
 */
export function RenewalContextPanel({ context }: { readonly context: RenewalContextDto }) {
  const t = useTranslations('admin.invoices.form.renewalContext');
  const messageKey = renewalContextMessageKey(context.classification.kind);
  const toIso =
    context.periodTo !== null && context.termMonths !== null
      ? addMonthsUtc(context.periodTo, context.termMonths)
      : null;
  const contextText =
    messageKey === 'renewal'
      ? t('renewal', {
          periodTo: formatPeriodDate(context.periodTo),
          from: formatPeriodDate(context.periodTo),
          to: formatPeriodDate(toIso),
        })
      : t(messageKey);
  // Computed at render, never during SSR — this panel only mounts once the
  // client-side fetch resolves (see `CreateDraftForm`), so there is no
  // hydration-mismatch risk from reading the wall clock here.
  //
  // FIX-7 (PR #173 review, 2026-07-09) — Asia/Bangkok wall-clock "today",
  // mirroring the project-wide convention (F4 invoice dates, fiscal-year
  // boundaries) — a raw UTC ISO instant is already tomorrow in Bangkok
  // between 17:00-23:59 UTC, which would shift the 6-month duplicate-
  // billing threshold by a day during that window every render.
  //
  // R2-FIX-7 (PR #173 round-2 review, 2026-07-09) — uses the client-safe
  // `bangkokDateOnly` (plain UTC+7 arithmetic in `@/lib/dates`) instead of
  // `fiscal-year.ts`'s `bangkokLocalDate`, whose bare `import
  // '@js-joda/timezone'` dragged the ~700 KB IANA dataset into this
  // `'use client'` bundle. Bangkok has no DST, so the result is identical.
  const todayIso = `${bangkokDateOnly(new Date().toISOString())}T00:00:00.000Z`;
  const showWarning = shouldShowRenewalDuplicateWarning(context, todayIso);

  return (
    <div className="flex flex-col gap-2">
      <p
        className="flex items-start gap-2 text-xs text-muted-foreground"
        data-testid="renewal-context-line"
      >
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{contextText}</span>
      </p>
      {showWarning && (
        <InlineAlert role="status" tone="warning" data-testid="renewal-duplicate-warning">
          <TriangleAlertIcon className="size-4" aria-hidden="true" />
          <InlineAlertDescription>
            {/* FIX-7 (PR #173 review, 2026-07-09) — `periodTo` is null
                whenever the warning fires purely from `hasUnpaidMembershipInvoice`
                (non-renewal classifications never carry a periodTo). The
                original single-key copy rendered the missing-value '—'
                literally into the sentence next to its own em-dash
                separator ("...runs — — another paid bill..."). Route to
                the unpaid-only variant (no {periodTo} placeholder) instead
                of ever interpolating the missing-value sentinel. */}
            {context.periodTo !== null
              ? t('duplicateWarning', { periodTo: formatPeriodDate(context.periodTo) })
              : t('duplicateWarningUnpaidOnly')}
          </InlineAlertDescription>
        </InlineAlert>
      )}
    </div>
  );
}

/**
 * Fetches the member's renewal context and drives `RenewalContextPanel`.
 * Owns its own loading state (renders nothing until resolved — advisory
 * only, non-blocking; see `RenewalContextPanel` docstring). The parent
 * MUST key this component by `memberId` (`key={memberId}`) so a new
 * selection REMOUNTS the loader — `context` resets to `null` via the
 * initial state, avoiding a synchronous `setState` inside the effect body
 * (mirrors `EventAttendeePickerLoader`'s established convention in
 * `event-attendee-picker.tsx`).
 */
function RenewalContextLoader({ memberId }: { readonly memberId: string }) {
  const [context, setContext] = useState<RenewalContextDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invoices/member-renewal-context?memberId=${encodeURIComponent(memberId)}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          classification: RenewalContextDto['classification'];
          period_to: string | null;
          term_months: number | null;
          has_unpaid_membership_invoice: boolean;
        };
        if (!cancelled) {
          setContext({
            classification: body.classification,
            periodTo: body.period_to,
            termMonths: body.term_months,
            hasUnpaidMembershipInvoice: body.has_unpaid_membership_invoice,
          });
        }
      } catch {
        // Silent — advisory panel just stays hidden (non-blocking; the
        // server independently re-derives the SAME classification at
        // draft-create time in route.ts).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  if (context === null) return null;
  return <RenewalContextPanel context={context} />;
}

export function CreateDraftForm({
  members,
  plans,
  initialMemberId,
}: {
  readonly members: readonly MemberOption[];
  readonly plans: readonly PlanOption[];
  /**
   * Pre-fill the member picker from a `?memberId=` deep-link (e.g.
   * "New invoice" CTA on the F3 member detail page). Falls back to
   * empty when missing / not in the active-members list (archived
   * members won't appear here — FR-037 rejects issue on archived).
   */
  readonly initialMemberId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.form');
  const tPicker = useTranslations('admin.invoices.form.memberPicker');
  const tPlan = useTranslations('admin.invoices.form.planInfo');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [memberId, setMemberId] = useState(() => {
    if (!initialMemberId) return '';
    return members.some((m) => m.memberId === initialMemberId)
      ? initialMemberId
      : '';
  });
  const selectedMember = members.find((m) => m.memberId === memberId);

  const memberOptions: ComboboxOption[] = useMemo(
    () => members.map((m) => ({ value: m.memberId, label: m.label })),
    [members],
  );

  // Derived from selected member — never a form state.
  const planId = selectedMember?.currentPlanId ?? '';
  const planYear = selectedMember?.currentPlanYear ?? new Date().getFullYear();
  const selectedPlan = plans.find((p) => p.planId === planId);

  const noMembers = members.length === 0;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!memberId || !planId) {
      toast.error(t('errors.create_failed'));
      return;
    }
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          plan_id: planId,
          plan_year: planYear,
          auto_email_on_issue: null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        // Cluster 5 (Finding 3) — a freshly-imported member whose plan-year or
        // invoice settings aren't seeded yet hits `plan_not_found` /
        // `settings_missing` / `member_archived` / `member_not_found`. Look up
        // dedicated, actionable copy by code; fall back to the raw
        // "Error code: <code>" ONLY for genuinely unknown codes.
        const dedicatedKey = code ? `errors.${code}` : null;
        const description =
          dedicatedKey && t.has(dedicatedKey)
            ? t(dedicatedKey)
            : code
              ? t('errors.codeFallback', { code })
              : t('errors.unknown');
        toast.error(t('errors.create_failed'), { description });
        return;
      }
      const data = (await res.json()) as { invoice_id: string };
      toast.success(t('success.created'));
      router.push(`/admin/invoices/${data.invoice_id}`);
    });
  }

  return (
    <form
      onSubmit={submit}
      // method="post" — CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx
      method="post"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label id="memberId-label" htmlFor="memberId">
          {t('fields.memberId')}
        </Label>
        <Combobox
          id="memberId"
          options={memberOptions}
          value={memberId}
          onChange={setMemberId}
          placeholder={noMembers ? tPicker('noActiveMembers') : tPicker('placeholder')}
          searchPlaceholder={tPicker('search')}
          emptyMessage={tPicker('empty')}
          aria-labelledby="memberId-label"
          disabled={noMembers}
        />
      </div>

      {selectedMember && (
        <div className="rounded-md border bg-muted/30 p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{t('fields.planId')}</div>
              <div className="text-base font-medium">
                {selectedPlan?.label ?? planId}
                <span className="ml-2 text-sm text-muted-foreground">/ {planYear}</span>
              </div>
              {selectedPlan && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {tPlan('annualFee', {
                    amount: formatSatang(selectedPlan.annualFeeMinorUnits),
                  })}
                </div>
              )}
            </div>
            <Link
              href={`/admin/members/${memberId}/edit`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {tPlan('changePlan')}
            </Link>
          </div>
        </div>
      )}

      {selectedMember && <RenewalContextLoader key={memberId} memberId={memberId} />}

      <div className="flex justify-end gap-3">
        <Button
          type="submit"
          disabled={pending || noMembers || !memberId || !selectedPlan}
          aria-busy={pending}
        >
          {pending && (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
