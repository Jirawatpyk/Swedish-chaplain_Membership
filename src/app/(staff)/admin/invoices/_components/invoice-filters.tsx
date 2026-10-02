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
 * collapse into a "More filters" popover with an active-count badge, and the
 * applied ones surface as removable chips in the bar. Every OTHER call
 * site (member portal, or a flag-off admin) keeps Subject and Paid online in
 * the row, with no popover.
 *
 * Two shared-search BEHAVIOURS changed for ALL paths (portal included), both
 * net-positive and mirroring `directory-filters.tsx`: the search input is now
 * CONTROLLED with an URL→state reconcile (so Clear-all empties the visible box
 * instead of stranding the typed text), and `pushUrl` passes `{ scroll: false }`
 * (refining a filter no longer jumps the list to the top). Visual layout is
 * unchanged; only these two search interactions differ from the prior version.
 *
 * Spec 122 US4 — on AURA (shared by the member portal and `/admin/invoices`):
 * the FilterBar's own search (debounced, synced from the URL `q`) and the
 * popover on AURA Popover / Button / Tooltip.
 *
 * The filter pattern (spec 122, 2 Oct 2026; docs/aura-adoption.md § Filters):
 * one FilterBar row of compact `FilterSelect`s (Status, Origin, and Subject
 * where it is not in the popover), Paid online as a toggle `Tag`, the
 * secondaries behind "More filters", the count at the end of the row, and
 * every applied filter as a removable chip in the bar, which brings its own
 * "Clear filters". The URL contract, the clamps and the test ids are
 * unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AuraProvider,
  Badge,
  Button,
  FilterBar,
  FilterSelect,
  Popover,
  Select,
  Tag,
  Tooltip,
} from '@jirawatpyk/aura-react';
import { originFilterPatch } from './queue-view';

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
  /**
   * The filter pattern (spec 122): the matches across every page, shown at
   * the end of the row by AURA's FilterBar (worded and announced politely).
   * Omitted when there is nothing to count (no invoices, no filter).
   */
  readonly resultCount?: number;
}

