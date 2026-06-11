/**
 * Task 11 (054-event-fee-invoices) — event-fee invoice creation form.
 *
 * Rendered by `/admin/invoices/new` when the invoice-type selector is set
 * to "Event fee". Flow:
 *
 *   1. Event picker (searchable combobox over server-loaded events).
 *   2. Attendee picker (fetches the event's registrations on select).
 *   3. Buyer section:
 *        - matched member → read-only "Billed to <name>" (the server pins
 *          the F3 buyer snapshot, incl. tax_id, at issue — we do NOT fetch
 *          the member identity client-side).
 *        - non-member       → manual buyer sub-form with inline validation.
 *   4. Amount (VAT-inclusive, pre-filled from ticket price, editable, bounded).
 *   5. Live VAT-inclusive preview (display-only; the server is authoritative).
 *   6. Doc-type badge (Tax Invoice when a TIN is known, Receipt when not,
 *      "set at issue" for a matched member whose TIN we can't see client-side).
 *   7. Submit → POST /api/invoices/event-draft.
 *
 * Task 13 (064-event-invoice-paid-flow) adds the issuance-mode selector:
 *
 *   - `defaultModeFor` (pure, exported) maps the F6 registration
 *     `payment_status` (paid | pending | refunded | free | waitlisted |
 *     no_show — there is NO 'unpaid' value) + buyer-TIN presence to a
 *     default mode per design §2.3. `refunded` is a hard block.
 *   - `already_paid` shows a payment-date (max = today Bangkok; F6 carries
 *     no payment date to prefill from, so it defaults to today; 064
 *     remediation W0 — the date + reference/notes RESET to defaults on any
 *     event/attendee change so a backdate never leaks across attendees) +
 *     a payment-method select + optional reference/notes (W2, mirrored from
 *     the record-payment dialog), and submits in two steps: the existing
 *     event-draft POST, then POST /api/invoices/{id}/issue-as-paid. If the
 *     SECOND call fails the draft remains — the error toast says so and
 *     offers an inline Retry action (S6; suppressed for
 *     invoice_already_issued) — and we still navigate to the (actionable)
 *     draft detail. The whole two-step submit is try/catch-guarded (S4).
 *   - `bill_first` keeps the existing create-draft flow unchanged and is
 *     NEVER selectable for a no-TIN buyer (server guard
 *     `event_no_tin_requires_paid_issue`; the option is disabled with a
 *     visible reason — no hover-only tooltip, same philosophy as the
 *     attendee picker's erased rows).
 *
 * NOTE (plan adaptation): the plan's Task-13 step text assumed an RHF+zod
 * form schema; this form is plain useState + manual on-submit validation
 * (054 convention), so mode/paymentDate/paymentMethod follow the existing
 * manual pattern instead of a zod schema.
 *
 * Mirrors `CreateDraftForm` (membership) for toasts / redirect / disabled
 * states (ux-standards). The amount is entered in THB and converted to
 * satang for the API; `amountOverride` is sent ONLY when the admin edited
 * the pre-filled ticket price (otherwise omitted so the server uses the
 * registration's `ticketPriceThb`).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  SearchableCombobox,
  type ComboboxOption,
} from '../../_components/searchable-combobox';
import {
  EventAttendeePickerLoader,
  isMatchedMember,
  type AttendeeRow,
} from './event-attendee-picker';
import {
  NonMemberBuyerFields,
  EMPTY_NON_MEMBER_BUYER,
  validateNonMemberBuyer,
  isNonMemberBuyerValid,
  type NonMemberBuyer,
  type NonMemberBuyerErrors,
} from './non-member-buyer-fields';

export type EventOption = {
  readonly eventId: string;
  /** Display label — event name + CE start date (YYYY-MM-DD). */
  readonly label: string;
};

const VAT_RATE_BPS = 700; // 7% — tenant standard rate (v1: standard only).
const MAX_THB = 1_000_000;
const MIN_THB = 1;

/**
 * Display-only VAT-inclusive split. Mirrors the Domain
 * `splitVatInclusive` (half-away-from-zero) using integer satang so the
 * preview reconciles byte-for-byte with the server's issue-time math. NOT
 * authoritative — the server recomputes at issue.
 *
 * total × 10000 ≤ 1,000,000,00 × 10000 = 1e12 < Number.MAX_SAFE_INTEGER —
 * safe in JS `number`.
 */
export function previewVatInclusive(totalSatang: number): {
  subtotal: number;
  vat: number;
} {
  if (totalSatang <= 0) return { subtotal: 0, vat: 0 };
  const denom = 10_000 + VAT_RATE_BPS;
  const scaled = totalSatang * 10_000;
  const subtotal = Math.floor((scaled + denom / 2) / denom); // half-away (positive)
  return { subtotal, vat: totalSatang - subtotal };
}

