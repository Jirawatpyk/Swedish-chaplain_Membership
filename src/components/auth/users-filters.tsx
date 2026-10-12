'use client';

/**
 * Users list filters with URL-state sync — mirrors the Members
 * `<DirectoryFilters />` pattern for consistency across admin tables.
 *
 * URL is the source of truth (bookmarkable). Search debounces 300ms
 * before committing. Role + status selects commit immediately.
 *
 * Spec 122 US10a (T1002) — on AURA, in the filter pattern (spec 122,
 * 2 Oct 2026; docs/aura-adoption.md § Filters): the FilterBar's own search
 * (debounced 300 ms, synced from the URL `q`), Role and Status as compact
 * `FilterSelect`s, every applied filter a removable chip that brings the
 * bar's own "Clear filters", and the count of every match at the end of the
 * row. The URL contract is unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AuraProvider, FilterBar, FilterSelect } from '@jirawatpyk/aura-react';
import { byDisplayOrder, ROLES } from '@/modules/auth/domain/role';

/**
 * Every role that can EXIST — derived, never re-typed.
 *
 * This was a hand-written `['admin', 'manager', 'member']`, and it was the
 * fourth copy of the role union on this screen. Neither PR 3 (`super_admin`)
 * nor PR 4 (`marketing`) reached it, so the page could hand out a role it could
 * not then filter for, and "who holds super_admin right now?" — the question
 * this screen exists to answer — was unaskable. `page.tsx` validates `?role=`
 * against all of `ROLES`, so the URL accepted values with no matching option.
 *
 * Filtering is deliberately NOT `ASSIGNABLE_ROLES`: you filter for what exists,
 * which includes roles that are no longer handed out.
 */
const ROLE_VALUES = byDisplayOrder(ROLES);
const STATUS_VALUES = ['active', 'disabled', 'pending'] as const;

type RoleValue = (typeof ROLE_VALUES)[number];
type StatusValue = (typeof STATUS_VALUES)[number];

const isRole = (v: string): v is RoleValue => ROLE_VALUES.some((r) => r === v);
const isStatus = (v: string): v is StatusValue => STATUS_VALUES.some((s) => s === v);

interface UsersFiltersProps {
  /** Every match across pages, shown and announced at the end of the row. */
  readonly resultCount?: number;
}

export function UsersFilters({ resultCount }: UsersFiltersProps = {}) {
  const t = useTranslations('admin.users.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  // Removing a chip unmounts it; focus moves to the always-rendered search
  // input so it never drops to <body> (mirrors `invoice-filters.tsx`).
  const barRef = useRef<HTMLDivElement>(null);
  const focusSearch = () =>
    barRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  // Bumped to remount the FilterBar: its unmount drops a search still waiting
  // on the debounce, and the draft restarts from the URL.
  const [searchResetKey, setSearchResetKey] = useState(0);
  useEffect(() => {
    if (searchResetKey > 0) focusSearch();
  }, [searchResetKey]);

  const currentQ = searchParams.get('q') ?? '';
  // A value with no matching option (a hand-typed URL) shows as "All", as
  // the page ignores it too.
  const rawRole = searchParams.get('role') ?? '';
  const currentRole = isRole(rawRole) ? rawRole : 'all';
  const rawStatus = searchParams.get('status') ?? '';
  const currentStatus = isStatus(rawStatus) ? rawStatus : 'all';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // Reset pagination whenever filters change — stale page number
      // would often land the user past the new last page.
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        // Same-page filter → preserve scroll (canonical rule comment:
        // renewals `urgency-bucket-tabs.tsx` handleChange).
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [searchParams, router, pathname],
  );

  const resetSearch = () => setSearchResetKey((k) => k + 1);

  const chips: { readonly id: string; readonly label: string; readonly clear: () => void }[] = [];
  if (currentQ.trim() !== '') {
    chips.push({
      id: 'q',
      label: t('chipSearch', { q: currentQ.trim() }),
      clear: () => {
        resetSearch();
        pushUrl({ q: null });
      },
    });
  }
  if (currentRole !== 'all') {
    chips.push({
      id: 'role',
      label: t('chip', { label: t('role.label'), value: t(`role.${currentRole}`) }),
      clear: () => pushUrl({ role: null }),
    });
  }
  if (currentStatus !== 'all') {
    chips.push({
      id: 'status',
      label: t('chip', { label: t('status.label'), value: t(`status.${currentStatus}`) }),
      clear: () => pushUrl({ status: null }),
    });
  }
  const activeFilters = chips.map((c) => ({
    id: c.id,
    label: c.label,
    onRemove: () => {
      c.clear();
      if (c.id !== 'q') focusSearch();
    },
  }));

  const clearAll = () => {
    resetSearch();
    pushUrl({ q: null, role: null, status: null });
  };

  // The bar's own "Clear filters" and chip × labels, in this page's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: t('clear'),
      remove: (label: string) => t('removeChip', { label }),
    }),
    [t],
  );

  return (
    <AuraProvider strings={barStrings}>
      <FilterBar
        key={searchResetKey}
        ref={barRef}
        label={t('groupLabel')}
        searchGrow
        search={currentQ}
        // Untrimmed on purpose: the FilterBar compares the URL back against
        // what it sent, so a trimmed "ann " would rewrite the box while the
        // admin types. The page trims `q` server-side.
        onSearchChange={(v) => pushUrl({ q: v || null })}
        searchLabel={t('searchSrLabel')}
        searchPlaceholder={t('searchPlaceholder')}
        filters={activeFilters}
        {...(activeFilters.length > 0 ? { onClearAll: clearAll } : {})}
        {...(resultCount !== undefined ? { resultCount: t('count', { count: resultCount }) } : {})}
      >
        <FilterSelect
          label={t('role.label')}
          value={currentRole}
          onChange={(v) => pushUrl({ role: v === 'all' ? null : v })}
          options={[
            { value: 'all', label: t('role.all') },
            ...ROLE_VALUES.map((role) => ({ value: role, label: t(`role.${role}`) })),
          ]}
        />
        <FilterSelect
          label={t('status.label')}
          value={currentStatus}
          onChange={(v) => pushUrl({ status: v === 'all' ? null : v })}
          options={[
            { value: 'all', label: t('status.all') },
            ...STATUS_VALUES.map((status) => ({ value: status, label: t(`status.${status}`) })),
          ]}
        />
      </FilterBar>
    </AuraProvider>
  );
}
