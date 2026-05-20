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
 *   - dedicated <div role="status" aria-live="polite"> outside the
 *     table for row-mutation announcements (PR-review fix UX-H2 —
 *     aria-live on <tbody> is not conformant; ATs ignore on
 *     structural table elements)
 *   - aria-label on per-row Remove button (i18n-keyed)
 *   - AlertDialog confirmation on Remove (PR-review fix UX-H1 —
 *     destructive privileged-surface mutation requires confirm per
 *     docs/ux-standards.md). Add operation stays single-step because
 *     it's non-destructive.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
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
  // PR-review fix 2026-05-20 UX-H2 — dedicated live-region replaces
  // aria-live on <tbody> (non-conformant). Updated AFTER each
  // successful mutation so SRs announce the change.
  const [announcement, setAnnouncement] = useState<string>('');

  const submit = (action: 'add' | 'remove', h: string): void => {
    startTransition(async () => {
      try {
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
        // PR-review fix 2026-05-20 UX-M4 — append 60s propagation
        // microcopy via toast description so admin understands active
        // compose sessions may use stale allowlist briefly.
        toast.success(
          t(action === 'add' ? 'addedToast' : 'removedToast'),
          { description: t('propagationFootnote') },
        );
        // Live-region announce — SR users hear the mutation result.
        setAnnouncement(
          t(action === 'add' ? 'addedAnnouncement' : 'removedAnnouncement', {
            hostname: h,
          }),
        );
        if (action === 'add') setHostname('');
      } catch (err) {
        // PR-review fix 2026-05-20 SF-M2 — log network failures so
        // CSP/CORS/offline are distinguishable in browser console.
         
        console.error(
          { err: String(err), action, hostname: h },
          'broadcasts.allowlist.fetch_failed',
        );
        toast.error(t('errors.unknown'));
      }
    });
  };

  return (
    <div className="space-y-6">
      {/*
       * 2026-05-21 UX bug fix — the heading/description used to live
       * here inside the editor (when the page didn't wrap in Card).
       * Now CardHeader on the page renders the title; the editor
       * itself is body-only. Removes the duplicated h2 and the
       * "raw form on background" feel.
       *
       * Form layout: Label + Input + Button on a single visual row at
       * sm+, with the help-text below the WHOLE row (not inside the
       * input wrapper). The previous layout had the help text inside
       * the flex-1 input wrapper, which pushed the wrapper's height +
       * dragged the `sm:items-end`-aligned Button down to the bottom
       * of the wrapper (visually below the input). Restructure so:
       *
       *     [ Label                          ]
       *     [ Input ............. ] [ Button ]
       *     [ Help text                       ]
       *
       * Input row uses flex-row at sm+ with items-stretch so input
       * height + button height match. Button shrinks to natural width.
       */}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (hostname.trim()) submit('add', hostname.trim());
        }}
      >
        <Label htmlFor="allowlist-hostname">{t('hostnameLabel')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <Input
            id="allowlist-hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder={t('hostnamePlaceholder')}
            aria-describedby="allowlist-hostname-help"
            disabled={isPending}
            autoComplete="off"
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={isPending || !hostname.trim()}
            className="shrink-0"
          >
            {t('addButton')}
          </Button>
        </div>
        <p id="allowlist-hostname-help" className="text-caption">
          {t('hostnameHelp')}
        </p>
      </form>

      <table className="w-full border-collapse">
        <caption className="sr-only">{t('tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left py-2">
              {t('colHostname')}
            </th>
            {/* PR-review fix 2026-05-20 UX-M1 — hide Source column at
                <sm (320-639px). The badge moves inline next to the
                hostname via the `(default)` parenthetical pattern below. */}
            <th scope="col" className="hidden sm:table-cell text-left py-2">
              {t('colSource')}
            </th>
            <th scope="col" className="sr-only">
              {t('colActions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.hostname} className="border-t">
              {/* UX-M1 — break-all so long hostnames wrap on narrow viewports
                  + inline `(default)` parenthetical visible only at <sm
                  (replaces the hidden Source column at mobile width). */}
              <td className="py-2 break-all">
                {row.hostname}
                {row.isDefault ? (
                  <span className="sm:hidden text-caption text-muted-foreground ml-1">
                    {t('defaultBadgeInline')}
                  </span>
                ) : null}
              </td>
              <td className="hidden sm:table-cell py-2">
                <span className="text-caption">
                  {row.isDefault ? t('defaultBadge') : t('customBadge')}
                </span>
              </td>
              <td className="py-2 text-right">
                {row.isDefault ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    aria-label={t('removeAria', { hostname: row.hostname })}
                  >
                    {t('removeButton')}
                  </Button>
                ) : (
                  // PR-review fix 2026-05-20 UX-H1 — wrap destructive
                  // Remove action in AlertDialog confirm. Add stays
                  // single-step (non-destructive).
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isPending}
                          aria-label={t('removeAria', {
                            hostname: row.hostname,
                          })}
                        >
                          {t('removeButton')}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t('removeConfirm.title', {
                            hostname: row.hostname,
                          })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('removeConfirm.body')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t('removeConfirm.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          // PR-review fix 2026-05-21 R4-M1 — block
                          // double-click inside open dialog. Trigger's
                          // own disabled={isPending} only blocks
                          // RE-OPENING; without this prop a quick
                          // second click on the confirm fires a
                          // concurrent submit → second call hits a
                          // hostname already removed → unexpected
                          // error toast.
                          disabled={isPending}
                          onClick={() => submit('remove', row.hostname)}
                        >
                          {t('removeConfirm.confirm')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* PR-review fix 2026-05-20 UX-H2 — dedicated live-region for
          row-mutation announcements. Persistent in DOM so SR
          announcement fires on text change, not element mount. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