function formatSatang(satang: number): string {
  const whole = Math.floor(satang / 100);
  const rem = satang % 100;
  return `${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

type DocTypeKind = 'taxInvoice' | 'taxInvoiceReceipt' | 'receipt' | 'pending';

/**
 * Derives the document type for the preview badge.
 *
 * Rules:
 * - No attendee selected OR the attendee is a matched member → 'pending'
 *   (matched member's TIN is resolved server-side at issue; we can't see it
 *   client-side).
 * - Non-member with a non-empty TIN → 'taxInvoice'.
 * - Non-member without a TIN → 'receipt'.
 */
export function resolveDocType(
  attendee: AttendeeRow | null,
  matched: boolean,
  taxId: string,
): DocTypeKind {
  if (attendee === null || matched) return 'pending';
  return taxId.trim().length > 0 ? 'taxInvoice' : 'receipt';
}

export type IssuanceMode = 'already_paid' | 'bill_first';

/**
 * Maps the F6 registration `payment_status` + buyer-TIN presence to the
 * default issuance mode (design 064 §2.3). The REAL F6 enum is
 * `paid | pending | refunded | free | waitlisted | no_show` — there is NO
 * 'unpaid' value; an unrecognised status defensively gets no default.
 *
 * - `paid`               → default already_paid (switch to bill_first only with TIN).
 * - `pending`/`waitlisted` → default bill_first when TIN; with NO TIN there is
 *   no default ("wait for the money, then record as paid" explainer) BUT the
 *   admin may still override to already_paid — F6 data may lag reality and
 *   the admin attests the funds were received.
 * - `free`               → no default (invoice only creatable via amountOverride).
 * - `refunded`           → HARD BLOCK, no override.
 * - `no_show`            → no default (attendance says nothing about payment).
 *
 * GLOBAL (enforced by the caller's UI + server guard
 * `event_no_tin_requires_paid_issue`): bill_first is never selectable for a
 * no-TIN buyer, which is why this function never defaults to bill_first when
 * `hasTin` is false.
 */
export function defaultModeFor(
  paymentStatus: string,
  hasTin: boolean,
): { mode: IssuanceMode | null; locked: 'refunded' | null } {
  switch (paymentStatus) {
    case 'paid':
      return { mode: 'already_paid', locked: null };
    case 'pending':
    case 'waitlisted':
      return { mode: hasTin ? 'bill_first' : null, locked: null };
    case 'refunded':
      return { mode: null, locked: 'refunded' };
    // 'free', 'no_show', and anything unrecognised: explicit admin choice.
    default:
      return { mode: null, locked: null };
  }
}

/**
 * Display-only doc-type adjustment for the as-paid path: a TIN buyer whose
 * fee is recorded as already paid gets the ONE combined document
 * (ใบกำกับภาษี/ใบเสร็จรับเงิน — `receipt_combined` kind), not a plain tax
 * invoice. Receipt (no-TIN) and pending (matched member) are unchanged.
 */
export function displayDocType(base: DocTypeKind, mode: IssuanceMode | null): DocTypeKind {
  return mode === 'already_paid' && base === 'taxInvoice' ? 'taxInvoiceReceipt' : base;
}

/**
 * 064 H-1 (spec §3.2) — ภ.พ.30 (PP.30) closed-period check for a backdated
 * payment date. Output VAT for a payment received in month M must be declared
 * on that month's ภ.พ.30 return, due the 15th of month M+1. We deliberately
 * use the statutory paper-filing 15th and IGNORE the e-filing extension
 * (~the 23rd): the 15th is the conservative bound, so the warning can only
 * over-warn (prompting an accountant check), never under-warn past a real
 * deadline. Returns true iff `todayYmd` is strictly AFTER that deadline —
 * i.e. the payment's VAT period is already closed and an additional filing
 * with surcharge may be required.
 *
 * Pure string/date math on YYYY-MM-DD (lexicographic compare on the ISO
 * shape is chronological — no Date/library needed). Malformed input → false
 * (defensive: no warning rather than a wrong one).
 */
export function isPastVatFilingDeadline(paymentDateYmd: string, todayYmd: string): boolean {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(paymentDateYmd);
  if (m === null || !/^\d{4}-\d{2}-\d{2}$/.test(todayYmd)) return false;
  let year = Number(m[1]);
  let month = Number(m[2]) + 1; // ภ.พ.30 deadline month = payment month + 1
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const deadline = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-15`;
  return todayYmd > deadline;
}

/** Same set the record-payment form offers — out-of-band methods only. */
const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash', 'other'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Typed error codes of POST /api/invoices/[id]/issue-as-paid we have copy
 * for (`admin.invoices.issueAsPaid.errors.*`); anything else falls back to
 * codeFallback/unknown — mirrors the event-draft errors map below.
 */
