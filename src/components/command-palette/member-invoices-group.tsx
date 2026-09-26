/**
 * T086 — Member command-palette "Pay invoice" group (F5 Group I).
 *
 * Self-contained member-only palette. The staff `<CommandPalette>` is
 * mounted in the admin shell; members have no staff palette. This
 * component is mounted once in the member shell (AURA `Command`, whose ⌘K
 * hotkey it uses — spec 122 US1) and shows a "Payments" group with a
 * "Pay invoice …" entry per issued invoice returned by
 * `GET /api/portal/invoices/search`, then the E-Blast shortcuts.
 *
 * Contract (spec.md FR-025c, plan.md § UX Smart-feature, tasks.md T086):
 *   - Only renders for `role === 'member'` (caller is authoritative;
 *     defence-in-depth guard inside the component).
 *   - Fuzzy filter fires against the server endpoint, which only
 *     returns `status === 'issued'` invoices the member owns.
 *   - On select: router.push(`/portal/invoices/<id>?pay=1`) — the
 *     `?pay=1` query auto-opens the PaySheet (already wired by Group
 *     G's PayNowButton).
 *   - Empty state renders `portal.payment.cmdkPay.emptyHint` once the
 *     member has typed ≥1 char but the server returned no matches.
 *   - Strings live under `portal.payment.cmdkPay.*`.
 */
'use client';

import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Command, type CommandItem } from '@jirawatpyk/aura-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatPaymentAmount } from '@/lib/format-payment-summary';
import { OPEN_COMMAND_PALETTE_EVENT } from './open-event';

import type { Role } from '@/modules/auth/domain/role';

type MemberCommandPaletteProps = {
  readonly currentUserRole: Role;
  /**
   * 059-membership-suspension Task 9 item 7 — when not `'full'`, the
   * "Compose E-Blast" jump target is hidden (the destination route is
   * denylisted while suspended, and unreachable at all while terminated —
   * offering it would be a dead-end shortcut). "View E-Blast usage" stays
   * visible: the Benefits page is open regardless of membership access.
   * Defaults to `'full'` for callers that don't pass it (back-compat).
   */
  readonly membershipAccess?: 'full' | 'suspended' | 'terminated';
  /**
   * F7 break-glass — `false` when FEATURE_F7_BROADCASTS is off. Hides the
   * "Compose E-Blast" entry (its /portal/broadcasts/new target 503s via the
   * proxy kill-switch, so it would be a dead-end). "View E-Blast usage" stays
   * (the Benefits page falls back to the benefits tab gracefully). Defaults to
   * `true` for callers that don't pass it (back-compat); the server root always
   * passes the real `env.features.f7Broadcasts`.
   */
  readonly broadcastsEnabled?: boolean;
};

export type MemberInvoiceSearchRow = {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly amountDue: number;
  readonly currency: 'THB';
};

type SearchResponse = {
  readonly invoices: ReadonlyArray<MemberInvoiceSearchRow>;
};

/**
 * Member-side command palette: AURA `Command` (its ⌘K hotkey, dialog and
 * listbox) with the Payments and E-Blast groups. Returns `null` for any non-member caller — the parent
 * shell is already member-scoped but keep the guard so this component
 * is safe to mount anywhere.
 */
