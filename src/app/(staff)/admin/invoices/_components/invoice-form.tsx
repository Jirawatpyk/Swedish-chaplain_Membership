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
import { InfoIcon, Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { addMonthsUtc } from '@/lib/dates';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

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

/**
 * The already-existing live membership invoice the server refused against
 * (409 `duplicate_membership_invoice`). Mirrors the route's `error.existing`
 * body. `documentNumber` / `totalSatang` are null when the existing invoice
 * is itself still a draft — F4 allocates the §87 number and freezes totals at
 * issue, so an unnumbered duplicate is normal, not missing data.
 */
export type ExistingDuplicate = {
  readonly invoiceId: string;
  readonly status: string;
  readonly documentNumber: string | null;
  readonly totalSatang: string | null;
};

/**
 * Decide whether a failed POST /api/invoices response is the recoverable
 * duplicate refusal, and if so extract the existing document to show.
 *
 * Extracted as a pure function because it carries the only real branching in
 * the duplicate flow, and the AlertDialog around it cannot be exercised in
 * jsdom (Base UI dialog portals do not mount there — this repo covers dialog
 * mechanics in Playwright, see tests/e2e/destructive-confirm.spec.ts).
 *
 * Returns null for every other error code AND for a duplicate response whose
 * `existing` block is incomplete: a confirmation dialog rendered with blanks
 * where the document number and amount should be is worse than the ordinary
 * error toast, because it asks the admin to make an informed decision while
 * withholding the information.
 */
export function parseDuplicateRefusal(body: unknown): ExistingDuplicate | null {
  const error = (body as { error?: { code?: unknown; existing?: unknown } } | null)?.error;
  if (!error || error.code !== 'duplicate_membership_invoice') return null;
  const existing = error.existing as Partial<Record<string, unknown>> | undefined;
  const invoiceId = existing?.invoice_id;
  const status = existing?.status;
  if (typeof invoiceId !== 'string' || invoiceId === '') return null;
  if (typeof status !== 'string' || status === '') return null;
  const documentNumber = existing?.document_number;
  const totalSatang = existing?.total_satang;
  return {
    invoiceId,
    status,
    // Null is MEANINGFUL here (the existing invoice is a draft, so it has no
    // §87 number and no frozen total yet) — not missing data to paper over.
    documentNumber: typeof documentNumber === 'string' ? documentNumber : null,
    totalSatang: typeof totalSatang === 'string' ? totalSatang : null,
  };
}

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
  // Duplicate-billing detection lives on the SERVER now (createInvoiceDraft's
  // `duplicate_membership_invoice` guard, #243) which shows the real existing
  // document + a deep link + a typed acknowledgement. The old client-side
  // "another paid bill buys a further year" soft-warning was removed: it was
  // wrong under the fixed-anchor model (a second same-year bill is a duplicate,
  // not "a further year") and contradicted the #243 hard guard.
  return (
    <p
      className="flex items-start gap-2 text-xs text-muted-foreground"
      data-testid="renewal-context-line"
    >
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{contextText}</span>
    </p>
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
        };
        if (!cancelled) {
          setContext({
            classification: body.classification,
            periodTo: body.period_to,
            termMonths: body.term_months,
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
  const tDup = useTranslations('admin.invoices.form.duplicateConfirm');
  // Reuse the existing invoice-status labels rather than minting a second set
  // that could drift out of step with the list/detail pages. `t.has` guards a
  // status the label map hasn't caught up with (e.g. a new enum value) and
  // falls back to the raw value instead of throwing MISSING_MESSAGE.
  const tStatus = useTranslations('admin.invoices.list.statuses');
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

  /**
   * The existing invoice the server refused against, or null. Non-null =
   * the confirmation dialog is open. Cleared on cancel and on success so a
   * second submit starts from a clean refuse-by-default state.
   */
  const [duplicate, setDuplicate] = useState<ExistingDuplicate | null>(null);

  /**
   * POST the draft. `acknowledgeDuplicate` is sent ONLY as the literal `true`
   * and ONLY from the confirmation dialog's "create anyway" action — i.e.
   * after the admin has been shown the existing document's number, amount and
   * status and has had the chance to open it. It is never a form field and
   * has no default-on path, so an ordinary submit can never carry it.
   */
  function create(acknowledgeDuplicate: boolean) {
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          plan_id: planId,
          plan_year: planYear,
          auto_email_on_issue: null,
          ...(acknowledgeDuplicate ? { acknowledge_duplicate: true } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        // Recoverable refusal: the member already holds a live membership
        // invoice for this plan year. Surface WHAT exists and let the admin
        // decide — a second bill in one plan year is legitimate but must be
        // deliberate. Anything the server didn't fully describe falls through
        // to the ordinary toast below rather than opening a dialog with
        // blanks in it.
        const existing = parseDuplicateRefusal(body);
        if (existing) {
          setDuplicate(existing);
          return;
        }
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
      setDuplicate(null);
      toast.success(t('success.created'));
      router.push(`/admin/invoices/${data.invoice_id}`);
    });
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!memberId || !planId) {
      toast.error(t('errors.create_failed'));
      return;
    }
    // Refuse-by-default: an ordinary submit never acknowledges a duplicate.
    create(false);
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

      {/*
        Deliberate-duplicate confirmation. Opened only by a 409 from the
        server — never speculatively from client-side state — so the details
        shown are the server's authoritative answer, not a guess.

        This is a money action: it mints a second §86/4 tax document for one
        membership year. Per docs/ux-standards.md the confirm is an
        AlertDialog (not a toast-with-undo), the destructive-intent action is
        NOT the default focus, and the existing document is presented as
        inspectable facts + a link rather than a bare "are you sure?". The
        link opens in a new tab so the admin can read the existing invoice
        WITHOUT losing the form they are mid-way through.
      */}
      <AlertDialog
        open={duplicate !== null}
        onOpenChange={(next) => {
          if (!next) setDuplicate(null);
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            {/*
              `year` is passed as a STRING on purpose: ICU formats a numeric
              argument with the locale's number rules, which would print the
              plan year as "2,026". A year is an identifier, not a quantity.
              Caught by the real-en.json render convention, not by typecheck.
            */}
            <AlertDialogTitle>
              {tDup('title', { year: String(planYear) })}
            </AlertDialogTitle>
            <AlertDialogDescription>{tDup('description')}</AlertDialogDescription>
          </AlertDialogHeader>

          {duplicate && (
            <dl className="rounded-md border bg-muted/30 p-4 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{tDup('fields.documentNumber')}</dt>
                <dd className="font-medium">
                  {duplicate.documentNumber ?? tDup('notYetNumbered')}
                </dd>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{tDup('fields.status')}</dt>
                <dd className="font-medium">
                  {tStatus.has(duplicate.status)
                    ? tStatus(duplicate.status)
                    : duplicate.status}
                </dd>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{tDup('fields.amount')}</dt>
                <dd className="font-medium">
                  {duplicate.totalSatang === null
                    ? tDup('notYetTotalled')
                    : `${formatSatang(Number(duplicate.totalSatang))} THB`}
                </dd>
              </div>
              <div className="mt-3">
                <Link
                  href={`/admin/invoices/${duplicate.invoiceId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline underline-offset-2"
                >
                  {tDup('viewExisting')}
                </Link>
              </div>
            </dl>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{tDup('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                create(true);
              }}
              disabled={pending}
              aria-busy={pending}
              className={buttonVariants({ variant: 'destructive' })}
            >
              {pending && (
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              )}
              {pending ? t('submitting') : tDup('createAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