const AS_PAID_ERROR_CODES = [
  'invalid',
  'not_event_subject',
  'payment_date_future',
  // 064 S1 — registration refunded between draft and as-paid issuance
  // (issuance-time TOCTOU re-check). `registration_lookup_failed` stays on
  // codeFallback — it is an internal verification error, not operator-fixable.
  'registration_refunded',
  'invalid_lines',
  'overflow',
  'no_buyer_snapshot',
  'member_archived',
  'settings_missing',
  'invoice_already_issued',
  'invoice_not_found',
  'member_not_found',
  'pdf_render_failed',
  'blob_upload_failed',
] as const;

/** Today in Asia/Bangkok as YYYY-MM-DD (en-CA gives the ISO date shape). */
function bangkokTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function EventFeeForm({
  events,
  initialEventId,
  initialRegistrationId,
}: {
  readonly events: readonly EventOption[];
  /** Pre-selected event from a `?eventRegistrationId=` deep-link. */
  readonly initialEventId?: string | undefined;
  /** Pre-selected attendee from the same deep-link. */
  readonly initialRegistrationId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.eventFeeForm');
  // Payment-method labels are shared with the record-payment form.
  const tPay = useTranslations('admin.invoices.pay');
  const tAsPaid = useTranslations('admin.invoices.issueAsPaid');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const noEvents = events.length === 0;

  const [eventId, setEventId] = useState(() =>
    initialEventId && events.some((e) => e.eventId === initialEventId)
      ? initialEventId
      : '',
  );
  const [attendee, setAttendee] = useState<AttendeeRow | null>(null);
  const [amountThb, setAmountThb] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [buyer, setBuyer] = useState<NonMemberBuyer>(EMPTY_NON_MEMBER_BUYER);
  const [buyerErrors, setBuyerErrors] = useState<NonMemberBuyerErrors>({});
  const [amountError, setAmountError] = useState<string | null>(null);
  const [duplicateOpen, setDuplicateOpen] = useState(false);

  // Issuance mode — the admin's EXPLICIT pick. While null, the effective
  // mode falls back to `defaultModeFor` so the default stays reactive to the
  // buyer's TIN (typing a TIN on a pending non-member flips the default to
  // bill_first per §2.3 without an effect).
  const [modeChoice, setModeChoice] = useState<IssuanceMode | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');
  const [paymentDate, setPaymentDate] = useState('');
  // W2 (064 remediation) — optional out-of-band payment evidence, mirrored
  // from the record-payment form (same i18n labels). Sent to issue-as-paid
  // ONLY when non-blank (the route maps absent → null).
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [todayBkk, setTodayBkk] = useState('');
  const [paymentDateError, setPaymentDateError] = useState<string | null>(null);
  useEffect(() => {
    // Seed today (Asia/Bangkok) on the client only to avoid an SSR/CSR
    // hydration mismatch from `new Date()` — same pattern as PaymentForm.
    // F6 registrations carry no payment date to prefill from, so today is
    // the default; max is also clamped to today (payment_date_future is a
    // server reject anyway).
    const today = bangkokTodayIso();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaymentDate(today);
    setTodayBkk(today);
  }, []);

  const eventOptions: ComboboxOption[] = useMemo(
    () => events.map((e) => ({ value: e.eventId, label: e.label })),
    [events],
  );

  function handleEventChange(next: string) {
    setEventId(next);
    setAttendee(null);
    setAmountThb('');
    setAmountTouched(false);
    setBuyer(EMPTY_NON_MEMBER_BUYER);
    setBuyerErrors({});
    setAmountError(null);
    setModeChoice(null);
    setPaymentMethod('bank_transfer');
    // W0 (064 remediation) — a backdated payment date (and any reference/
    // notes typed for the PREVIOUS attendee) must not silently carry over
    // to a different event/attendee. Reset to the field default
    // (Bangkok-today) exactly like the mount effect does.
    setPaymentDate(bangkokTodayIso());
    setPaymentReference('');
    setPaymentNotes('');
    setPaymentDateError(null);
  }

  const handleAttendeeSelect = useCallback((row: AttendeeRow) => {
    setAttendee(row);
    // Pre-fill the amount from the ticket price (editable). Empty when the
    // ticket is free / unpriced so the admin must enter a value.
    setAmountThb(
      row.ticketPriceThb !== null && row.ticketPriceThb > 0
        ? String(row.ticketPriceThb)
        : '',
    );
    setAmountTouched(false);
    setBuyer(EMPTY_NON_MEMBER_BUYER);
    setBuyerErrors({});
    setAmountError(null);
    // Mode re-derives from the new registration's payment status.
    setModeChoice(null);
    setPaymentMethod('bank_transfer');
    // W0 (064 remediation) — see handleEventChange: per-attendee payment
    // details never leak across a selection change.
    setPaymentDate(bangkokTodayIso());
    setPaymentReference('');
    setPaymentNotes('');
    setPaymentDateError(null);
  }, []);

  const handlePickerError = useCallback(() => {
    toast.error(t('errors.unknown'));
  }, [t]);

  const matched = attendee !== null && isMatchedMember(attendee);
  const amountNum = Number(amountThb);
  const amountValid = amountThb !== '' && Number.isFinite(amountNum);
  const totalSatang = amountValid ? Math.round(amountNum * 100) : 0;
  const { subtotal, vat } = previewVatInclusive(totalSatang);

  // TIN presence for the §2.3 mode rules. 064 remediation B5 — matched
  // members now use SERVER-TRUTH presence (`buyerHasTin`, derived from the
  // F3 member's tax_id by the registrations endpoint; only the boolean
  // crosses the wire). A TIN-less matched member therefore gets the correct
  // no-TIN rules (bill_first disabled, receipt-path default) instead of the
  // legacy "matched ⇒ has TIN" guess. The guess survives ONLY as the
  // fallback when the field is absent/null (older API shape / degraded
  // lookup) — the server's `event_no_tin_requires_paid_issue` guard stays
  // authoritative either way. Non-members: the manual tax-id field rules.
  const hasTin = matched
    ? (attendee?.buyerHasTin ?? true)
    : buyer.taxId.trim().length > 0;
  const { mode: defaultMode, locked } =
    attendee !== null
      ? defaultModeFor(attendee.paymentStatus, hasTin)
      : { mode: null, locked: null };
  // A bill_first pick is invalidated when the TIN is cleared afterwards —
  // fall back to the (no-TIN) default rather than keeping an illegal mode.
  const effectiveMode: IssuanceMode | null = locked
    ? null
    : modeChoice === 'bill_first' && !hasTin
      ? defaultMode
      : (modeChoice ?? defaultMode);
  const isWaitingNoTin =
    attendee !== null &&
    locked === null &&
    !hasTin &&
    (attendee.paymentStatus === 'pending' || attendee.paymentStatus === 'waitlisted');

  // Doc-type: resolved via pure helper — matched/no-attendee → 'pending';
  // non-member with TIN → 'taxInvoice'; without → 'receipt'. The as-paid
  // path upgrades taxInvoice to the combined document for the preview.
  const docType = displayDocType(
    resolveDocType(attendee, matched, buyer.taxId),
    effectiveMode,
  );

  // 064 H-1 — non-blocking ภ.พ.30 closed-period warning (spec §3.2): the
  // backdated payment date falls in a VAT month whose filing deadline has
  // passed → an additional return with surcharge may be needed. Warn only;
  // submit stays ENABLED (the admin attests the real receipt date — blocking
  // would force a false date instead). todayBkk is '' until the client
  // effect seeds it, which keeps the warning off during SSR/first paint.
  const showVatPeriodWarning =
    effectiveMode === 'already_paid' &&
    todayBkk !== '' &&
    isPastVatFilingDeadline(paymentDate, todayBkk);

  function validateAmount(): string | null {
    if (amountThb === '' || !Number.isFinite(amountNum)) return t('amount.errors.required');
    if (amountNum < MIN_THB) return t('amount.errors.min');
    if (amountNum > MAX_THB) return t('amount.errors.max');
    return null;
  }

  /**
   * Step 2 — one-shot draft→paid issuance, shared by the submit flow AND
   * the toast Retry action (S6/S4, 064 remediation). NEVER throws: the
   * fetch + json parses are fully guarded, so a network-level rejection
   * after the draft POST succeeded surfaces as an error toast carrying the
   * draft-remains info instead of an unhandled rejection.
   *
   * On failure the draft REMAINS (visible in the invoice list): the toast
   * says exactly that and offers a Retry action that re-POSTs with the
   * captured payment details — suppressed for `invoice_already_issued`
   * (the row is already final; retrying cannot help). Both outcomes land
   * on the invoice detail; a retry fired later from the toast re-runs the
   * same navigation so a success refreshes onto the paid row.
   */
  async function issueDraftAsPaid(invoiceId: string): Promise<void> {
    let issueRes: Response | null = null;
    try {
      const refTrim = paymentReference.trim();
      const notesTrim = paymentNotes.trim();
      issueRes = await fetch(`/api/invoices/${invoiceId}/issue-as-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentDate,
          paymentMethod,
          // W2 — optional evidence fields; omitted when blank so the route
          // records null (server zod caps: 200 / 2000 chars).
          ...(refTrim !== '' ? { paymentReference: refTrim } : {}),
          ...(notesTrim !== '' ? { paymentNotes: notesTrim } : {}),
        }),
      });
    } catch {
      // S4 — network-level rejection (offline, DNS, aborted): fall through
      // to the unknown-error toast below WITH the draft-remains context.
      issueRes = null;
    }
    if (issueRes?.ok) {
      toast.success(tAsPaid('success'));
    } else {
      let issueCode: string | undefined;
      if (issueRes !== null) {
        const issuePayload = await issueRes.json().catch(() => ({}));
        issueCode = (issuePayload as { error?: { code?: string } })?.error?.code;
      }
      const issueKnown =
        issueCode !== undefined &&
        (AS_PAID_ERROR_CODES as readonly string[]).includes(issueCode);
      toast.error(
        issueKnown
          ? tAsPaid(`errors.${issueCode}`)
          : issueCode
            ? tAsPaid('errors.codeFallback', { code: issueCode })
            : tAsPaid('errors.unknown'),
        {
          description: tAsPaid('draftRemains'),
          // S6 — honest retry: the draft survived, so offer to re-run the
          // issue step right from the toast. Suppressed when the row is
          // ALREADY issued (terminal for this flow — just navigate).
          ...(issueCode === 'invoice_already_issued'
            ? {}
            : {
                action: {
                  label: tAsPaid('retry'),
                  onClick: () => {
                    void issueDraftAsPaid(invoiceId);
                  },
                },
              }),
        },
      );
    }
    router.push(`/admin/invoices/${invoiceId}`);
    router.refresh();
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!attendee) {
      toast.error(t('errors.noAttendee'));
      return;
    }
    // Defensive — the submit button is disabled in these states, but a
    // programmatic submit must not slip through the §2.3 gates.
    if (locked !== null || effectiveMode === null) return;

    const amtErr = validateAmount();
    setAmountError(amtErr);

    // Payment date is required (and not in the future, Bangkok) only on the
    // as-paid path. String comparison is safe on ISO YYYY-MM-DD.
    let dateErr: string | null = null;
    if (effectiveMode === 'already_paid') {
      const today = todayBkk || bangkokTodayIso();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
        dateErr = t('payment.errors.dateRequired');
      } else if (paymentDate > today) {
        dateErr = t('payment.errors.dateFuture');
      }
    }
    setPaymentDateError(dateErr);

    let buyerInvalid = false;
    if (!matched) {
      const raw = validateNonMemberBuyer(buyer);
      const resolved: NonMemberBuyerErrors = {};
      if (raw.legalName) resolved.legalName = t(`buyer.errors.${raw.legalName}`);
      if (raw.address) resolved.address = t(`buyer.errors.${raw.address}`);
      if (raw.taxId) resolved.taxId = t(`buyer.errors.${raw.taxId}`);
      if (raw.contactEmail) resolved.contactEmail = t(`buyer.errors.${raw.contactEmail}`);
      setBuyerErrors(resolved);
      buyerInvalid = !isNonMemberBuyerValid(buyer);
    } else {
      setBuyerErrors({});
    }

    if (amtErr || buyerInvalid || dateErr) return;

    // Send amountOverride ONLY when the admin edited the pre-filled price.
    // Otherwise omit it so the server uses the registration's ticketPriceThb.
    const body: Record<string, unknown> = {
      eventRegistrationId: attendee.registrationId,
    };
    if (amountTouched) {
      body.amountOverride = totalSatang;
    }
    if (!matched) {
      body.buyer = {
        legal_name: buyer.legalName.trim(),
        tax_id: buyer.taxId.trim() === '' ? null : buyer.taxId.trim(),
        address: buyer.address.trim(),
        primary_contact_name: buyer.contactName.trim(),
        primary_contact_email: buyer.contactEmail.trim(),
      };
    }

    startTransition(async () => {
      // S4 (064 remediation) — the WHOLE two-step submit is guarded: a
      // network-level rejection can no longer escape as an unhandled
      // promise rejection. `createdInvoiceId` discriminates the catch —
      // once the draft POST succeeded, the error toast must carry the
      // draft-remains info (and we still land on the surviving draft).
      let createdInvoiceId: string | null = null;
      try {
        const res = await fetch('/api/invoices/event-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 201) {
          const data = (await res.json()) as { invoice_id: string };
          createdInvoiceId = data.invoice_id;
          if (effectiveMode === 'already_paid') {
            // Step 2 — one-shot draft→paid issuance (shared helper; also
            // the toast Retry path). Never throws; handles its own toasts
            // + navigation.
            await issueDraftAsPaid(data.invoice_id);
            return;
          }
          toast.success(t('success'));
          router.push(`/admin/invoices/${data.invoice_id}`);
          return;
        }
        if (res.status === 409) {
          setDuplicateOpen(true);
          return;
        }
        const payload = await res.json().catch(() => ({}));
        const code = (payload as { error?: { code?: string } })?.error?.code;
        const known = code
          ? // Only map codes we have copy for; otherwise fall back.
            [
              'registration_not_found',
              'member_archived',
              'event_not_found',
              'attendee_erased',
              'registration_refunded',
              'no_fee_free_event',
              'invalid_amount',
              'buyer_required',
              'invalid_tax_id_format',
              'invalid_buyer_snapshot',
            ].includes(code)
          : false;
        toast.error(known ? t(`errors.${code}`) : t('errors.unknown'), {
          description: code && !known ? t('errors.codeFallback', { code }) : undefined,
        });
      } catch {
        if (createdInvoiceId !== null) {
          // The draft exists but something after its creation threw (e.g.
          // the 201 body failed to parse mid-flight). Tell the truth: the
          // draft remains, and land on it.
          toast.error(tAsPaid('errors.unknown'), {
            description: tAsPaid('draftRemains'),
          });
          router.push(`/admin/invoices/${createdInvoiceId}`);
          router.refresh();
        } else {
          toast.error(t('errors.unknown'));
        }
      }
    });
  }

  // Enable submit as soon as an attendee is chosen — field-level validation
  // (amount range, non-member buyer, payment date) runs ON submit and
  // surfaces inline errors, rather than silently disabling the button with
  // no explanation (ux-standards: never block submit without telling the
  // user why). The two §2.3 disable states ARE explained in the mode
  // section: `refunded` renders the hard-block card, and a null mode always
  // renders the waiting explainer or the choose hint.
  const canSubmit =
    !pending && !noEvents && attendee !== null && locked === null && effectiveMode !== null;

  return (
    <>
      {/* noValidate: validation is manual (amount/buyer/payment-date above)
          so the inline i18n errors render instead of the browser's native
          locale-fixed bubbles; `required`/`max` attributes stay on the
          inputs for picker clamping + semantics. */}
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-[var(--page-section-gap)]"
      >
        {/* 1. Event picker */}
        <div className="flex flex-col gap-[var(--field-label-gap)]">
          <Label htmlFor="eventId">{t('eventPicker.label')}</Label>
          <SearchableCombobox
            id="eventId"
            options={eventOptions}
            value={eventId}
            onChange={handleEventChange}
            placeholder={noEvents ? t('eventPicker.noEvents') : t('eventPicker.placeholder')}
            searchPlaceholder={t('eventPicker.search')}
            emptyMessage={t('eventPicker.empty')}
            ariaLabel={t('eventPicker.label')}
            disabled={noEvents}
          />
        </div>

        {/* 2. Attendee picker */}
        {eventId !== '' && (
          <div className="flex flex-col gap-[var(--field-label-gap)]">
            <Label id="attendee-picker-label">{t('attendeePicker.label')}</Label>
            <EventAttendeePickerLoader
              key={eventId}
              eventId={eventId}
              selectedRegistrationId={attendee?.registrationId ?? initialRegistrationId ?? null}
              onSelect={handleAttendeeSelect}
              onError={handlePickerError}
              labelId="attendee-picker-label"
            />
          </div>
        )}

        {/* 3. Buyer section */}
        {attendee !== null &&
          (matched ? (
            <div
              className="rounded-md border bg-muted/30 p-4"
              data-testid="matched-buyer-readonly"
            >
              <div className="text-xs text-muted-foreground">{t('buyer.legend')}</div>
              <p className="mt-1 text-sm">
                {t('buyer.matchedReadonly', { name: attendee.attendeeName })}
              </p>
            </div>
          ) : (
            <NonMemberBuyerFields
              value={buyer}
              onChange={setBuyer}
              errors={buyerErrors}
              disabled={pending}
            />
          ))}

        {/* 3b. Issuance mode (064 §2.3) — refunded hard-block, otherwise a
            radio pair with the F6-derived default. Payment fields render
            inside this section on the as-paid path. */}
        {attendee !== null &&
          (locked === 'refunded' ? (
            /* Canonical destructive hard-block card — same pattern as the
               member archived-banner (destructive-toned Card + decorative
               warning icon + semibold title + factual body). */
            <Card
              role="status"
              className="border-destructive/40 bg-destructive/5 p-4"
              data-testid="mode-refunded-blocked"
            >
              <div className="flex gap-3">
                <AlertTriangleIcon
                  className="mt-0.5 size-5 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-semibold">
                    {t('mode.refundedBlockedTitle')}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('mode.refundedBlocked')}
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            <fieldset className="flex flex-col gap-2" data-testid="mode-selector">
              <legend className="mb-1 text-sm font-medium">{t('mode.label')}</legend>
              <RadioGroup
                value={effectiveMode}
                onValueChange={(v) =>
                  setModeChoice(v === 'already_paid' || v === 'bill_first' ? v : null)
                }
                className="gap-3 sm:grid-cols-2"
              >
                <div className="flex items-start gap-2 rounded-md border p-3">
                  {/* Explicit `aria-labelledby` → the name-span. Without it,
                      Base UI's labelable fallback ASSIGNS `{id}-label` to the
                      (id-less) <label> itself, duplicating the span's
                      hardcoded id (axe duplicate-id-aria). Same pattern as
                      the invoice-type switcher. */}
                  <RadioGroupItem
                    id="issuance-mode-already-paid"
                    value="already_paid"
                    className="mt-0.5"
                    disabled={pending}
                    aria-labelledby="issuance-mode-already-paid-label"
                  />
                  <Label
                    htmlFor="issuance-mode-already-paid"
                    className="flex cursor-pointer flex-col gap-0.5"
                  >
                    <span id="issuance-mode-already-paid-label" className="font-medium">
                      {t('mode.alreadyPaid.label')}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('mode.alreadyPaid.hint')}
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2 rounded-md border p-3">
                  {/* When disabled for a no-TIN buyer, the visible reason
                      below is also wired up via `aria-describedby` so SR
                      users hear WHY the option is unavailable. */}
                  <RadioGroupItem
                    id="issuance-mode-bill-first"
                    value="bill_first"
                    className="mt-0.5"
                    disabled={pending || !hasTin}
                    aria-labelledby="issuance-mode-bill-first-label"
                    {...(!hasTin
                      ? { 'aria-describedby': 'mode-bill-first-needs-tin' }
                      : {})}
                  />
                  <Label
                    htmlFor="issuance-mode-bill-first"
                    className={
                      hasTin
                        ? 'flex cursor-pointer flex-col gap-0.5'
                        : 'flex cursor-not-allowed flex-col gap-0.5 opacity-60'
                    }
                  >
                    <span id="issuance-mode-bill-first-label" className="font-medium">
                      {t('mode.billFirst.label')}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('mode.billFirst.hint')}
                    </span>
                  </Label>
                </div>
              </RadioGroup>
              {/* Disabled-option reason is VISIBLE text (no hover-only
                  tooltip — same philosophy as the attendee picker's erased
                  rows: keyboard/SR/touch users must get it too). */}
              {!hasTin && (
                <p
                  id="mode-bill-first-needs-tin"
                  className="text-xs text-muted-foreground"
                  data-testid="mode-bill-first-needs-tin"
                >
                  {t('mode.billFirstNeedsTin')}
                </p>
              )}
              {effectiveMode === null &&
                (isWaitingNoTin ? (
                  <p
                    role="status"
                    className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
                    data-testid="mode-waiting-explainer"
                  >
                    {t('mode.waitingExplainer')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="mode-choose-hint">
                    {t('mode.chooseHint')}
                  </p>
                ))}

              {/* Payment details — as-paid path only. */}
              {effectiveMode === 'already_paid' && (
                <div
                  className="mt-1 grid gap-4 sm:grid-cols-2"
                  data-testid="as-paid-fields"
                  suppressHydrationWarning
                >
                  <div className="flex flex-col gap-[var(--field-label-gap)]">
                    <Label htmlFor="payment-date">{tPay('fields.date')}</Label>
                    <Input
                      id="payment-date"
                      type="date"
                      value={paymentDate}
                      onChange={(e) => {
                        setPaymentDate(e.target.value);
                        setPaymentDateError(null);
                      }}
                      required
                      disabled={pending}
                      {...(todayBkk ? { max: todayBkk } : {})}
                      aria-invalid={paymentDateError ? true : undefined}
                      aria-describedby={[
                        paymentDateError ? 'payment-date-error' : 'payment-date-hint',
                        ...(showVatPeriodWarning ? ['payment-date-vat-warning'] : []),
                      ].join(' ')}
                    />
                    {paymentDateError ? (
                      <p
                        id="payment-date-error"
                        className="text-xs text-destructive"
                        role="alert"
                      >
                        {paymentDateError}
                      </p>
                    ) : (
                      <p id="payment-date-hint" className="text-xs text-muted-foreground">
                        {t('payment.dateHint')}
                      </p>
                    )}
                    {/* 064 H-1 — amber warning-callout (same palette as the
                        schedule-editor read-only notice): non-blocking, so
                        role="status" (polite live region), NOT role="alert". */}
                    {showVatPeriodWarning && (
                      <p
                        id="payment-date-vat-warning"
                        role="status"
                        data-testid="payment-date-vat-warning"
                        className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
                      >
                        <AlertTriangleIcon
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-500"
                        />
                        <span>{t('payment.vatPeriodWarning')}</span>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-[var(--field-label-gap)]">
                    <Label htmlFor="payment-method">{tPay('fields.method')}</Label>
                    <Select
                      value={paymentMethod}
                      onValueChange={(v) => v && setPaymentMethod(v as PaymentMethod)}
                    >
                      <SelectTrigger
                        id="payment-method"
                        className="w-full"
                        aria-label={tPay('fields.method')}
                        disabled={pending}
                      >
                        <TranslatedSelectValue
                          placeholder={tPay('fields.method')}
                          translate={(v) => (v ? tPay(`methods.${v}`) : null)}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {tPay(`methods.${m}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* W2 (064 remediation) — optional payment evidence,
                      mirrored from the record-payment dialog (same i18n
                      labels + copy). maxLength mirrors the server zod caps
                      (200 / 2000) so the inline clamp and the 400 guard
                      agree. */}
                  <div className="flex flex-col gap-[var(--field-label-gap)]">
                    <Label htmlFor="payment-reference">
                      {tPay('fields.reference')}
                    </Label>
                    <Input
                      id="payment-reference"
                      value={paymentReference}
                      onChange={(e) => setPaymentReference(e.target.value)}
                      placeholder={tPay('fields.referencePlaceholder')}
                      maxLength={200}
                      disabled={pending}
                    />
                  </div>
                  <div className="flex flex-col gap-[var(--field-label-gap)]">
                    <Label htmlFor="payment-notes">{tPay('fields.notes')}</Label>
                    <Textarea
                      id="payment-notes"
                      value={paymentNotes}
                      onChange={(e) => setPaymentNotes(e.target.value)}
                      rows={3}
                      maxLength={2000}
                      disabled={pending}
                    />
                  </div>
                </div>
              )}
            </fieldset>
          ))}

        {/* 4. Amount */}
        {attendee !== null && (
          <div className="flex flex-col gap-[var(--field-label-gap)]">
            <Label htmlFor="amountThb">{t('amount.label')}</Label>
            <Input
              id="amountThb"
              type="number"
              inputMode="decimal"
              min={MIN_THB}
              max={MAX_THB}
              step="0.01"
              value={amountThb}
              onChange={(e) => {
                setAmountThb(e.target.value);
                setAmountTouched(true);
                setAmountError(null);
              }}
              disabled={pending}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? 'amount-error' : 'amount-help'}
            />
            {amountError ? (
              <p id="amount-error" className="text-xs text-destructive" role="alert">
                {amountError}
              </p>
            ) : (
              <p id="amount-help" className="text-xs text-muted-foreground">
                {t('amount.help')}
              </p>
            )}
          </div>
        )}

        {/* 5. Live VAT-inclusive preview + 6. doc-type badge */}
        {attendee !== null && amountValid && amountNum >= MIN_THB && (
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="vat-preview"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {t('vatPreview.label')}
              </span>
              <Badge
                role="status"
                variant={
                  docType === 'taxInvoice' || docType === 'taxInvoiceReceipt'
                    ? 'default'
                    : 'secondary'
                }
                aria-label={
                  ({
                    taxInvoice: t('docType.ariaTaxInvoice'),
                    taxInvoiceReceipt: t('docType.ariaTaxInvoiceReceipt'),
                    receipt: t('docType.ariaReceipt'),
                    pending: t('docType.ariaPending'),
                  } satisfies Record<DocTypeKind, string>)[docType]
                }
                data-testid="doc-type-badge"
              >
                {t(`docType.${docType}`)}
              </Badge>
            </div>
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('vatPreview.total')}</dt>
                <dd className="tabular-nums font-medium">{formatSatang(totalSatang)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('vatPreview.subtotal')}</dt>
                <dd className="tabular-nums">{formatSatang(subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('vatPreview.vat')}</dt>
                <dd className="tabular-nums">{formatSatang(vat)}</dd>
              </div>
            </dl>
          </div>
        )}

        <div className="flex justify-end gap-3">
          {/* Single button whose label switches by mode: as-paid = record &
              issue in one shot; bill_first = the unchanged draft flow. */}
          <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {effectiveMode === 'already_paid'
              ? pending
                ? t('recordAndIssueSubmitting')
                : t('recordAndIssue')
              : pending
                ? t('submitting')
                : t('submit')}
          </Button>
        </div>
      </form>

      {/* Soft-duplicate dialog — the unique index makes a duplicate a hard
          block, so this is informational (Cancel only). */}
      <AlertDialog open={duplicateOpen} onOpenChange={setDuplicateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('duplicateDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('duplicateDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('duplicateDialog.cancel')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