export function MemberCommandPalette({
  currentUserRole,
  membershipAccess = 'full',
  broadcastsEnabled = true,
}: MemberCommandPaletteProps) {
  const t = useTranslations('portal.payment.cmdkPay');
  const tBcast = useTranslations('portal.broadcasts.cmdk');
  const locale = useLocale();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ReadonlyArray<MemberInvoiceSearchRow>>([]);
  // F-07 fix: 200 ms trailing-edge debounce caps the fetch rate under
  // the 30 req/min server rate-limit. `useDeferredValue` is then
  // layered on top so React can interrupt the render if the member
  // keeps typing while the debounced value is in-flight.
  const debouncedQuery = useDebouncedValue(query, 200);
  const deferredQuery = useDeferredValue(debouncedQuery);

  // ⌘K is AURA's hotkey (off for a non-member, below); this is the header's
  // search button, should the portal add one (spec 122 US1).
  useEffect(() => {
    // rbac-portal-identity-ok: the MEMBER portal palette; the staff palette is a different component entirely.
    if (currentUserRole !== 'member') return;
    const openPalette = () => setOpen(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
  }, [currentUserRole]);

  useEffect(() => {
    if (!open) return;
    const q = deferredQuery.trim();
    // Always fetch (even with empty q) so opening the palette shows
    // the member's outstanding invoices without requiring them to
    // type — matches the "dashboard shortcut" UX the smart-feature
    // call-out in plan.md described.
    let cancelled = false;
    fetch(`/api/portal/invoices/search?q=${encodeURIComponent(q)}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const body = (await res.json()) as SearchResponse;
        if (cancelled) return;
        setRows(body.invoices);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, open]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setRows([]);
    }
  }, []);

  const handleSelect = useCallback(
    (invoiceId: string) => {
      handleOpenChange(false);
      router.push(`/portal/invoices/${invoiceId}?pay=1`);
    },
    [handleOpenChange, router],
  );

  // Defence-in-depth: if a non-member somehow reaches this mount,
  // render nothing — neither the listener nor the dialog.
  // rbac-portal-identity-ok: as above — renders nothing outside the member portal.
  if (currentUserRole !== 'member') return null;

  const hasQuery = deferredQuery.trim().length > 0;

  const go = (href: string) => {
    handleOpenChange(false);
    router.push(href);
  };
  // Payments FIRST when the member has outstanding invoices — pay-now is
  // high-urgency relative to the low-frequency Broadcasts entries
  // (quota-limited). With no invoices, Broadcasts is the top group.
  const items: CommandItem[] = [
    // F-04 — nothing owed and nothing typed: say so at the top of Payments
    // (an inert row; the E-Blast shortcuts below keep the list non-empty).
    ...(rows.length === 0 && !hasQuery
      ? [{ id: 'invoice-none', group: t('group'), label: t('allPaidHint'), disabled: true }]
      : []),
    ...rows.map((row) => ({
      id: `invoice-${row.id}`,
      group: t('group'),
      label: t('label', {
        invoiceNumber: row.invoiceNumber,
        amount: formatPaymentAmount(row.amountDue, row.currency, locale),
      }),
      onSelect: () => handleSelect(row.id),
    })),
    // F7 US3 Smart Feature #4 — Broadcasts entries, whatever the invoice
    // state. 059-membership-suspension Task 9 item 7 — "Compose E-Blast" is
    // hidden when the member is not `full` (the destination is denylisted
    // while suspended, unreachable while terminated); "View E-Blast usage"
    // always stays — the Benefits page itself remains open.
    ...(membershipAccess === 'full' && broadcastsEnabled
      ? [
          {
            id: 'broadcasts-compose',
            group: tBcast('group'),
            label: tBcast('compose.title'),
            keywords: ['compose', 'e-blast', 'broadcast'],
            onSelect: () => go('/portal/broadcasts/new'),
          },
        ]
      : []),
    {
      id: 'broadcasts-benefits',
      group: tBcast('group'),
      label: tBcast('benefits.title'),
      keywords: ['e-blast', 'usage', 'benefits', 'quota'],
      onSelect: () => go('/portal/benefits?tab=broadcasts'),
    },
  ];

  return (
    <Command
      open={open}
      onOpenChange={handleOpenChange}
      label={t('title')}
      placeholder={t('placeholder')}
      items={items}
      // Invoices come back already searched; only the two shortcuts are
      // matched here, against what was typed.
      filter={(item, q) => item.id.startsWith('invoice-') || !q.trim() || matches(item, q)}
      query={query}
      onQueryChange={setQuery}
      empty={t('emptyHint')}
    />
  );
}

function matches(item: CommandItem, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return [item.label, ...(item.keywords ?? [])].some((text) => text.toLocaleLowerCase().includes(q));
}
