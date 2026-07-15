/**
 * T086 — Member command-palette "Pay invoice" group (F5 Group I).
 *
 * Self-contained member-only palette. The staff `<CommandPalette>` is
 * mounted in the admin shell; members have no staff palette. This
 * component mounts its own ⌘K listener in the member shell and shows a
 * single "Payments" group with a "Pay invoice …" entry per issued
 * invoice returned by `GET /api/portal/invoices/search`.
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

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatPaymentAmount } from '@/lib/format-payment-summary';
// Type-only import of Role from the deep domain path — importing from
// the auth barrel would chain-pull argon2 into the client bundle.
 
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
 * Member-side command palette. Self-contained ⌘K listener + dialog +
 * one group. Returns `null` for any non-member caller — the parent
 * shell is already member-scoped but keep the guard so this component
 * is safe to mount anywhere.
 */
export function MemberCommandPalette({
  currentUserRole,
  membershipAccess = 'full',
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
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    if (currentUserRole !== 'member') return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            const active = document.activeElement;
            previouslyFocused.current =
              active instanceof HTMLElement && active !== document.body
                ? active
                : null;
          }
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentUserRole]);

  // Restore focus on close — defer one frame so cmdk's focus-trap
  // releases first.
  useEffect(() => {
    if (!open && previouslyFocused.current) {
      const target = previouslyFocused.current;
      previouslyFocused.current = null;
      requestAnimationFrame(() => target.focus());
    }
  }, [open]);

  // Lazy fetch on each (deferred) query keystroke while open.
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
  if (currentUserRole !== 'member') return null;

  const hasQuery = deferredQuery.trim().length > 0;
  // F-04 fix: show a dedicated "all paid up" empty-state when the
  // member has no pending invoices AND has not typed anything. The
  // pre-existing `emptyHint` is reserved for "I typed but nothing
  // matched", which is a different UX signal.
  const showTypedEmpty = hasQuery && rows.length === 0;
  const showAllPaidEmpty = !hasQuery && rows.length === 0;

  return (
    <CommandDialog
      title={t('title')}
      description={t('description')}
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Command>
        <CommandInput
          placeholder={t('placeholder')}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {showTypedEmpty && <CommandEmpty>{t('emptyHint')}</CommandEmpty>}
          {showAllPaidEmpty && (
            <CommandEmpty>{t('allPaidHint')}</CommandEmpty>
          )}
          {/* Payments group rendered FIRST when the member has
              outstanding invoices — pay-now is high-urgency relative
              to the low-frequency Broadcasts entries (quota-limited).
              When `rows.length === 0`, Broadcasts becomes the top
              group naturally. */}
          {rows.length > 0 && (
            <CommandGroup heading={t('group')}>
              {rows.map((row) => {
                const formattedAmount = formatPaymentAmount(
                  row.amountDue,
                  row.currency,
                  locale,
                );
                return (
                  <CommandItem
                    key={row.id}
                    // cmdk computes fuzzy-match score against this
                    // value; include amount + currency so the member
                    // can type an amount (major-unit THB) and find
                    // the matching invoice too.
                    value={`invoice ${row.invoiceNumber} ${row.amountDue} ${row.currency}`}
                    onSelect={() => handleSelect(row.id)}
                  >
                    <span className="truncate">
                      {t('label', {
                        invoiceNumber: row.invoiceNumber,
                        amount: formattedAmount,
                      })}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {/* F7 US3 Smart Feature #4 — Broadcasts entries: shown so members
              can deep-link to compose / benefits dashboard regardless of
              invoice state. 059-membership-suspension Task 9 item 7 —
              "Compose E-Blast" is hidden when the member is not `full`: the
              destination is denylisted while suspended (and unreachable at
              all while terminated), so offering it would be a dead-end
              shortcut. "View E-Blast usage" always stays — the Benefits
              page itself remains open. */}
          <CommandGroup heading={tBcast('group')}>
            {membershipAccess === 'full' && (
              <CommandItem
                value={`compose e-blast broadcast ${tBcast('compose.title')}`}
                onSelect={() => {
                  handleOpenChange(false);
                  router.push('/portal/broadcasts/new');
                }}
                data-testid="cmdk-broadcasts-compose"
              >
                <span className="truncate">{tBcast('compose.title')}</span>
              </CommandItem>
            )}
            <CommandItem
              value={`view e-blast usage benefits quota ${tBcast('benefits.title')}`}
              onSelect={() => {
                handleOpenChange(false);
                router.push('/portal/benefits?tab=broadcasts');
              }}
              data-testid="cmdk-broadcasts-benefits"
            >
              <span className="truncate">{tBcast('benefits.title')}</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
