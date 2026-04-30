/**
 * Queue filters — URL-param-driven multi-select (status), member
 * dropdown, date range, Apply/Reset.
 *
 * Server-rendered form with method=GET so filters are bookmarkable.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { BROADCAST_STATUSES } from '@/modules/broadcasts';

export interface QueueFiltersProps {
  readonly current: {
    readonly status: ReadonlyArray<string>;
    readonly memberId: string | null;
    readonly fromDate: string | null;
    readonly toDate: string | null;
  };
  readonly memberOptions: ReadonlyArray<{
    readonly memberId: string;
    readonly displayName: string;
  }>;
}

export async function QueueFilters({
  current,
  memberOptions,
}: QueueFiltersProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue.filters');
  const tStatus = await getTranslations('admin.broadcasts.queue.status');

  return (
    <form
      method="GET"
      action="/admin/broadcasts"
      className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3"
      aria-label={t('formAriaLabel')}
    >
      <fieldset className="space-y-1">
        <legend className="text-xs uppercase tracking-wide text-foreground">
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
                defaultChecked={current.status.includes(s)}
                className="h-4 w-4 accent-primary"
              />
              <span>{tStatus(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor="filter-member" className="text-xs uppercase tracking-wide">
          {t('memberLabel')}
        </Label>
        <select
          id="filter-member"
          name="memberId"
          defaultValue={current.memberId ?? ''}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">{t('memberAll')}</option>
          {memberOptions.map((m) => (
            <option key={m.memberId} value={m.memberId}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="filter-from" className="text-xs uppercase tracking-wide">
          {t('fromDate')}
        </Label>
        <Input
          id="filter-from"
          type="date"
          name="fromDate"
          defaultValue={current.fromDate ?? ''}
          className="h-9 w-40"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="filter-to" className="text-xs uppercase tracking-wide">
          {t('toDate')}
        </Label>
        <Input
          id="filter-to"
          type="date"
          name="toDate"
          defaultValue={current.toDate ?? ''}
          className="h-9 w-40"
        />
      </div>

      <div className="ml-auto flex gap-2">
        <Link
          href="/admin/broadcasts"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          {t('reset')}
        </Link>
        <Button type="submit" size="sm">
          {t('apply')}
        </Button>
      </div>
    </form>
  );
}
