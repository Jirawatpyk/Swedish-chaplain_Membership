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
 * Mirrors `CreateDraftForm` (membership) for toasts / redirect / disabled
 * states (ux-standards). The amount is entered in THB and converted to
 * satang for the API; `amountOverride` is sent ONLY when the admin edited
 * the pre-filled ticket price (otherwise omitted so the server uses the
 * registration's `ticketPriceThb`).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
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

type DocTypeKind = 'taxInvoice' | 'receipt' | 'pending';

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
  }, []);

  const handlePickerError = useCallback(() => {
    toast.error(t('errors.unknown'));
  }, [t]);

  const matched = attendee !== null && isMatchedMember(attendee);
  const amountNum = Number(amountThb);
  const amountValid = amountThb !== '' && Number.isFinite(amountNum);
  const totalSatang = amountValid ? Math.round(amountNum * 100) : 0;
  const { subtotal, vat } = previewVatInclusive(totalSatang);

  // Doc-type: a matched member's TIN is resolved server-side at issue — we
  // can't see it client-side, so show "pending". A non-member: tax invoice
  // iff they typed a TIN, else receipt.
  const docType: DocTypeKind =
    attendee === null
      ? 'pending'
      : matched
        ? 'pending'
        : buyer.taxId.trim().length > 0
          ? 'taxInvoice'
          : 'receipt';

  function validateAmount(): string | null {
    if (amountThb === '' || !Number.isFinite(amountNum)) return t('amount.errors.required');
    if (amountNum < MIN_THB) return t('amount.errors.min');
    if (amountNum > MAX_THB) return t('amount.errors.max');
    return null;
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!attendee) {
      toast.error(t('errors.noAttendee'));
      return;
    }

    const amtErr = validateAmount();
    setAmountError(amtErr);

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

    if (amtErr || buyerInvalid) return;

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
      const res = await fetch('/api/invoices/event-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const data = (await res.json()) as { invoice_id: string };
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
            'event_not_found',
            'attendee_erased',
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
    });
  }

  // Enable submit as soon as an attendee is chosen — field-level validation
  // (amount range, non-member buyer) runs ON submit and surfaces inline
  // errors, rather than silently disabling the button with no explanation
  // (ux-standards: never block submit without telling the user why).
  const canSubmit = !pending && !noEvents && attendee !== null;

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-[var(--page-section-gap)]">
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
                variant={docType === 'taxInvoice' ? 'default' : 'secondary'}
                aria-label={
                  docType === 'taxInvoice'
                    ? t('docType.ariaTaxInvoice')
                    : docType === 'receipt'
                      ? t('docType.ariaReceipt')
                      : t('docType.ariaPending')
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
          <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {pending ? t('submitting') : t('submit')}
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
