'use client';

/**
 * Spec 122 US8b follow-up — the "Credit note to be issued" figures for the
 * amount being typed, read from GET /api/refunds/credit-note-preview.
 *
 * The browser does NO VAT arithmetic: the split is F4's proportional
 * credit-note VAT policy run on the server, and it is printed as received.
 * A waived (§105 receipt, voided invoice) or blocked document has no credit
 * note, so there is nothing to show — and neither is there after a failed
 * read: the preview is advisory, never a gate on the refund.
 *
 * Each answer is tagged with the amount it was asked for, so a figure for a
 * previous amount is never shown beside the current refund total.
 */
import { useEffect, useState } from 'react';

const DEBOUNCE_MS = 250;
const SATANG_RE = /^\d+$/;
const RATE_RE = /^\d+\.\d{4}$/;

export type CreditNoteSplit = {
  readonly netSatang: bigint;
  readonly vatSatang: bigint;
  /** The invoice's rate as stored, `x.xxxx` (e.g. `0.0700`). */
  readonly vatRate: string;
};

export type CreditNotePreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  /** `split: null` — no credit note (waived, blocked) or the read failed. */
  | { readonly status: 'ready'; readonly split: CreditNoteSplit | null };

type Answer = { readonly amountSatang: bigint; readonly split: CreditNoteSplit | null };

function parseSplit(body: unknown): CreditNoteSplit | null {
  const cn = (body as { creditNote?: Record<string, unknown> } | null)?.creditNote;
  if (!cn || cn['kind'] !== 'issue') return null;
  const { netSatang, vatSatang, vatRate } = cn;
  if (
    typeof netSatang !== 'string' ||
    typeof vatSatang !== 'string' ||
    typeof vatRate !== 'string' ||
    !SATANG_RE.test(netSatang) ||
    !SATANG_RE.test(vatSatang) ||
    !RATE_RE.test(vatRate)
  ) {
    return null;
  }
  return { netSatang: BigInt(netSatang), vatSatang: BigInt(vatSatang), vatRate };
}

export function useCreditNotePreview(
  invoiceId: string,
  amountSatang: bigint | null,
): CreditNotePreviewState {
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (amountSatang === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const url = `/api/refunds/credit-note-preview?invoiceId=${encodeURIComponent(invoiceId)}&amountSatang=${amountSatang.toString()}`;
      fetch(url, { signal: controller.signal })
        .then(async (res) => (res.ok ? parseSplit(await res.json()) : null))
        .catch(() => null)
        .then((split) => {
          if (!controller.signal.aborted) setAnswer({ amountSatang, split });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [invoiceId, amountSatang]);

  if (amountSatang === null) return { status: 'idle' };
  if (answer === null || answer.amountSatang !== amountSatang) return { status: 'loading' };
  return { status: 'ready', split: answer.split };
}
