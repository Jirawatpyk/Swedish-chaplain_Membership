'use client';

/**
 * 122 US8a (T808) — client previews for the invoice views that open a
 * dialog: the `Admin-record-payment` (+ `-mobile`) board is the list with the
 * issued row's "Record payment…" opened, the way an admin opens it. US8b
 * (T828) opens the detail page's Issue, Delete draft and Issue refund the
 * same way, found by test id or by the button's own label.
 * `CreditNotePreviewStub` answers the refund dialog's credit-note read.
 */
import { useEffect, useRef, type ReactNode } from 'react';

const CREDIT_NOTE_PREVIEW_PATH = '/api/refunds/credit-note-preview';

/**
 * The credit note F4 issues for the boards' amounts on the fixture invoice
 * (38,520.00 THB incl. 2,520.00 VAT) — sample answers, looked up, not
 * computed: the preview never does VAT arithmetic, the real route does.
 * Any other amount answers "blocked", which draws no rows.
 */
const CREDIT_NOTE_SPLITS: Readonly<Record<string, readonly [net: string, vat: string]>> = {
  '535000': ['500000', '35000'],
  '3317000': ['3100000', '217000'],
  '3852000': ['3600000', '252000'],
};

/**
 * Answers the refund dialog's credit-note preview read from the table above
 * (or as waived, for the §105-receipt state); every other request goes to the
 * network. Restores `fetch` on unmount.
 */
export function CreditNotePreviewStub({ waived }: { readonly waived: boolean }) {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      if (url.pathname !== CREDIT_NOTE_PREVIEW_PATH) return realFetch(input, init);
      const split = CREDIT_NOTE_SPLITS[url.searchParams.get('amountSatang') ?? ''];
      const creditNote = waived
        ? { kind: 'waived', reason: 'section_105_receipt' }
        : split
          ? { kind: 'issue', netSatang: split[0], vatSatang: split[1], vatRate: '0.0700' }
          : { kind: 'blocked' };
      return Promise.resolve(
        new Response(JSON.stringify({ creditNote }), { headers: { 'content-type': 'application/json' } }),
      );
    };
    return () => {
      window.fetch = realFetch;
    };
  }, [waived]);
  return null;
}

export function OpenFirstMatchingButton({
  testId,
  label,
  children,
}: {
  /** The trigger's `data-testid`; the first one in the subtree is clicked until a dialog opens. */
  readonly testId?: string;
  /** Or the start of the trigger's visible label, for a trigger with no test id. */
  readonly label?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The trigger can render (or hydrate) after this effect runs — the refund
    // trigger sits in a Suspense boundary — so keep clicking until a dialog
    // is open, for up to 5 s.
    let tries = 0;
    const id = window.setInterval(() => {
      const root = ref.current;
      if (!root || document.querySelector('[role="dialog"], [role="alertdialog"]') || ++tries > 50) {
        window.clearInterval(id);
        return;
      }
      const button = testId
        ? root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
        : [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label && b.textContent?.trim().startsWith(label));
      button?.click();
    }, 100);
    return () => window.clearInterval(id);
  }, [testId, label]);
  return <div ref={ref}>{children}</div>;
}
