'use client';

/**
 * Queue filters — URL-state-driven client component (F7 UX hardening).
 *
 * Replaces the prior server-rendered `<form method="GET">` whose
 * `defaultChecked` / `defaultValue` attributes never re-synced after
 * client-side navigation (D1). Mirrors the F3 `directory-filters.tsx`
 * pattern: URL is the source of truth, controlled inputs derive their
 * state from `useSearchParams()`, and each change triggers
 * `router.replace()` in a `useTransition` so the UI stays responsive.
 *
 * Default-view semantics preserved (FR-010): with no URL params, the
 * server defaults status filter to `['submitted']`. The `status_all=1`
 * sentinel param distinguishes an EXPLICIT "show all statuses" choice
 * (user unchecked everything) from a pristine first visit.
 *
 * Findings closed by this file: D1, D2, D3 (filter buttons), A1, A2,
 * A3, H3 (see specs/010-email-broadcast review report).
 */
import { useCallback, useMemo, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
// Import directly from the Domain value-object file (NOT the module
// barrel) — the barrel re-exports infrastructure adapters that pull in
// server-only Next.js APIs (`revalidateTag` via the F5 payments repo
// chain). Client components must stay free of those imports.
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const DEBOUNCE_MS = 300;

// Default-view filter — mirrors `page.tsx` `statusRaw` resolution so
// the visual checkbox state matches what the server actually filters
// by on a fresh visit (URL has no status params yet). Module-scope
// constant so memo deps stay stable across renders.
const DEFAULT_STATUS: ReadonlyArray<BroadcastStatus> = ['submitted'];

export interface QueueFiltersProps {
  readonly memberOptions: ReadonlyArray<{
    readonly memberId: string;
    readonly displayName: string;
  }>;
}

export function QueueFilters({
  memberOptions,
}: QueueFiltersProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.queue.filters');
  const tStatus = useTranslations('admin.broadcasts.queue.status');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const urlStatus = searchParams.getAll('status') as ReadonlyArray<BroadcastStatus>;
  const currentStatusAll = searchParams.get('status_all') === '1';

  // VISUAL set — what the user sees ticked. When `status_all` sentinel
  // is active, every checkbox stays UNCHECKED so the user has an honest
  // visual of "no chip selected → showing everything". Otherwise the
  // explicit URL > default fallback chain drives visual state.
  //
  // Separated from the FILTER set below so users can fully clear the
  // chip strip without the UI snapping back to "all 8 ticked" — which
  // earlier iterations did and was confusing (2026-05-18 user report).
  const visualStatus: ReadonlyArray<BroadcastStatus> = currentStatusAll
    ? []
    : urlStatus.length > 0
      ? urlStatus
      : DEFAULT_STATUS;

  // FILTER set — what toggle arithmetic builds on (so clicking adds /
  // removes against the actual effective filter, not a stale URL view).
  // In sentinel mode it's []; click-to-check then promotes to explicit.
  // Memoised so `toggleStatus` and `hasAnyFilter` keep stable
  // dependency identities (react-hooks/exhaustive-deps).
  const currentStatus = useMemo<ReadonlyArray<BroadcastStatus>>(
    () =>
      currentStatusAll
        ? []
        : urlStatus.length > 0
          ? urlStatus
          : DEFAULT_STATUS,
    [currentStatusAll, urlStatus],
  );
  const currentMemberId = searchParams.get('memberId') ?? '';
  const currentFromDate = searchParams.get('fromDate') ?? '';
  const currentToDate = searchParams.get('toDate') ?? '';

  /**
   * Build a fresh URLSearchParams from a patch object, preserving any
   * unrelated params (e.g. `cursor`) and clearing pagination state on
   * filter change.
   */
  const pushUrl = useCallback(
    (patch: {
      status?: ReadonlyArray<BroadcastStatus> | null;
      statusAll?: boolean | null;
      memberId?: string | null;
      fromDate?: string | null;
      toDate?: string | null;
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      if ('status' in patch) {
        params.delete('status');
        if (patch.status && patch.status.length > 0) {
          for (const s of patch.status) params.append('status', s);
        }
      }
      if ('statusAll' in patch) {
        if (patch.statusAll) params.set('status_all', '1');
        else params.delete('status_all');
      }
      if ('memberId' in patch) {
        if (patch.memberId) params.set('memberId', patch.memberId);
        else params.delete('memberId');
      }
      if ('fromDate' in patch) {
        if (patch.fromDate) params.set('fromDate', patch.fromDate);
        else params.delete('fromDate');
      }
      if ('toDate' in patch) {
        if (patch.toDate) params.set('toDate', patch.toDate);
        else params.delete('toDate');
      }
      // Filter change always resets pagination cursor.
      params.delete('cursor');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  /**
   * Toggle a status checkbox. When the user UNCHECKS the last
   * remaining status, write the `status_all=1` sentinel so the server
   * doesn't fall back to the default `['submitted']` filter — this is
   * the user's explicit "show every status" intent (D1 root cause).
   */
  const toggleStatus = useCallback(
    (status: BroadcastStatus, checked: boolean) => {
      const next = checked
        ? Array.from(new Set([...currentStatus, status]))
        : currentStatus.filter((s) => s !== status);
      if (next.length === 0) {
        pushUrl({ status: null, statusAll: true });
      } else {
        pushUrl({ status: next, statusAll: null });
      }
    },
    [currentStatus, pushUrl],
  );

  const onDateChange = useCallback(
    (key: 'fromDate' | 'toDate', value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        pushUrl({ [key]: value || null } as Parameters<typeof pushUrl>[0]);
      }, DEBOUNCE_MS);
    },
    [pushUrl],
  );

  // "Has any user-applied filter" — true when the URL has any explicit
  // query param. The default-status fallback above does NOT count
  // (no URL param yet → no Clear button to surface).
  const hasAnyFilter = useMemo(
    () =>
      urlStatus.length > 0 ||
      currentStatusAll ||
      Boolean(currentMemberId) ||
      Boolean(currentFromDate) ||
      Boolean(currentToDate),
    [
      urlStatus.length,
      currentStatusAll,
      currentMemberId,
      currentFromDate,
      currentToDate,
    ],
  );

  // "Reset" returns the queue to its DEFAULT view (submitted-only) —
  // the admin's primary daily task per FR-010 + GitHub/Linear/Notion
  // convention. Drops every URL param so the server applies the
  // default-submitted fallback. The button label is intentionally
  // "Reset" (not "Clear") so behaviour matches expectation. Users who
  // explicitly want "show every status" do that by unchecking the
  // submitted chip; the `status_all=1` sentinel surfaces from there
  // automatically.
  const clearAll = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    startTransition(() => {
      router.replace(pathname);
    });
  }, [router, pathname]);

  // Visual check uses the separate `visualStatus` set so sentinel-mode
  // (`status_all=1`) renders ALL chips unchecked — matching the user's
  // mental model of "no filter, show everything".
  const isStatusChecked = (s: BroadcastStatus): boolean =>
    visualStatus.includes(s);

  return (
    <div
      role="search"
      aria-label={t('formAriaLabel')}
      className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3"
    >
      <fieldset className="space-y-1">
        <legend className="mb-[var(--field-label-gap)] text-[length:var(--font-size-body)] font-medium">
          {t('statusLabel')}
        </legend>
        <div className="flex flex-wrap gap-2">
          {BROADCAST_STATUSES.map((s) => (
            <label
              key={s}
              className="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-full border bg-background px-3 py-2 text-xs hover:bg-muted/40 has-[:checked]:bg-primary/10 has-[:checked]:border-primary/40"
            >
              <input
                type="checkbox"
                name="status"
                value={s}
                checked={isStatusChecked(s)}
                onChange={(e) => toggleStatus(s, e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span>{tStatus(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor="filter-member">{t('memberLabel')}</Label>
        <Select
          value={currentMemberId || 'all'}
          onValueChange={(v) => pushUrl({ memberId: v === 'all' ? null : v })}
        >
          <SelectTrigger
            id="filter-member"
            className="w-56"
            aria-label={t('memberLabel')}
          >
            <TranslatedSelectValue
              placeholder={t('memberAll')}
              translate={(v) => {
                if (!v || v === 'all') return t('memberAll');
                return (
                  memberOptions.find((m) => m.memberId === v)?.displayName ?? v
                );
              }}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('memberAll')}</SelectItem>
            {memberOptions.map((m) => (
              <SelectItem key={m.memberId} value={m.memberId}>
                {m.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="filter-from">{t('fromDate')}</Label>
        <Input
          id="filter-from"
          type="date"
          name="fromDate"
          // `key` forces re-mount when URL value changes, ensuring the
          // native input reflects URL-driven state after navigation.
          key={`from-${currentFromDate}`}
          defaultValue={currentFromDate}
          onChange={(e) => onDateChange('fromDate', e.target.value)}
          className="w-40"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="filter-to">{t('toDate')}</Label>
        <Input
          id="filter-to"
          type="date"
          name="toDate"
          key={`to-${currentToDate}`}
          defaultValue={currentToDate}
          onChange={(e) => onDateChange('toDate', e.target.value)}
          className="w-40"
        />
      </div>

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="ml-auto whitespace-nowrap"
        >
          <XIcon className="size-4" aria-hidden="true" />
          {t('reset')}
        </Button>
      )}
    </div>
  );
}
