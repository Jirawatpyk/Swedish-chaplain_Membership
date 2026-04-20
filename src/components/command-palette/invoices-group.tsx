/**
 * Invoices command-palette group stub — F4 US1/US6/US7.
 *
 * The `<CommandPalette>` consumer does not import this module yet;
 * full rendering is wired in T059 (US1 create/list entries) and T080
 * (US6 credit-note entries). US7 adds a static "Invoices" entry
 * below so the admin can jump to the global list from anywhere, and
 * a registration hook (`INVOICES_PALETTE_ENTRIES`) so future wiring
 * picks up whatever is exported here without editing the palette
 * shell.
 */
'use client';

type InvoicesGroupProps = {
  readonly onAfterNavigate: () => void;
};

export function InvoicesGroup(_props: InvoicesGroupProps) {
  // Rendering is held back until T059/T080 so the palette doesn't
  // show an empty heading mid-rollout. Consumers read
  // `INVOICES_PALETTE_ENTRIES` meanwhile.
  void _props;
  return null;
}

export type InvoicesPaletteEntry = {
  readonly key: string;
  readonly url: string;
  /** i18n key under `admin.commandPalette.invoices.*`. */
  readonly labelKey: string;
};

/**
 * Static entries available regardless of the page context. Per-member
 * deep-links (US7 — "jump to invoices for this member") are derived
 * at render time by the member-detail command palette wiring: those
 * entries need `memberId` + `companyName` from the page's data, so
 * they live in a member-scoped registry (to be added alongside the
 * T067 member palette hook) rather than this static list.
 */
export const INVOICES_PALETTE_ENTRIES: readonly InvoicesPaletteEntry[] = [
  {
    key: 'invoices.list',
    url: '/admin/invoices',
    labelKey: 'list',
  },
  {
    key: 'invoices.new',
    url: '/admin/invoices/new',
    labelKey: 'new',
  },
];

/**
 * Builder for US7 per-member entries. Consumed by the member-detail
 * page's command-palette registration hook so the admin can type
 * "invoices for Acme" and jump to `/admin/members/<id>#member-invoices`.
 * Anchor matches the `aria-labelledby` id on `MemberInvoicesSection`.
 */
export function buildMemberInvoicesEntry(
  memberId: string,
): InvoicesPaletteEntry {
  // The entry carries only URL + label key; `companyName` is passed
  // at render time via the i18n interpolation argument on the
  // consumer side (member-detail page palette registration hook).
  return {
    key: `invoices.byMember.${memberId}`,
    url: `/admin/members/${memberId}#member-invoices-heading`,
    labelKey: 'byMember',
  } satisfies InvoicesPaletteEntry;
}
