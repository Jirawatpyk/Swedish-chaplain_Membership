'use client';

/**
 * Users list filters with URL-state sync — mirrors the Members
 * `<DirectoryFilters />` pattern for consistency across admin tables.
 *
 * URL is the source of truth (bookmarkable). Search debounces 300ms
 * before committing. Role + status selects commit immediately.
 */

import { useCallback, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

const DEBOUNCE_MS = 300;

const ROLE_VALUES = ['admin', 'manager', 'member'] as const;
const STATUS_VALUES = ['active', 'disabled', 'pending'] as const;

export function UsersFilters() {
  const t = useTranslations('admin.users.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentRole = searchParams.get('role') ?? 'all';
  const currentStatus = searchParams.get('status') ?? 'all';

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
    Boolean(currentQ) || currentRole !== 'all' || currentStatus !== 'all';
  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (inputRef.current) inputRef.current.value = '';
    pushUrl({ q: null, role: null, status: null });
  };

  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
      role="search"
    >
      <div className="relative flex-1 min-w-0">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          key={currentQ}
          defaultValue={currentQ}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchSrLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <Select
        value={currentRole}
        onValueChange={(v) => pushUrl({ role: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-[140px]" aria-label={t('role.label')}>
          <TranslatedSelectValue
            placeholder={t('role.label')}
            translate={(v) =>
              v === 'all'
                ? t('role.all')
                : t(`role.${v as (typeof ROLE_VALUES)[number]}`)
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('role.all')}</SelectItem>
          {ROLE_VALUES.map((role) => (
            <SelectItem key={role} value={role}>
              {t(`role.${role}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={currentStatus}
        onValueChange={(v) => pushUrl({ status: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-[140px]" aria-label={t('status.label')}>
          <TranslatedSelectValue
            placeholder={t('status.label')}
            translate={(v) =>
              v === 'all'
                ? t('status.all')
                : t(`status.${v as (typeof STATUS_VALUES)[number]}`)
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('status.all')}</SelectItem>
          {STATUS_VALUES.map((status) => (
            <SelectItem key={status} value={status}>
              {t(`status.${status}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" />
          {t('clear')}
        </Button>
      )}
    </div>
  );
}