export function InvoiceFilters({
  statusOptions = STATUS_VALUES,
  showPaidOnlineChip = true,
  show088Filters = false,
  showAutoInvoiceFilter = false,
  showDueBeforeFilter = false,
  resultCount,
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

  // Option A — collapse the SECONDARY filters into the "More filters" popover
  // ONLY in the cluttered admin-tax view. When false (member portal, or admin
  // with the 088 flag off) Subject and Paid online stay in the row: the two
  // are gated on the SAME flag, so the 088 selects never render inline anyway.
  const collapseSecondary = show088Filters;

  // Remounts the FilterBar: its unmount drops a search still waiting on the
  // debounce (which would otherwise land 300 ms later with the old params and
  // re-apply itself) and its draft restarts from the URL. Focus follows to
  // the new search input (the effect on `searchResetKey`).
  const resetSearch = () => setSearchResetKey((k) => k + 1);

  // The filter pattern (spec 122, ux-standards §9.4): every applied filter is
  // a removable chip in the FilterBar, named "{filter}: {value}", which is
  // also what makes the bar's own "Clear filters" appear. Paid online is a
  // toggle chip in the row, so it is not repeated as a chip there; inside the
  // popover (admin-tax view) it is hidden, so it gets one. The guards on each
  // filter (`show088Filters` / `showPaidOnlineChip` / the clamps) already
  // fold an unreachable value to 'all' / false, so no phantom chip appears.
  const chip = (label: string, value: string) => t('filters.chip', { label, value });
  const chips: { readonly id: string; readonly label: string; readonly clear: () => void }[] = [];
  if (currentQ.trim() !== '') {
    chips.push({
      id: 'q',
      label: t('filters.chipSearch', { q: currentQ.trim() }),
      clear: () => {
        resetSearch();
        pushUrl({ q: null });
      },
    });
  }
  if (effectiveStatus !== 'all') {
    chips.push({
      id: 'status',
      label: chip(t('columns.status'), tStatus(effectiveStatus)),
      clear: () => pushUrl({ status: null }),
    });
  }
  if (currentOrigin !== 'all') {
    chips.push({
      id: 'origin',
      label: chip(
        t('filters.origin.label'),
        currentOrigin === 'manual' ? t('filters.origin.manual') : t('filters.origin.autoRenewal'),
      ),
      // The same patch the Origin select sends for "all": leaving the queue
      // also drops the draft status it imposed.
      clear: () => pushUrl(originFilterPatch('all', searchParams.get('status'))),
    });
  }
  // The popover's filters: their count is the trigger's badge.
  const secondaryChips: typeof chips = [];
  if (currentSubject !== 'all') {
    secondaryChips.push({
      id: 'subject',
      label: chip(
        t('filters.subject.label'),
        currentSubject === 'membership' ? t('filters.subject.membership') : t('filters.subject.event'),
      ),
      clear: () => pushUrl({ subject: null }),
    });
  }
  if (currentDocType !== 'all') {
    secondaryChips.push({
      id: 'docType',
      label: chip(t('filters.documentType.label'), t(`filters.documentType.${currentDocType}`)),
      clear: () => pushUrl({ docType: null }),
    });
  }
  if (currentTaxPoint !== 'all') {
    secondaryChips.push({
      id: 'taxPoint',
      label: chip(
        t('filters.taxPoint.label'),
        currentTaxPoint === 'pre_payment' ? t('filters.taxPoint.prePayment') : t('filters.taxPoint.atPayment'),
      ),
      clear: () => pushUrl({ taxPoint: null }),
    });
  }
  if (currentVat !== 'all') {
    secondaryChips.push({
      id: 'vat',
      label: chip(
        t('filters.vatTreatment.label'),
        currentVat === 'standard' ? t('filters.vatTreatment.standard') : t('filters.vatTreatment.zeroRated'),
      ),
      clear: () => pushUrl({ vat: null }),
    });
  }
  if (paidOnlineActive && collapseSecondary) {
    secondaryChips.push({
      id: 'paidOnline',
      label: tReconciliation('label'),
      clear: () => pushUrl({ paidOnline: null }),
    });
  }
  // renewals-suspended-visibility-audit Task 3 — the dueBefore filter has NO
  // control (URL-only, from drill-down links), so its chip is its only
  // visible representation and clear affordance besides Clear filters, in
  // both layouts. {date} stays the raw ISO `YYYY-MM-DD`: a technical filter
  // echo an admin may copy back into a URL (BE is display-only for
  // member-facing dates). The label fits AURA's 24ch chip in every locale,
  // so the date is not cut short.
  const dueBeforeChip =
    currentDueBefore !== null
      ? {
          id: 'dueBefore',
          label: t('filters.dueBefore.chip', { date: currentDueBefore }),
          clear: () => pushUrl({ dueBefore: null }),
        }
      : null;
  if (dueBeforeChip && collapseSecondary) secondaryChips.push(dueBeforeChip);
  // The popover badge: the secondaries in the popover, dueBefore included
  // (#292 review A1 — the popover shows it as a read-only row).
  const secondaryActiveCount = secondaryChips.length;
  const allChips = [
    ...chips,
    ...(collapseSecondary ? secondaryChips : dueBeforeChip ? [dueBeforeChip] : []),
  ];
  const activeFilters = allChips.map((c) => ({
    id: c.id,
    label: c.label,
    // Removing a chip unmounts it; focus moves to the search input so it
    // never drops to <body> (the q chip's remount refocuses on its own).
    onRemove: () => {
      c.clear();
      if (c.id !== 'q') focusSearch();
    },
  }));

  // --- Controls ---------------------------------------------------------------
  // Admin's default view leaves drafts out (the page's `includeDrafts` is off
  // unless the status says Draft or the origin is the auto-renewal queue,
  // which IS drafts), so its first option says so; the portal never lists
  // drafts, so "All statuses" is true there, as it is in the queue. The face
  // shows the short "All" only where that is the whole truth.
  const draftsHiddenByDefault =
    statusOptions.some((s) => s === 'draft') && currentOrigin !== 'auto_renewal';
  const statusSelect = (
    <FilterSelect
      label={t('columns.status')}
      {...(draftsHiddenByDefault ? {} : { allLabel: t('filters.allShort') })}
      value={effectiveStatus}
      onChange={(v) => pushUrl({ status: v !== 'all' ? v : null })}
      options={[
        { value: 'all', label: draftsHiddenByDefault ? t('filters.allExceptDrafts') : t('filters.allStatuses') },
        ...statusOptions.map((s) => ({ value: s, label: tStatus(s) })),
      ]}
    />
  );

  // 054-event-fee-invoices — subject filter (All types / Membership / Event).
  // URL `?subject=` is the source of truth; "all" clears the param. A compact
  // FilterSelect in the row; a labelled Select in the popover's form.
  const subjectOptions = [
    { value: 'all', label: t('filters.subject.all') },
    { value: 'membership', label: t('filters.subject.membership') },
    { value: 'event', label: t('filters.subject.event') },
  ];
  const onSubject = (v: string) => pushUrl({ subject: v !== 'all' ? v : null });

  // 107-auto-invoice Task 13 — origin filter (All origins / Manual /
  // Auto-renewal queue), only with FEATURE_AUTO_INVOICE. Choosing the queue
  // pushes `status=draft` with it (the queue IS drafts, verdict F1); leaving
  // it clears only that imposed draft. A primary filter: in the row in both
  // layouts.
  const originSelect = showAutoInvoiceFilter ? (
    <FilterSelect
      label={t('filters.origin.label')}
      allLabel={t('filters.allShort')}
      data-testid="invoice-origin-filter"
      value={currentOrigin}
      onChange={(v) => pushUrl(originFilterPatch(v, searchParams.get('status')))}
      options={[
        { value: 'all', label: t('filters.origin.all') },
        { value: 'manual', label: t('filters.origin.manual') },
        { value: 'auto_renewal', label: t('filters.origin.autoRenewal') },
      ]}
    />
  ) : null;

  // Paid-online reconciliation toggle (admin only): a toggle chip, 44px on
  // touch, that AURA marks with a check while on. The tooltip explains its
  // scope on hover / focus, and the aria-label carries the same scope for
  // screen-reader and voice-control users.
  const paidOnlineToggle = showPaidOnlineChip ? (
    <Tooltip content={tReconciliation('tooltip')}>
      <Tag
        selected={paidOnlineActive}
        onClick={togglePaidOnline}
        touchHeight
        data-testid="paid-online-filter-chip"
        aria-label={tReconciliation('ariaLabel')}
      >
        {tReconciliation('label')}
      </Tag>
    </Tooltip>
  ) : null;

  const clearAll = () => {
    resetSearch();
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
  };

  // The bar's own "Clear filters" and chip × labels, in this page's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: t('filters.clearAll'),
      remove: (label: string) => t('filters.more.removeAria', { label }),
    }),
    [t],
  );

  // --- Collapsed layout only: the "More filters" popover ---------------------
  const field = (label: string, control: React.ReactNode) => (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-[var(--aura-fg-primary)]">{label}</span>
      {control}
    </div>
  );
  const morePopover = collapseSecondary ? (
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
          // 44px on touch, like the FilterSelects beside it.
          touchHeight
          // No "(0 active)" noise: annotate the count only when there is
          // something to announce.
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
        {field(
          t('filters.subject.label'),
          <Select
            aria-label={t('filters.subject.label')}
            data-testid="invoice-subject-filter"
            className="w-full"
            value={currentSubject}
            onChange={(e) => onSubject(e.target.value)}
            options={subjectOptions}
          />,
        )}
        {/* 088 T065b (FR-031) — the three admin-only tax-document filters;
            this popover only exists when `show088Filters` is true. */}
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
        {/* Paid-online toggle — self-labelled, no field label. */}
        {paidOnlineToggle}
        {/* #292 review A1 — the badge counts an active dueBefore, so the
            popover shows it too: a read-only row (the filter is URL-only, no
            picker by design) with a clear button reusing the chip's handler. */}
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
  ) : null;

  // The filter pattern: one FilterBar row — search (growing), Status, Origin,
  // then Subject and Paid online in the row (portal / flag-off admin) or the
  // "More filters" popover (admin tax view); the count at the end; the
  // applied filters as chips below. On a phone the controls wrap (AURA's own
  // breakpoint), as on Members.
  return (
    <AuraProvider strings={barStrings}>
      <FilterBar
        key={searchResetKey}
        ref={barRef}
        searchGrow
        search={currentQ}
        // Untrimmed on purpose: the FilterBar compares the URL back against
        // what it sent, so a trimmed "Acme " would rewrite the box while the
        // member types. Both pages trim `q` server-side.
        onSearchChange={(v) => pushUrl({ q: v || null })}
        searchLabel={t('searchLabel')}
        searchPlaceholder={t('searchPlaceholder')}
        filters={activeFilters}
        {...(hasAnyFilter ? { onClearAll: clearAll } : {})}
        {...(resultCount !== undefined ? { resultCount } : {})}
      >
        {statusSelect}
        {originSelect}
        {collapseSecondary ? (
          morePopover
        ) : (
          <>
            <FilterSelect
              label={t('filters.subject.label')}
              allLabel={t('filters.allShort')}
              data-testid="invoice-subject-filter"
              value={currentSubject}
              onChange={onSubject}
              options={subjectOptions}
            />
            {paidOnlineToggle}
          </>
        )}
        {/* Paid online is not repeated as a chip in the row, so when it is
            the ONLY filter applied the bar's own "Clear filters" (chips row)
            is absent: offer it here, as Members does. */}
        {hasAnyFilter && activeFilters.length === 0 && (
          <Button variant="ghost" size="sm" icon="x" onClick={clearAll}>
            {t('filters.clearAll')}
          </Button>
        )}
      </FilterBar>
    </AuraProvider>
  );
}
