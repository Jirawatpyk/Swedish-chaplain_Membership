/**
 * F4 portal-invoices `combined-mode` receipt-number hint.
 *
 * For combined-mode tenants the receipt PDF reuses the invoice document
 * number, so the receipt-number cell shows an em-dash with an inline ⓘ
 * explaining the convention.
 *
 * UX-review follow-up F1 (T160 regression fix) — ported to the shared
 * `InfoHint` system pattern (Base UI Popover). The previous implementation
 * overrode the Tooltip trigger with `render={<span/>}`, which lost native
 * focusability entirely: keyboard users could never reach the hint, and a
 * hover-only tooltip is unreachable on touch anyway. `InfoHint`'s native
 * `<button>` trigger opens on click/tap/Enter/Space, closes on ESC +
 * outside click, and Base UI wires the ARIA state. Public props and the
 * caller's i18n keys (`receiptNumberCombinedAria` / …`Tooltip`) are
 * unchanged; `ariaLabel` now names the BUTTON (the em-dash stays plain
 * visible text beside it, same as before for sighted users). No
 * 'use client' needed any more — `InfoHint` owns the client boundary and
 * only serialisable string props cross it.
 */
import { InfoHint } from '@/components/ui/info-hint';

export interface CombinedReceiptHintProps {
  readonly ariaLabel: string;
  readonly tooltipText: string;
}

export function CombinedReceiptHint({
  ariaLabel,
  tooltipText,
}: CombinedReceiptHintProps): React.ReactElement {
  return (
    <span className="inline-flex min-h-6 items-center gap-1 text-sm text-muted-foreground">
      —
      <InfoHint ariaLabel={ariaLabel} triggerClassName="-my-1">
        {tooltipText}
      </InfoHint>
    </span>
  );
}
