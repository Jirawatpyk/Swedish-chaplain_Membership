'use client';

/**
 * T079 (F7.1a US2) — Admin image-source allowlist editor.
 *
 * Surfaces in `/admin/broadcasts/settings`. Default entries
 * (`is_default=TRUE`) render with disabled Remove buttons so the
 * platform invariant (chamber asset domain + Resend CDN always
 * allowlisted) is enforced in UI as well as DB.
 *
 * a11y:
 *   - semantic <table> with caption + <th scope="col">
 *   - <Label htmlFor> on the add-hostname input
 *   - aria-live="polite" on the table body so screen readers
 *     announce the row mutation
 *   - aria-label on per-row Remove button (i18n-keyed)
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export interface AllowlistRow {
  readonly hostname: string;
  readonly isDefault: boolean;
}

interface Props {
  readonly initial: readonly AllowlistRow[];
}

export function AdminImageAllowlistEditor({ initial }: Props): React.ReactElement {
  const t = useTranslations('admin.broadcasts.settings.allowlist');
  const [rows, setRows] = useState<readonly AllowlistRow[]>(initial);
  const [hostname, setHostname] = useState('');
  const [isPending, startTransition] = useTransition();

  const submit = (action: 'add' | 'remove', h: string): void => {
    startTransition(async () => {
      const res = await fetch('/api/admin/broadcasts/settings/allowlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, hostname: h }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        const code = body.error ?? 'unknown';
        toast.error(t(`errors.${code}`));
        return;
      }
      const data = (await res.json()) as { allowlist: AllowlistRow[] };
      setRows(data.allowlist);
      toast.success(t(action === 'add' ? 'addedToast' : 'removedToast'));
      if (action === 'add') setHostname('');
    });
  };

  return (
    <section aria-labelledby="allowlist-heading" className="space-y-6">
      <header className="space-y-2">
        <h2 id="allowlist-heading" className="text-h2">
          {t('heading')}
        </h2>
        <p className="text-body text-muted-foreground">{t('description')}</p>
      </header>

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (hostname.trim()) submit('add', hostname.trim());
        }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="allowlist-hostname">{t('hostnameLabel')}</Label>
          <Input
            id="allowlist-hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder={t('hostnamePlaceholder')}
            aria-describedby="allowlist-hostname-help"
            disabled={isPending}
            autoComplete="off"
          />
          <p id="allowlist-hostname-help" className="text-caption">
            {t('hostnameHelp')}
          </p>
        </div>
        <Button type="submit" disabled={isPending || !hostname.trim()}>
          {t('addButton')}
        </Button>
      </form>

      <table className="w-full border-collapse">
        <caption className="sr-only">{t('tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left py-2">
              {t('colHostname')}
            </th>
            <th scope="col" className="text-left py-2">
              {t('colSource')}
            </th>
            <th scope="col" className="sr-only">
              {t('colActions')}
            </th>
          </tr>
        </thead>
        <tbody aria-live="polite">
          {rows.map((row) => (
            <tr key={row.hostname} className="border-t">
              <td className="py-2">{row.hostname}</td>
              <td className="py-2">
                <span className="text-caption">
                  {row.isDefault ? t('defaultBadge') : t('customBadge')}
                </span>
              </td>
              <td className="py-2 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={row.isDefault || isPending}
                  aria-label={t('removeAria', { hostname: row.hostname })}
                  onClick={() => submit('remove', row.hostname)}
                >
                  {t('removeButton')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
