'use client';

/**
 * Invoices directory filters with URL-state sync.
 *
 * Parity with `src/components/members/directory-filters.tsx`: URL is the
 * source of truth (bookmarkable) + debounced search + status dropdown +
 * clear-all button. Pagination state (`cursor`, `page`) resets on every
 * filter change.
 *
 * Layout — Option A (2026-07 UX redesign): the admin *tax* view
 * (`show088Filters`) carries so many controls (Search + Status + Subject +
 * Origin + Document type + Tax point + VAT + Paid-online) that the single
 * FilterBar row overflowed. In that view ONLY (`collapseSecondary`), the
 * SECONDARY filters (Subject / Document type / Tax point / VAT / Paid-online)
 * collapse into a "Filters" popover with an active-count badge, and the
 * applied ones surface as removable chips below the bar. Every OTHER call
 * site (member portal, or a flag-off admin) renders EXACTLY the prior layout
 * — no popover, no chips, secondary filters inline.
 */

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { originFilterPatch } from './queue-view';
import { SearchIcon, XIcon, CheckIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/ui/filter-bar';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const DEBOUNCE_MS = 300;

/**
 * The status values the filter dropdown can render. This is the
 * presentation-layer *filter* vocabulary — a superset of the stored
 * domain `InvoiceStatus`: it also carries the DERIVED `'overdue'` view
 * (issued + Bangkok-today past dueDate), which the use-case + repo
 * translate to `status='issued' AND dueDate < today`. It is intentionally
 * NOT `@/modules/invoicing`'s `InvoiceStatus` (which has no `'overdue'`).
 */
const STATUS_VALUES = [
  'draft',
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
  'partially_credited',
] as const;

/** A single status value the filter dropdown may render. */
export type InvoiceStatusFilterValue = (typeof STATUS_VALUES)[number];

interface InvoiceFiltersProps {
  /**
   * Which status values to render in the status `<Select>`. Defaults to
   * the full admin vocabulary (`STATUS_VALUES`) so the admin call site is
   * unchanged. The member portal passes a subset that excludes `'draft'`
   * (members never see drafts — `includeDrafts:false` at the use-case
   * level — so a draft option would only yield an unexplained empty state).
   */
  readonly statusOptions?: readonly InvoiceStatusFilterValue[];
  /**
   * Whether to render the "Paid online" reconciliation chip. Defaults to
   * `true` so the admin call site is unchanged. The member portal passes
   * `false`: it is an admin reconciliation filter (succeeded card/PromptPay
   * payment), so a member who paid offline who toggled it would see their
   * legitimate invoices vanish — it is meaningless for self-service.
   */
  readonly showPaidOnlineChip?: boolean;
  /**
   * 088 T065b (FR-031) — render the three ADMIN-only tax-document filters
   * (document type SC/RC/RE/CN · payment-tax-point state · VAT treatment).
   * Defaults to `false` so the member portal + a flag-OFF admin render exactly
   * today's filter set. The page passes `env.features.f088TaxAtPayment`. When
   * false, any stray `?docType`/`?taxPoint`/`?vat` URL param is IGNORED here
   * (mirrors the `paidOnlineActive` guard) so a hand-typed link never surfaces
   * a phantom clear-all button.
   */
  readonly show088Filters?: boolean;
  /**
   * 107-auto-invoice Task 13 — render the "Origin" filter (All origins /
   * Manual / Auto-renewal queue). Defaults to `false` so the member portal
   * (which never threads `origin`) and a flag-off admin render exactly
   * today's filter set. The page passes `env.features.autoInvoice`. When
   * false, a stray `?origin=` URL param is IGNORED here (mirrors the
   * `show088Filters` guard) so a hand-typed link never surfaces a phantom
   * clear-all button.
   */
  readonly showAutoInvoiceFilter?: boolean;
}

export function InvoiceFilters({
  statusOptions = STATUS_VALUES,
  showPaidOnlineChip = true,
  show088Filters = false,
  showAutoInvoiceFilter = false,
}: InvoiceFiltersProps = {}) {
  const t = useTranslations('admin.invoices.list');
  const tStatus = useTranslations('admin.invoices.list.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable focus target for when a chip unmounts on its own removal (mirrors
  // `directory-filters.tsx`): moving focus to the always-rendered search input
  // keeps it off `<body>`, a focus-loss class axe never catches.
  const searchInputRef = useRef<HTMLInputElement>(null);

  const tReconciliation = useTranslations('admin.paymentReconciliation.filterChip');
  const currentQ = searchParams.get('q') ?? '';
  // Controlled search input (mirrors `directory-filters.tsx`). `searchValue`
  // holds what the user typed; the debounce below syncs it to the URL. We
  // reconcile FROM the URL only when the input is NOT focused (browser
  // back/forward, a shared link, the Clear-all button) — never mid-type, so
  // fast typing can't be reverted to an in-flight debounced value. This is the
  // React "adjust state when a prop changes" pattern done DURING RENDER
  // (guarded by the `syncedQ` tracker), not in an effect — no cascading
  // re-render, no `key`-based remount (the remount was the original focus-drop
  // bug). Before this was an uncontrolled `defaultValue`, so Clear-all cleared
  // the URL `q` but left the typed text stranded in the box; now the reconcile
  // pulls the emptied value back into `searchValue`.
  const [searchValue, setSearchValue] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [syncedQ, setSyncedQ] = useState(currentQ);
  if (currentQ !== syncedQ) {
    setSyncedQ(currentQ);
    if (!isSearchFocused) setSearchValue(currentQ);
  }
  const currentStatus = searchParams.get('status') ?? 'all';
  // Clamp the URL status to the options THIS call site actually renders.
  // The portal passes `statusOptions` WITHOUT 'draft' (members never see
  // drafts), so a stale/hand-typed `?status=draft` has no matching
  // `<SelectItem>`. Without this clamp the trigger would still translate +
  // show "Draft" AND `hasAnyFilter` would flip true (phantom clear-all)
  // while the server's `parseStatusFilter('draft')` falls back to 'all' and
  // returns an UNFILTERED list — a split-brain (UI says Draft+clear-all,
  // data is unfiltered). Clamping to the permitted vocabulary keeps the
  // Select value + the active-filter computation honest. No-op for admin:
  // its default `statusOptions` is the full list, so 'draft' clamps to
  // itself. Mirrors the `paidOnlineActive` guard below.
  //
  // Uses `.some((s) => s === …)` rather than `statusOptions.includes(…)`:
  // calling an array method (`.includes`) directly on the `statusOptions`
  // *prop* triggers a React Compiler memoization bailout
  // (`react-hooks/preserve-manual-memoization`) that breaks the `pushUrl`
  // useCallback below — the bailout is reported at the useCallback but is a
  // whole-component effect (commit cf758387). The `.some` predicate form is
  // behaviour-identical for string elements and avoids the bailout, keeping
  // the manual memo preserved. (The `pushUrl` useCallback pattern itself
  // mirrors `directory-filters.tsx`; that file never does an array method on
  // a prop, so it has no `.some`/`.includes` equivalent to this idiom.)
  const effectiveStatus = statusOptions.some((s) => s === currentStatus)
    ? currentStatus
    : 'all';
  // When the chip is hidden (member portal) the paid-online filter is not
  // reachable, so a stray `?paidOnline=1` (hand-typed URL / stale link) must
  // NOT count as an active filter here — otherwise the clear-all button would
  // appear with no chip to explain it. The portal page already ignores the
  // param when threading filters to the use-case.
  const paidOnlineActive =
    showPaidOnlineChip && searchParams.get('paidOnline') === '1';
  // 054-event-fee-invoices — subject filter (all | membership | event).
  // Only the two known subjects are honoured; anything else => 'all'.
  const rawSubject = searchParams.get('subject');
  const currentSubject =
    rawSubject === 'membership' || rawSubject === 'event' ? rawSubject : 'all';
  // 088 T065b (FR-031) — admin-only tax-document filters. Each is clamped to
  // its permitted vocabulary AND gated on `show088Filters`, so a stray URL
  // param on the flag-OFF admin view (or the member portal) is treated as
  // 'all' — no phantom clear-all, no split-brain (mirrors the subject +
  // paidOnline guards above).
  const rawDocType = searchParams.get('docType');
  const currentDocType =
    show088Filters &&
    (rawDocType === 'sc' ||
      rawDocType === 'rc' ||
      rawDocType === 're' ||
      rawDocType === 'cn')
      ? rawDocType
      : 'all';
  const rawTaxPoint = searchParams.get('taxPoint');
  const currentTaxPoint =
    show088Filters &&
    (rawTaxPoint === 'pre_payment' || rawTaxPoint === 'at_payment')
      ? rawTaxPoint
      : 'all';
  const rawVat = searchParams.get('vat');
  const currentVat =
    show088Filters &&
    (rawVat === 'standard' || rawVat === 'zero_rated_80_1_5')
      ? rawVat
      : 'all';
  // 107-auto-invoice Task 13 — origin filter (all | manual | auto_renewal).
  // Gated + clamped the same way as the 088 filters above.
  const rawOrigin = searchParams.get('origin');
  const currentOrigin =
    showAutoInvoiceFilter &&
    (rawOrigin === 'manual' || rawOrigin === 'auto_renewal')
      ? rawOrigin
      : 'all';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      params.delete('cursor');
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        // `{ scroll: false }` — refining filters must NOT jump the list to the
        // top (mirrors directory-filters.tsx). Matters more post-redesign: the
        // popover invites setting several filters in a row, and each debounced
        // keystroke / Select pick would otherwise scroll-reset (CLS, ux §9.4).
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [searchParams, router, pathname],
  );

  const onSearchChange = (value: string) => {
    setSearchValue(value); // controlled — reflect the keystroke immediately
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    currentQ !== '' ||
    effectiveStatus !== 'all' ||
    currentSubject !== 'all' ||
    paidOnlineActive ||
    currentDocType !== 'all' ||
    currentTaxPoint !== 'all' ||
    currentVat !== 'all' ||
    currentOrigin !== 'all';

  const togglePaidOnline = () => {
    pushUrl({ paidOnline: paidOnlineActive ? null : '1' });
  };

  // Option A — collapse the SECONDARY filters into a popover ONLY in the
  // cluttered admin-tax view. When false (member portal, or admin with the
  // 088 flag off) the layout is byte-for-byte today's inline layout: the two
  // are gated on the SAME flag, so the 088 selects never render inline anyway.
  const collapseSecondary = show088Filters;

  // Removable secondary-filter chips (ux-standards §9.4) — a data array so the
  // list is DRY. Each `clear` reuses the same `pushUrl({ key: null })` the
  // Selects use, so there is no new URL wiring. Only rendered in the collapsed
  // view; `secondaryActiveCount` (the popover badge) is its length. Guards on
  // each filter (`show088Filters` / `showPaidOnlineChip`) already fold the
  // clamped values to 'all' / false, so this list is empty on the inline view.
  const secondaryChips: {
    readonly key: string;
    readonly label: string;
    readonly clear: () => void;
  }[] = [];
  if (currentSubject !== 'all') {
    secondaryChips.push({
      key: 'subject',
      label:
        currentSubject === 'membership'
          ? t('filters.subject.membership')
          : t('filters.subject.event'),
      clear: () => pushUrl({ subject: null }),
    });
  }
  if (currentDocType !== 'all') {
    secondaryChips.push({
      key: 'docType',
      label: t(`filters.documentType.${currentDocType}`),
      clear: () => pushUrl({ docType: null }),
    });
  }
  if (currentTaxPoint !== 'all') {
    secondaryChips.push({
      key: 'taxPoint',
      label:
        currentTaxPoint === 'pre_payment'
          ? t('filters.taxPoint.prePayment')
          : t('filters.taxPoint.atPayment'),
      clear: () => pushUrl({ taxPoint: null }),
    });
  }
  if (currentVat !== 'all') {
    secondaryChips.push({
      key: 'vat',
      label:
        currentVat === 'standard'
          ? t('filters.vatTreatment.standard')
          : t('filters.vatTreatment.zeroRated'),
      clear: () => pushUrl({ vat: null }),
    });
  }
  if (paidOnlineActive) {
    secondaryChips.push({
      key: 'paidOnline',
      label: tReconciliation('label'),
      clear: () => pushUrl({ paidOnline: null }),
    });
  }
  const secondaryActiveCount = secondaryChips.length;

  // --- Shared inline controls (identical in both layouts) -------------------
  const searchField = (
    /* L5: was min-w-[16rem]=256px — overflowed 320px mobile viewports
       after padding + sibling Status dropdown. On mobile (<640px) the
       search input owns the full row (FilterBar rule); on sm+ it
       flex-grows alongside the status dropdown. */
    <div className="relative min-w-0 sm:flex-1">
      <SearchIcon
        aria-hidden="true"
        className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={searchInputRef}
        type="search"
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        onFocus={() => setIsSearchFocused(true)}
        onBlur={() => setIsSearchFocused(false)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchLabel')}
        autoComplete="off"
        className="pl-9"
      />
    </div>
  );

  const statusSelect = (
    <Select
      value={effectiveStatus}
      onValueChange={(v) => pushUrl({ status: v && v !== 'all' ? v : null })}
    >
      <SelectTrigger className="sm:w-[12rem]" aria-label={t('columns.status')}>
        <TranslatedSelectValue
          placeholder={t('filters.allStatuses')}
          translate={(v) =>
            v === 'all' || !v ? t('filters.allStatuses') : tStatus(v)
          }
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('filters.allStatuses')}</SelectItem>
        {statusOptions.map((s) => (
          <SelectItem key={s} value={s}>
            {tStatus(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // 054-event-fee-invoices — subject filter (All types / Membership / Event).
  // Mirrors the status dropdown: URL `?subject=` param is the source of truth;
  // resetting to "all" clears the param. Parametrised by the trigger width so
  // the SAME wiring serves the inline layout (`sm:w-[12rem]`) and the collapsed
  // popover (`w-full`) — only the container/width moves, never the wiring.
  const subjectSelect = (triggerClassName: string) => (
    <Select
      value={currentSubject}
      onValueChange={(v) => pushUrl({ subject: v && v !== 'all' ? v : null })}
    >
      <SelectTrigger
        className={triggerClassName}
        aria-label={t('filters.subject.label')}
        data-testid="invoice-subject-filter"
      >
        <TranslatedSelectValue
          placeholder={t('filters.subject.all')}
          translate={(v) =>
            v === 'membership'
              ? t('filters.subject.membership')
              : v === 'event'
                ? t('filters.subject.event')
                : t('filters.subject.all')
          }
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('filters.subject.all')}</SelectItem>
        <SelectItem value="membership">
          {t('filters.subject.membership')}
        </SelectItem>
        <SelectItem value="event">{t('filters.subject.event')}</SelectItem>
      </SelectContent>
    </Select>
  );

  // 107-auto-invoice Task 13 — origin filter (All origins / Manual /
  // Auto-renewal queue). Rendered only when FEATURE_AUTO_INVOICE is on.
  // Selecting "Auto-renewal queue" is the review-queue entry point, so it
  // pushes `status=draft` alongside the origin: the queue IS drafts
  // (verdict F1 — keying the queue chrome on origin alone let paid §86/4
  // documents render as work items with a false "would be refused" badge
  // and a false "drafts awaiting review" screen-reader announcement).
  // Leaving the queue clears only that imposed `draft`. Stays INLINE in both
  // layouts — it is a primary filter, not one of the collapsed secondaries.
  const originSelect = showAutoInvoiceFilter ? (
    <Select
      value={currentOrigin}
      onValueChange={(v) =>
        pushUrl(originFilterPatch(v, searchParams.get('status')))
      }
    >
      <SelectTrigger
        className="sm:w-[13rem]"
        aria-label={t('filters.origin.label')}
        data-testid="invoice-origin-filter"
      >
        <TranslatedSelectValue
          placeholder={t('filters.origin.all')}
          translate={(v) =>
            v === 'manual'
              ? t('filters.origin.manual')
              : v === 'auto_renewal'
                ? t('filters.origin.autoRenewal')
                : t('filters.origin.all')
          }
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('filters.origin.all')}</SelectItem>
        <SelectItem value="manual">{t('filters.origin.manual')}</SelectItem>
        <SelectItem value="auto_renewal">
          {t('filters.origin.autoRenewal')}
        </SelectItem>
      </SelectContent>
    </Select>
  ) : null;

  // R3-fix N7 (2026-04-26): the staff admin layout already
  // mounts `<TooltipProvider>` at the shell level — a local
  // provider here would remount on every searchParam change
  // (router.replace fires on every filter edit). The shell
  // provider is sufficient.
  // R3-fix N6 (2026-04-26, Base UI Tooltip touch behaviour):
  // Base UI `Tooltip` opens on hover/focus only (per Tooltip
  // design philosophy — tooltips are supplementary, not
  // primary info). Sighted touch users do NOT see the popup
  // on tap (taps toggle the filter, the primary action). The
  // `aria-label` on the trigger carries the scope information
  // for SR + voice-control users; the visible chip label
  // ("Paid online") is sufficient for sighted touch users
  // since the filter result speaks for itself once toggled.
  // Accepted Base UI limitation.
  const paidOnlineToggle = showPaidOnlineChip ? (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps) => (
          <Button
            {...triggerProps}
            type="button"
            variant={paidOnlineActive ? 'default' : 'outline'}
            size="sm"
            onClick={togglePaidOnline}
            data-testid="paid-online-filter-chip"
            aria-pressed={paidOnlineActive}
            aria-label={tReconciliation('ariaLabel')}
            className={cn('gap-1', paidOnlineActive && 'shadow-sm')}
          >
            {paidOnlineActive && (
              <CheckIcon className="size-3.5" aria-hidden="true" />
            )}
            {tReconciliation('label')}
          </Button>
        )}
      />
      <TooltipContent>{tReconciliation('tooltip')}</TooltipContent>
    </Tooltip>
  ) : null;

  const clearButton = hasAnyFilter ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        // Clear the controlled search text IMPERATIVELY (mirrors
        // `directory-filters.tsx` `clearAll`). The focus() below flips
        // `isSearchFocused` true, which would otherwise block the URL→state
        // reconcile from emptying `searchValue` — so reset it here directly and
        // cancel any in-flight debounced push that would re-set `q`.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setSearchValue('');
        pushUrl({
          q: null,
          status: null,
          paidOnline: null,
          subject: null,
          docType: null,
          taxPoint: null,
          vat: null,
          origin: null,
        });
        // Clearing flips `hasAnyFilter` false → this button unmounts itself;
        // move focus to the always-present search input first so it never
        // drops to <body> (same measure as the chip ✕ handlers).
        searchInputRef.current?.focus();
      }}
      aria-label={t('filters.clearAll')}
    >
      <XIcon className="size-4" />
      {t('filters.clearAll')}
    </Button>
  ) : null;

  // --- Inline layout (member portal / flag-off admin) — unchanged ----------
  // Byte-for-byte today's layout: Subject + Paid-online inline, no popover,
  // no chips. (`show088Filters` is false here, so the three 088 selects that
  // used to sit inline never render — nothing to collapse.)
  if (!collapseSecondary) {
    return (
      <FilterBar>
        {searchField}
        {statusSelect}
        {subjectSelect('sm:w-[12rem]')}
        {originSelect}
        {paidOnlineToggle}
        {clearButton}
      </FilterBar>
    );
  }

  // --- Collapsed layout (admin tax view) — "Filters" popover + chips row ----
  return (
    <div className="space-y-2">
      <FilterBar>
        {searchField}
        {statusSelect}
        {originSelect}
        <Popover>
          <PopoverTrigger
            render={(triggerProps) => (
              // Base UI ref trap: DO NOT add a custom `ref=` here — the
              // Trigger's own ref arrives inside `triggerProps` and an
              // override would drop it, so the Positioner could never anchor
              // the popup (see `src/lib/merge-refs.ts`). No ref is needed.
              <Button
                {...triggerProps}
                type="button"
                variant="outline"
                size="sm"
                aria-label={t('filters.more.ariaOpen', {
                  count: secondaryActiveCount,
                })}
                data-testid="invoice-more-filters-trigger"
              >
                <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
                {t('filters.more.button')}
                {secondaryActiveCount > 0 && (
                  <Badge
                    variant="secondary"
                    data-testid="invoice-more-filters-count"
                    className="ml-0.5"
                  >
                    {secondaryActiveCount}
                  </Badge>
                )}
              </Button>
            )}
          />
          <PopoverContent
            align="start"
            // `w-72` is the primitive default; keep only the 320px-viewport
            // guard so the popup never forces a horizontal body scroll.
            className="max-w-[calc(100vw-2rem)]"
          >
            <PopoverTitle>{t('filters.more.title')}</PopoverTitle>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {t('filters.subject.label')}
              </span>
              {subjectSelect('w-full')}
            </div>
            {/* 088 T065b (FR-031) — three ADMIN-only tax-document filters.
                `show088Filters` is ALWAYS true in this branch (collapseSecondary
                === show088Filters), so the guard is defensive-only — kept so the
                block stays correct if the collapse trigger ever changes. Same
                wiring as the inline selects; only the container + width moved. */}
            {show088Filters && (
              <>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('filters.documentType.label')}
                  </span>
                  <Select
                    value={currentDocType}
                    onValueChange={(v) =>
                      pushUrl({ docType: v && v !== 'all' ? v : null })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('filters.documentType.label')}
                      data-testid="invoice-document-type-filter"
                    >
                      <TranslatedSelectValue
                        placeholder={t('filters.documentType.all')}
                        translate={(v) =>
                          v === 'sc' || v === 'rc' || v === 're' || v === 'cn'
                            ? t(`filters.documentType.${v}`)
                            : t('filters.documentType.all')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t('filters.documentType.all')}
                      </SelectItem>
                      <SelectItem value="sc">
                        {t('filters.documentType.sc')}
                      </SelectItem>
                      <SelectItem value="rc">
                        {t('filters.documentType.rc')}
                      </SelectItem>
                      <SelectItem value="re">
                        {t('filters.documentType.re')}
                      </SelectItem>
                      <SelectItem value="cn">
                        {t('filters.documentType.cn')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('filters.taxPoint.label')}
                  </span>
                  <Select
                    value={currentTaxPoint}
                    onValueChange={(v) =>
                      pushUrl({ taxPoint: v && v !== 'all' ? v : null })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('filters.taxPoint.label')}
                      data-testid="invoice-tax-point-filter"
                    >
                      <TranslatedSelectValue
                        placeholder={t('filters.taxPoint.all')}
                        translate={(v) =>
                          v === 'pre_payment'
                            ? t('filters.taxPoint.prePayment')
                            : v === 'at_payment'
                              ? t('filters.taxPoint.atPayment')
                              : t('filters.taxPoint.all')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t('filters.taxPoint.all')}
                      </SelectItem>
                      <SelectItem value="pre_payment">
                        {t('filters.taxPoint.prePayment')}
                      </SelectItem>
                      <SelectItem value="at_payment">
                        {t('filters.taxPoint.atPayment')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('filters.vatTreatment.label')}
                  </span>
                  <Select
                    value={currentVat}
                    onValueChange={(v) =>
                      pushUrl({ vat: v && v !== 'all' ? v : null })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('filters.vatTreatment.label')}
                      data-testid="invoice-vat-treatment-filter"
                    >
                      <TranslatedSelectValue
                        placeholder={t('filters.vatTreatment.all')}
                        translate={(v) =>
                          v === 'standard'
                            ? t('filters.vatTreatment.standard')
                            : v === 'zero_rated_80_1_5'
                              ? t('filters.vatTreatment.zeroRated')
                              : t('filters.vatTreatment.all')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t('filters.vatTreatment.all')}
                      </SelectItem>
                      <SelectItem value="standard">
                        {t('filters.vatTreatment.standard')}
                      </SelectItem>
                      <SelectItem value="zero_rated_80_1_5">
                        {t('filters.vatTreatment.zeroRated')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            {/* Paid-online toggle — self-labelled ("Paid online"), so it needs
                no separate field label. Same wiring as the inline chip. */}
            {paidOnlineToggle}
          </PopoverContent>
        </Popover>
        {clearButton}
      </FilterBar>
      {secondaryChips.length > 0 && (
        // `role="group"` + label so a screen reader announces this run as the
        // active filters (parity with directory-filters.tsx).
        <div
          role="group"
          aria-label={t('filters.more.activeGroup')}
          className="flex flex-wrap gap-2"
        >
          {secondaryChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-md border bg-secondary py-0.5 pl-2 pr-1 text-xs text-secondary-foreground"
            >
              <span className="max-w-[24ch] truncate" title={chip.label}>
                {chip.label}
              </span>
              <button
                type="button"
                // Removing a chip unmounts it; move focus to the always-present
                // search input first so it never drops to <body> (mirrors
                // `directory-filters.tsx`).
                onClick={() => {
                  chip.clear();
                  searchInputRef.current?.focus();
                }}
                aria-label={t('filters.more.removeAria', { label: chip.label })}
                // `-my-1 p-1.5` gives a 24×24 hit target (WCAG 2.5.8 baseline)
                // around the 12px icon WITHOUT growing the chip's height.
                className="-my-1 rounded-sm p-1.5 hover:bg-secondary-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
