'use client';

/**
 * Invoices directory filters with URL-state sync.
 *
 * Parity with `src/components/members/directory-filters.tsx`: URL is the
 * source of truth (bookmarkable) + debounced search + status dropdown +
 * clear-all button. Pagination state (`cursor`, `page`) resets on every
 * filter change.
 */

import { useCallback, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon, CheckIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
}

export function InvoiceFilters({
  statusOptions = STATUS_VALUES,
  showPaidOnlineChip = true,
}: InvoiceFiltersProps = {}) {
  const t = useTranslations('admin.invoices.list');
  const tStatus = useTranslations('admin.invoices.list.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tReconciliation = useTranslations('admin.paymentReconciliation.filterChip');
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
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  const onSearchChange = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    currentQ !== '' ||
    effectiveStatus !== 'all' ||
    currentSubject !== 'all' ||
    paidOnlineActive;

  const togglePaidOnline = () => {
    pushUrl({ paidOnline: paidOnlineActive ? null : '1' });
  };

  return (
    <FilterBar>
      {/* L5: was min-w-[16rem]=256px — overflowed 320px mobile viewports
          after padding + sibling Status dropdown. On mobile (<640px) the
          search input owns the full row (FilterBar rule); on sm+ it
          flex-grows alongside the status dropdown. */}
      <div className="relative min-w-0 sm:flex-1">
        <SearchIcon
          aria-hidden="true"
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          defaultValue={currentQ}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          className="pl-9"
        />
      </div>
      <Select
        value={effectiveStatus}
        onValueChange={(v) =>
          pushUrl({ status: v && v !== 'all' ? v : null })
        }
      >
        <SelectTrigger
          className="sm:w-[12rem]"
          aria-label={t('columns.status')}
        >
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
      {/* 054-event-fee-invoices — subject filter (All types / Membership /
          Event). Mirrors the status dropdown: URL `?subject=` param is the
          source of truth; resetting to "all" clears the param. */}
      <Select
        value={currentSubject}
        onValueChange={(v) =>
          pushUrl({ subject: v && v !== 'all' ? v : null })
        }
      >
        <SelectTrigger
          className="sm:w-[12rem]"
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
      {/* R3-fix N7 (2026-04-26): the staff admin layout already
          mounts `<TooltipProvider>` at the shell level — a local
          provider here would remount on every searchParam change
          (router.replace fires on every filter edit). The shell
          provider is sufficient.
          R3-fix N6 (2026-04-26, Base UI Tooltip touch behaviour):
          Base UI `Tooltip` opens on hover/focus only (per Tooltip
          design philosophy — tooltips are supplementary, not
          primary info). Sighted touch users do NOT see the popup
          on tap (taps toggle the filter, the primary action). The
          `aria-label` on the trigger carries the scope information
          for SR + voice-control users; the visible chip label
          ("Paid online") is sufficient for sighted touch users
          since the filter result speaks for itself once toggled.
          Accepted Base UI limitation. */}
      {showPaidOnlineChip && (
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
      )}
      {hasAnyFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            pushUrl({ q: null, status: null, paidOnline: null, subject: null })
          }
          aria-label={t('filters.clearAll')}
        >
          <XIcon className="size-4" />
          {t('filters.clearAll')}
        </Button>
      )}
    </FilterBar>
  );
}
