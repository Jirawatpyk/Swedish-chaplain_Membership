'use client';

/**
 * T079 (F7.1a US2) — Admin image-source allowlist editor.
 *
 * Surfaces in `/admin/settings/broadcasts`. Default entries
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
 *   - T155 finding U4 — `finalFocus` on that confirm. A successful remove
 *     replaces `rows` with the server's new allowlist, so the row — and the
 *     Remove button Base UI would restore focus to — is gone; focus dropped
 *     to `<body>`, and removing several hostnames meant re-Tabbing from the
 *     top of the page each time. The success close lands on the table, which
 *     survives; Cancel / ESC keep Base UI's default. WCAG 2.1 AA SC 2.4.3.
 */
import { useRef, useState, useTransition } from 'react';
import { Loader2Icon } from 'lucide-react';
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
import { toast } from '@/lib/toast';
import { useSurvivingTargetFinalFocus } from '@/components/broadcast/unmounting-trigger-final-focus';

/** The list container — the element that outlives a removed row. */
const ALLOWLIST_TABLE_ID = 'broadcast-image-allowlist-table';
const HOSTNAME_HELP_ID = 'allowlist-hostname-help';
const HOSTNAME_ERROR_ID = 'allowlist-hostname-error';

/**
 * The route answers in TWO shapes: use-case refusals are `{ error: '<kind>' }`,
 * while `errorResponse` (400 `invalid_body` from the zod parse, 500
 * `internal_error`) sends `{ error: { code, fieldErrors?, … } }`. Reading the
 * object as a string built `errors.[object Object]`, so every hostname format
 * refusal toasted "Unknown error.".
 */
type AllowlistErrorBody = {
  readonly error?:
    | string
    | {
        readonly code?: string;
        readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
      };
};

function readAllowlistError(body: AllowlistErrorBody): {
  readonly code: string;
  readonly hostnameInvalid: boolean;
} {
  const { error } = body;
  if (typeof error === 'string') {
    return { code: error, hostnameInvalid: error === 'invalid_hostname' };
  }
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  const hostnameInvalid =
    code === 'invalid_hostname' ||
    (code === 'invalid_body' && (error?.fieldErrors?.hostname?.length ?? 0) > 0);
  return { code, hostnameInvalid };
}

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
  const [announcement, setAnnouncement] = useState<string>('');
  // A format refusal belongs ON the field (WCAG 3.3.1), not only in a toast
  // that disappears; cleared as soon as the value is edited.
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  // U4 — raised on the CONFIRM click, not on the 200. `AlertDialogAction`
  // closes the dialog itself, so Base UI reads `finalFocus` synchronously with
  // that click, long before the fetch settles: deciding on the response would
  // always read `false`. The confirm click is the close that takes the trigger
  // with it, so that is where the flag belongs. Reset when the dialog reopens,
  // because this component (unlike the row-scoped dialogs) survives.
  const closedViaSuccessRef = useRef<boolean>(false);
  const removeFinalFocus = useSurvivingTargetFinalFocus(
    ALLOWLIST_TABLE_ID,
    closedViaSuccessRef,
  );

  const submit = (action: 'add' | 'remove', h: string): void => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/broadcasts/settings/allowlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, hostname: h }),
        });
        if (!res.ok) {
          const body = (await res
            .json()
            .catch(() => ({}))) as AllowlistErrorBody;
          const { code, hostnameInvalid } = readAllowlistError(body);
          if (action === 'add' && hostnameInvalid) {
            const message = t('errors.invalid_hostname');
            setHostnameError(message);
            toast.error(message);
            return;
          }
          // T155 finding U8 — this site had no fallback at ALL: next-intl
          // returns the key PATH for a missing key rather than throwing, so
          // an unmapped code toasted
          // `admin.broadcasts.settings.allowlist.errors.<code>` verbatim.
          const key = `errors.${code}` as Parameters<typeof t>[0];
          toast.error(t.has(key) ? t(key) : t('errors.unknown'));
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
        // Pass Error object directly so DevTools preserves the stack
        // (String(err) would reduce to "Error: message" and drop it).
        console.error(
          { err, action, hostname: h },
          'broadcasts.allowlist.fetch_failed',
        );
        toast.error(t('errors.unknown'));
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Label / [Input + Button row sm:items-stretch] / Help text — stretch keeps button height matched to input. */}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          // Hostnames are case-insensitive and the allowlist stores them
          // lower-case (HOSTNAME_REGEX has no A-Z), so "CDN.Example.com" is
          // the same host, not a format error.
          const normalized = hostname.trim().toLowerCase();
          if (normalized) submit('add', normalized);
        }}
      >
        <Label htmlFor="allowlist-hostname">{t('hostnameLabel')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <Input
            id="allowlist-hostname"
            value={hostname}
            onChange={(e) => {
              setHostname(e.target.value);
              setHostnameError(null);
            }}
            placeholder={t('hostnamePlaceholder')}
            aria-invalid={hostnameError ? true : undefined}
            aria-describedby={
              hostnameError
                ? `${HOSTNAME_ERROR_ID} ${HOSTNAME_HELP_ID}`
                : HOSTNAME_HELP_ID
            }
            disabled={isPending}
            autoComplete="off"
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={isPending || !hostname.trim()}
            aria-busy={isPending}
            className="shrink-0"
          >
            {isPending && (
              <Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" aria-hidden />
            )}
            {t('addButton')}
          </Button>
        </div>
        {hostnameError ? (
          <p id={HOSTNAME_ERROR_ID} className="text-caption text-destructive">
            {hostnameError}
          </p>
        ) : null}
        <p id={HOSTNAME_HELP_ID} className="text-caption">
          {t('hostnameHelp')}
        </p>
      </form>

      {/* U4 — `tabIndex={-1}` makes the list container focusable (not
          tabbable, so it adds no tab stop): it is where the Remove confirm
          lands focus once the row it was opened from is gone. */}
      <table
        id={ALLOWLIST_TABLE_ID}
        tabIndex={-1}
        className="w-full border-collapse focus-visible:outline-none"
      >
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
                  <AlertDialog
                    onOpenChange={(next: boolean) => {
                      if (next) closedViaSuccessRef.current = false;
                    }}
                  >
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
                    <AlertDialogContent finalFocus={removeFinalFocus}>
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
                          onClick={() => {
                            // Base UI closes on this click and reads
                            // finalFocus synchronously — see the ref's note.
                            closedViaSuccessRef.current = true;
                            submit('remove', row.hostname);
                          }}
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

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
