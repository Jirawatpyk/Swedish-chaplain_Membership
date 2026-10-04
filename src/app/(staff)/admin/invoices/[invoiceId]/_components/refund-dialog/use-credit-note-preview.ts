'use client';

/**
 * Spec 122 US8b follow-up — the "Credit note to be issued" figures for the
 * amount being typed, read from GET /api/refunds/credit-note-preview.
 *
 * The browser does NO VAT arithmetic: the split is F4's proportional
 * credit-note VAT policy run on the server, and it is printed as received.
 * A waived (§105 receipt, voided invoice) or blocked document has no credit
 * note, so there is nothing to show — and neither is there after a failed or
 * timed-out read: the preview is advisory, never a gate on the refund.
 *
 * Each answer is tagged with the amount it was asked for, so a figure for a
 * previous amount is never shown beside the current refund total. A waived or
 * blocked verdict belongs to the DOCUMENT, not the amount, so once seen the
 * hook stops asking (no skeleton flashing on every keystroke for a §105
 * receipt).
 */
import { useEffect, useState } from 'react';
// TYPE-ONLY: the invoicing barrel reaches server-only modules.
import type { CreditNoteWaiverReason } from '@/modules/invoicing';

const DEBOUNCE_MS = 250;
const TIMEOUT_MS = 5_000;
const SATANG_RE = /^\d+$/;
const RATE_RE = /^\d+\.\d{4}$/;

/**
 * The waiver reasons this client knows how to name. A `Record` over F4's union,
 * so a new reason is a compile error here rather than a note with no copy; an
 * unknown string from the wire is treated like `blocked` (no note).
 */
const KNOWN_WAIVER_REASONS: Readonly<Record<CreditNoteWaiverReason, true>> = {
  section_105_receipt: true,
  invoice_voided: true,
};

function asWaiverReason(value: unknown): CreditNoteWaiverReason | null {
  return typeof value === 'string' && Object.hasOwn(KNOWN_WAIVER_REASONS, value)
    ? (value as CreditNoteWaiverReason)
    : null;
}

export type CreditNoteSplit = {
  readonly netSatang: bigint;
  readonly vatSatang: bigint;
  /** The invoice's rate as stored, `x.xxxx` (e.g. `0.0700`). */
  readonly vatRate: string;
};

export type CreditNotePreviewState =
  /**
   * No amount yet, or the document owes no credit note. `waivedReason` is set
   * when F4 waived it (§105 receipt, voided invoice) — the form says so before
   * Confirm; `null` for a blocked gate, which the refund refuses on its own.
   */
  | { readonly status: 'none'; readonly waivedReason: CreditNoteWaiverReason | null }
  /** Asking. `vatRate` is the rate of the last answer, if any, for the label. */
  | { readonly status: 'loading'; readonly vatRate: string | null }
  | { readonly status: 'ready'; readonly split: CreditNoteSplit }
  /** The read failed or timed out — show nothing, block nothing. */
  | { readonly status: 'failed' };

type Parsed =
  | { readonly kind: 'issue'; readonly split: CreditNoteSplit }
  | { readonly kind: 'none'; readonly waivedReason: CreditNoteWaiverReason | null }
  | { readonly kind: 'failed' };

type Answer = { readonly amountSatang: bigint; readonly result: Parsed };

function parse(body: unknown): Parsed {
  const cn = (body as { creditNote?: Record<string, unknown> } | null)?.creditNote;
  if (cn?.['kind'] === 'waived') return { kind: 'none', waivedReason: asWaiverReason(cn['reason']) };
  if (cn?.['kind'] === 'blocked') return { kind: 'none', waivedReason: null };
  if (cn?.['kind'] !== 'issue') return { kind: 'failed' };
  const { netSatang, vatSatang, vatRate } = cn;
  if (
    typeof netSatang !== 'string' ||
    typeof vatSatang !== 'string' ||
    typeof vatRate !== 'string' ||
    !SATANG_RE.test(netSatang) ||
    !SATANG_RE.test(vatSatang) ||
    !RATE_RE.test(vatRate)
  ) {
    return { kind: 'failed' };
  }
  return { kind: 'issue', split: { netSatang: BigInt(netSatang), vatSatang: BigInt(vatSatang), vatRate } };
}

export function useCreditNotePreview(
  invoiceId: string,
  amountSatang: bigint | null,
  /** A waiver the page already knows (F4's verdict at load): no read needed. */
  knownWaivedReason: CreditNoteWaiverReason | null = null,
): CreditNotePreviewState {
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Set once F4 says the document owes no credit note; the verdict belongs to
  // the document, not the amount, so it is never asked again.
  const [noCreditNote, setNoCreditNote] = useState<{ readonly waivedReason: CreditNoteWaiverReason | null } | null>(
    knownWaivedReason !== null ? { waivedReason: knownWaivedReason } : null,
  );
  const [lastRate, setLastRate] = useState<string | null>(null);

  useEffect(() => {
    if (amountSatang === null || noCreditNote !== null) return;
    const controller = new AbortController();
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const url = `/api/refunds/credit-note-preview?invoiceId=${encodeURIComponent(invoiceId)}&amountSatang=${amountSatang.toString()}`;
      fetch(url, { signal: controller.signal })
        .then(async (res): Promise<Parsed> => (res.ok ? parse(await res.json()) : { kind: 'failed' }))
        .catch((): Parsed => ({ kind: 'failed' }))
        .then((result) => {
          clearTimeout(timeout);
          // A superseded request (new amount, unmount) is dropped; a timed-out
          // one still lands, as `failed`.
          if (cancelled) return;
          if (result.kind === 'none') setNoCreditNote({ waivedReason: result.waivedReason });
          if (result.kind === 'issue') setLastRate(result.split.vatRate);
          setAnswer({ amountSatang, result });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [invoiceId, amountSatang, noCreditNote]);

  if (noCreditNote !== null) return { status: 'none', waivedReason: noCreditNote.waivedReason };
  if (amountSatang === null) return { status: 'none', waivedReason: null };
  if (answer === null || answer.amountSatang !== amountSatang) return { status: 'loading', vatRate: lastRate };
  const { result } = answer;
  if (result.kind === 'issue') return { status: 'ready', split: result.split };
  return result.kind === 'none' ? { status: 'none', waivedReason: result.waivedReason } : { status: 'failed' };
}
