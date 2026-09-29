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
 * site (member portal, or a flag-off admin) renders EXACTLY the prior LAYOUT
 * — no popover, no chips, secondary filters inline (same DOM order + widths).
 *
 * Two shared-search BEHAVIOURS changed for ALL paths (portal included), both
 * net-positive and mirroring `directory-filters.tsx`: the search input is now
 * CONTROLLED with an URL→state reconcile (so Clear-all empties the visible box
 * instead of stranding the typed text), and `pushUrl` passes `{ scroll: false }`
 * (refining a filter no longer jumps the list to the top). Visual layout is
 * unchanged; only these two search interactions differ from the prior version.
 *
 * Spec 122 US4 — on AURA (shared by the member portal and `/admin/invoices`):
 * the FilterBar's own search (debounced, synced from the URL `q`), AURA
 * Selects with the same values and test ids, the "Filters" popover and the
 * paid-online toggle on AURA Popover / Button / Tooltip. The URL contract,
 * the clamps and the chips are unchanged.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, FilterBar, Icon, Popover, Select, Tooltip } from '@jirawatpyk/aura-react';
import { originFilterPatch } from './queue-view';
import { cn } from '@/lib/utils';

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
  /**
   * renewals-suspended-visibility-audit Task 3 — honour the `?dueBefore=
   * YYYY-MM-DD` URL param (strict `due_date < dueBefore` bound) as an
   * active filter: counts toward clear-all + renders a removable
   * "Due before {date}" chip. There is no input CONTROL for it — the param
   * arrives via drill-down links (first consumer: the renewals money
   * band's prior-fiscal-year sub-line) or a hand-edited URL. Defaults to
   * `false` so the member portal (whose server page never threads the
   * param) ignores a stray value — no phantom clear-all, no split-brain
   * (mirrors the `show088Filters` / `paidOnlineActive` guards). The admin
   * page passes `true` unconditionally (generic filter, not flag-gated).
   */
  readonly showDueBeforeFilter?: boolean;
}

