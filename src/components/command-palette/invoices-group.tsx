/**
 * T008 — Invoices command-palette group stub (F4 US1/US6).
 *
 * Empty group — entries (create draft, jump to list, jump to credit notes)
 * are populated during US1 + US6 implementation. Rendered inside
 * `<CommandPalette>` via `./groups.tsx` once wired.
 *
 * See specs/007-invoices-receipts/tasks.md T059 (US1 wiring) + T080
 * (US6 credit-note entries).
 */
'use client';

type InvoicesGroupProps = {
  readonly onAfterNavigate: () => void;
};

export function InvoicesGroup(_props: InvoicesGroupProps) {
  // Stub: entries filled during US1 (T059) + US6 (T080). Intentionally
  // render nothing until those tasks land — keeps the palette from
  // showing an empty heading. The `useTranslations` + `CommandGroup`
  // imports are re-introduced when entries exist.
  void _props;
  return null;
}

// Keep a named export separate from the component so callers can import
// the entry-registration signature before entries exist.
export type InvoicesPaletteEntry = {
  readonly key: string;
  readonly url: string;
  readonly labelKey: string;
};

export const INVOICES_PALETTE_ENTRIES: readonly InvoicesPaletteEntry[] = [];