export function InvoiceFilters({
  statusOptions = STATUS_VALUES,
  showPaidOnlineChip = true,
  show088Filters = false,
  showAutoInvoiceFilter = false,
  showDueBeforeFilter = false,
}: InvoiceFiltersProps = {}) {
  const t = useTranslations('admin.invoices.list');
  const tStatus = useTranslations('admin.invoices.list.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  // Stable focus target for when a chip or Clear unmounts on its own removal
  // (mirrors `directory-filters.tsx`): the FilterBar's always-rendered search
  // input keeps focus off `<body>`, a focus-loss class axe never catches.
  const barRef = useRef<HTMLDivElement>(null);
  const focusSearch = () =>
    barRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  // Bumped by Clear all to remount the FilterBar; focus follows to the new
  // search input once it is in the DOM.
  const [searchResetKey, setSearchResetKey] = useState(0);
  useEffect(() => {
    if (searchResetKey > 0) focusSearch();
  }, [searchResetKey]);

  const tReconciliation = useTranslations('admin.paymentReconciliation.filterChip');
  // The URL is the source of truth; AURA's FilterBar keeps the typed draft,
  // debounces it (300 ms, Enter / clear at once) and re-syncs from `q` when
  // the URL changes (back / forward, a shared link, Clear).
  const currentQ = searchParams.get('q') ?? '';
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
  // renewals-suspended-visibility-audit Task 3 — dueBefore clamp: strict
  // `YYYY-MM-DD` shape + a real calendar date, matching the server page's
  // `parseDueBeforeParam` so the chip and the data can never split-brain.
  // V8's lenient parser ROLLS OVER out-of-range days (2026-02-30 → Mar 2)
  // instead of rejecting them, so the UTC round-trip must reproduce the
  // input exactly. Gated on `showDueBeforeFilter` (see the prop doc).
  const rawDueBefore = searchParams.get('dueBefore');
  const dueBeforeMs =
    rawDueBefore !== null && /^\d{4}-\d{2}-\d{2}$/.test(rawDueBefore)
      ? Date.parse(`${rawDueBefore}T00:00:00.000Z`)
      : Number.NaN;
  const currentDueBefore =
    showDueBeforeFilter &&
    rawDueBefore !== null &&
    !Number.isNaN(dueBeforeMs) &&
    new Date(dueBeforeMs).toISOString().slice(0, 10) === rawDueBefore
      ? rawDueBefore
      : null;

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

  const hasAnyFilter =
    currentQ.trim() !== '' ||
    effectiveStatus !== 'all' ||
    currentSubject !== 'all' ||
    paidOnlineActive ||
    currentDocType !== 'all' ||
    currentTaxPoint !== 'all' ||
    currentVat !== 'all' ||
    currentOrigin !== 'all' ||
    currentDueBefore !== null;

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
    /**
     * A4 (UX review) — per-chip label width override. The default 24ch is
     * right for the value-label chips, but the dueBefore chip's payload IS
     * the date: in SV/TH the localized prefix + `YYYY-MM-DD` overruns 24ch
     * and truncates the one part that matters.
     */
    readonly labelClassName?: string;
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
  // renewals-suspended-visibility-audit Task 3 — the dueBefore chip. Unlike
  // the other secondaries it has NO Select control (URL-only filter from
  // drill-down links), so the chip is its ONLY visible representation +
  // clear affordance besides clear-all. Pushed into `secondaryChips` for
  // the collapsed view AND rendered as a standalone chip row in the inline
  // view below (the inline view otherwise ignores `secondaryChips` — every
  // other secondary shows its state in its own inline control there).
  const dueBeforeChip =
    currentDueBefore !== null
      ? {
          key: 'dueBefore',
          // {date} stays the raw ISO `YYYY-MM-DD` — a technical filter
          // echo, unambiguous across locales (BE conversion is display-only
          // for member-facing dates, not for a filter token an admin may
          // copy back into a URL).
          label: t('filters.dueBefore.chip', { date: currentDueBefore }),
          clear: () => pushUrl({ dueBefore: null }),
          // A4 — see `labelClassName` doc: the DATE must never truncate.
          labelClassName: 'max-w-[28ch]',
        }
      : null;
  if (dueBeforeChip) secondaryChips.push(dueBeforeChip);
  const secondaryActiveCount = secondaryChips.length;

  // --- Shared inline controls (identical in both layouts) -------------------
  const statusSelect = (
    <Select
      aria-label={t('columns.status')}
      className="sm:w-[12rem]"
      value={effectiveStatus}
      onChange={(e) => pushUrl({ status: e.target.value !== 'all' ? e.target.value : null })}
      options={[
        { value: 'all', label: t('filters.allStatuses') },
        ...statusOptions.map((s) => ({ value: s, label: tStatus(s) })),
      ]}
    />
  );

  // 054-event-fee-invoices — subject filter (All types / Membership / Event).
  // URL `?subject=` is the source of truth; "all" clears the param. The width
  // is a parameter so the SAME wiring serves the inline bar and the popover.
  const subjectSelect = (className: string) => (
    <Select
      aria-label={t('filters.subject.label')}
      data-testid="invoice-subject-filter"
      className={className}
      value={currentSubject}
      onChange={(e) => pushUrl({ subject: e.target.value !== 'all' ? e.target.value : null })}
      options={[
        { value: 'all', label: t('filters.subject.all') },
        { value: 'membership', label: t('filters.subject.membership') },
        { value: 'event', label: t('filters.subject.event') },
      ]}
    />
  );

  // 107-auto-invoice Task 13 — origin filter (All origins / Manual /
  // Auto-renewal queue), only with FEATURE_AUTO_INVOICE. Choosing the queue
  // pushes `status=draft` with it (the queue IS drafts, verdict F1); leaving
  // it clears only that imposed draft. A primary filter: inline in both
  // layouts.
  const originSelect = showAutoInvoiceFilter ? (
    <Select
      aria-label={t('filters.origin.label')}
      data-testid="invoice-origin-filter"
      className="sm:w-[13rem]"
      value={currentOrigin}
      onChange={(e) => pushUrl(originFilterPatch(e.target.value, searchParams.get('status')))}
      options={[
        { value: 'all', label: t('filters.origin.all') },
        { value: 'manual', label: t('filters.origin.manual') },
        { value: 'auto_renewal', label: t('filters.origin.autoRenewal') },
      ]}
    />
  ) : null;

  // Paid-online reconciliation toggle (admin only). A pressed-state button;
  // the tooltip explains its scope on hover / focus, and the aria-label
  // carries the same scope for screen-reader and voice-control users.
  const paidOnlineToggle = showPaidOnlineChip ? (
    <Tooltip content={tReconciliation('tooltip')}>
      <Button
        type="button"
        variant={paidOnlineActive ? 'primary' : 'secondary'}
        size="sm"
        onClick={togglePaidOnline}
        data-testid="paid-online-filter-chip"
        aria-pressed={paidOnlineActive}
        aria-label={tReconciliation('ariaLabel')}
        {...(paidOnlineActive ? { icon: 'check' as const } : {})}
      >
        {tReconciliation('label')}
      </Button>
    </Tooltip>
  ) : null;

  const clearAll = () => {
    // Remount the FilterBar: its unmount clears a search still waiting on
    // the debounce (which would otherwise land 300 ms later with the old
    // params and re-apply itself) and its draft restarts from the URL.
    setSearchResetKey((k) => k + 1);
    pushUrl({
      q: null,
      status: null,
      paidOnline: null,
      subject: null,
      docType: null,
      taxPoint: null,
      vat: null,
      origin: null,
      dueBefore: null,
    });
    // Clearing flips `hasAnyFilter` false → this button unmounts itself;
    // focus moves to the always-present search input (the remounted one —
    // see the effect on `searchResetKey`) so it never drops to <body>.
  };

  const clearButton = hasAnyFilter ? (
    <Button variant="ghost" size="sm" icon="x" onClick={clearAll} aria-label={t('filters.clearAll')}>
      {t('filters.clearAll')}
    </Button>
  ) : null;

  // Shared removable-chip markup (collapsed chips row + the inline dueBefore
  // chip) — one renderer so the two can't drift. The remove button is named
  // after its filter ("Remove filter: …").
  const renderChip = (chip: {
    readonly key: string;
    readonly label: string;
    readonly clear: () => void;
    readonly labelClassName?: string;
  }) => (
    <span
      key={chip.key}
      className="inline-flex items-center gap-1 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface-hover)] py-0.5 pl-2 pr-1 text-xs text-[var(--aura-fg-primary)]"
    >
      <span className={cn('max-w-[24ch] truncate', chip.labelClassName)} title={chip.label}>
        {chip.label}
      </span>
      <button
        type="button"
        // Removing a chip unmounts it; focus moves to the search input first.
        onClick={() => {
          chip.clear();
          focusSearch();
        }}
        aria-label={t('filters.more.removeAria', { label: chip.label })}
        // `-my-1 p-1.5` gives a 24×24 hit target (WCAG 2.5.8) around the 12px
        // icon without growing the chip.
        className="-my-1 inline-flex rounded-[var(--aura-radius-sm)] p-1.5 text-[var(--aura-fg-secondary)] hover:text-[var(--aura-fg-primary)]"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );

  const chipsRow = (chips: ReadonlyArray<Parameters<typeof renderChip>[0]>) =>
    chips.length > 0 ? (
      // `role="group"` + label so a screen reader announces the run as the
      // active filters (parity with directory-filters.tsx).
      <div role="group" aria-label={t('filters.more.activeGroup')} className="flex flex-wrap gap-2">
        {chips.map(renderChip)}
      </div>
    ) : null;

  // Spec 122 US4 — below 1024px the search takes its own row and the filters
  // share the next one evenly, so their edges line up with the search (AURA
  // does the search row only below 768px, which left 768–1023px ragged). From
  // 1024px it is AURA's one row: search, then the fixed-width filters.
  // A stand-in until AURA #92 (FilterBar controls sharing the row, stack breakpoint).
  const bar = (children: React.ReactNode) => (
    <FilterBar
      key={searchResetKey}
      ref={barRef}
      className="max-lg:[&_.aura-filterbar\_\_search]:basis-full max-lg:[&_.aura-filterbar\_\_search]:max-w-none max-lg:[&_.aura-filterbar\_\_controls]:basis-full max-lg:[&_.aura-filterbar\_\_controls>.aura-field]:flex-[1_1_8rem]"
      search={currentQ}
      // Untrimmed on purpose: the FilterBar compares the URL back against
      // what it sent, so a trimmed "Acme " would rewrite the box while the
      // member types. Both pages trim `q` server-side.
      onSearchChange={(v) => pushUrl({ q: v || null })}
      searchLabel={t('searchLabel')}
      searchPlaceholder={t('searchPlaceholder')}
    >
      {children}
    </FilterBar>
  );

  // --- Inline layout (member portal / flag-off admin) ------------------------
  // Subject + Paid-online inline, no popover. The URL-only dueBefore filter
  // (a flag-off admin following a drill-down link) gets a chip row below the
  // bar; the portal never enables it.
  if (!collapseSecondary) {
    return (
      <div className="flex flex-col gap-2">
        {bar(
          <>
            {statusSelect}
            {subjectSelect('sm:w-[12rem]')}
            {originSelect}
            {paidOnlineToggle}
            {clearButton}
          </>,
        )}
        {dueBeforeChip ? chipsRow([dueBeforeChip]) : null}
      </div>
    );
  }

  // --- Collapsed layout (admin tax view) — "Filters" popover + chips row ----
  const field = (label: string, control: React.ReactNode) => (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-[var(--aura-fg-primary)]">{label}</span>
      {control}
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      {bar(
        <>
          {statusSelect}
          {originSelect}
          <Popover
            title={t('filters.more.title')}
            placement="bottom-start"
            width="min(18rem, calc(100vw - 2rem))"
            trigger={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon="filter"
                // No "(0 active)" noise: annotate the count only when there
                // is something to announce.
                aria-label={
                  secondaryActiveCount > 0
                    ? t('filters.more.ariaOpen', { count: secondaryActiveCount })
                    : t('filters.more.button')
                }
                data-testid="invoice-more-filters-trigger"
              >
                {t('filters.more.button')}
                {secondaryActiveCount > 0 && (
                  <Badge data-testid="invoice-more-filters-count" className="ml-1">
                    {secondaryActiveCount}
                  </Badge>
                )}
              </Button>
            }
          >
            <div className="grid gap-3" data-testid="filters-popover-content">
              {field(t('filters.subject.label'), subjectSelect('w-full'))}
              {/* 088 T065b (FR-031) — the three admin-only tax-document
                  filters; `show088Filters` is always true in this branch
                  (collapseSecondary === show088Filters), kept defensive. */}
              {show088Filters && (
                <>
                  {field(
                    t('filters.documentType.label'),
                    <Select
                      aria-label={t('filters.documentType.label')}
                      data-testid="invoice-document-type-filter"
                      className="w-full"
                      value={currentDocType}
                      onChange={(e) => pushUrl({ docType: e.target.value !== 'all' ? e.target.value : null })}
                      options={[
                        { value: 'all', label: t('filters.documentType.all') },
                        { value: 'sc', label: t('filters.documentType.sc') },
                        { value: 'rc', label: t('filters.documentType.rc') },
                        { value: 're', label: t('filters.documentType.re') },
                        { value: 'cn', label: t('filters.documentType.cn') },
                      ]}
                    />,
                  )}
                  {field(
                    t('filters.taxPoint.label'),
                    <Select
                      aria-label={t('filters.taxPoint.label')}
                      data-testid="invoice-tax-point-filter"
                      className="w-full"
                      value={currentTaxPoint}
                      onChange={(e) => pushUrl({ taxPoint: e.target.value !== 'all' ? e.target.value : null })}
                      options={[
                        { value: 'all', label: t('filters.taxPoint.all') },
                        { value: 'pre_payment', label: t('filters.taxPoint.prePayment') },
                        { value: 'at_payment', label: t('filters.taxPoint.atPayment') },
                      ]}
                    />,
                  )}
                  {field(
                    t('filters.vatTreatment.label'),
                    <Select
                      aria-label={t('filters.vatTreatment.label')}
                      data-testid="invoice-vat-treatment-filter"
                      className="w-full"
                      value={currentVat}
                      onChange={(e) => pushUrl({ vat: e.target.value !== 'all' ? e.target.value : null })}
                      options={[
                        { value: 'all', label: t('filters.vatTreatment.all') },
                        { value: 'standard', label: t('filters.vatTreatment.standard') },
                        { value: 'zero_rated_80_1_5', label: t('filters.vatTreatment.zeroRated') },
                      ]}
                    />,
                  )}
                </>
              )}
              {/* Paid-online toggle — self-labelled, no field label. */}
              {paidOnlineToggle}
              {/* #292 review A1 — the badge counts an active dueBefore, so
                  the popover shows it too: a read-only row (the filter is
                  URL-only, no picker by design) with a clear button reusing
                  the chip's handler. */}
              {dueBeforeChip &&
                field(
                  t('filters.dueBefore.label'),
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm tabular-nums" data-testid="invoice-due-before-readout">
                      {currentDueBefore}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon="x"
                      onClick={dueBeforeChip.clear}
                      aria-label={t('filters.more.removeAria', { label: dueBeforeChip.label })}
                    >
                      {t('filters.dueBefore.clear')}
                    </Button>
                  </div>,
                )}
            </div>
          </Popover>
          {clearButton}
        </>,
      )}
      {chipsRow(secondaryChips)}
    </div>
  );
}
