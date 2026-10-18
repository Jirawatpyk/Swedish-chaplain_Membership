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
 *   - a confirmation on Remove (PR-review fix UX-H1 —
 *     destructive privileged-surface mutation requires confirm per
 *     docs/ux-standards.md). Add operation stays single-step because
 *     it's non-destructive.
 *   - T155 finding U4 — `finalFocus` on that confirm. A successful remove
 *     replaces `rows` with the server's new allowlist, so the row — and the
 *     Remove button the dialog would restore focus to — is gone; focus dropped
 *     to `<body>`, and removing several hostnames meant re-Tabbing from the
 *     top of the page each time. The success close lands on the table, which
 *     survives; Cancel / ESC keep the dialog's default. WCAG 2.1 AA SC 2.4.3.
 *   - Spec 122 US12a: AURA field, button and table; the confirm is the
 *     shell `ConfirmationDialog`, opened for the row being removed.
 */
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Table, TBody, Td, Th, THead, Tr, TextField } from '@jirawatpyk/aura-react';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { FIELD_BOX_OFFSET_SM } from '@/components/shell/field-box-offset';
import { toast } from '@/lib/toast';
import { useSurvivingTargetFinalFocus } from '@/components/broadcast/unmounting-trigger-final-focus';

/** The list container — the element that outlives a removed row. */
const ALLOWLIST_TABLE_ID = 'broadcast-image-allowlist-table';

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
  // The row whose Remove opened the confirm; null while it is closed.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  // U4 — raised on the CONFIRM click, not on the 200. The confirm closes as
  // soon as its handler returns, long before the fetch settles, and reads
  // `finalFocus` on that close: deciding on the response would always read
  // `false`. The confirm click is the close that takes the trigger with it,
  // so that is where the flag belongs. Reset when the dialog reopens,
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
    <div className="flex flex-col gap-[var(--aura-space-6)]">
      {/* Field + Add on one row from 640px. The button drops by the field
          label's line (`FIELD_BOX_OFFSET_SM`), so it sits level with the
          input box and the hint or error below never moves it. */}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          // Hostnames are case-insensitive and the allowlist stores them
          // lower-case (HOSTNAME_REGEX has no A-Z), so "CDN.Example.com" is
          // the same host, not a format error.
          const normalized = hostname.trim().toLowerCase();
          if (normalized) submit('add', normalized);
        }}
      >
        <TextField
          id="allowlist-hostname"
          className="min-w-0 flex-1"
          label={t('hostnameLabel')}
          hint={t('hostnameHelp')}
          error={hostnameError ?? undefined}
          value={hostname}
          onChange={(e) => {
            setHostname(e.target.value);
            setHostnameError(null);
          }}
          placeholder={t('hostnamePlaceholder')}
          disabled={isPending}
          autoComplete="off"
          touchHeight
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!hostname.trim()}
          loading={isPending}
          aria-busy={isPending}
          touchHeight
          className={`shrink-0 ${FIELD_BOX_OFFSET_SM}`}
        >
          {t('addButton')}
        </Button>
      </form>

      {/* U4 — `tabIndex={-1}` makes the list container focusable (not
          tabbable, so it adds no tab stop): it is where the Remove confirm
          lands focus once the row it was opened from is gone. */}
      <Table
        id={ALLOWLIST_TABLE_ID}
        tabIndex={-1}
        caption={t('tableCaption')}
        captionHidden
        bordered={false}
        align="middle"
        className="focus-visible:outline-none"
      >
        <THead>
          <Tr>
            <Th scope="col">{t('colHostname')}</Th>
            {/* PR-review fix 2026-05-20 UX-M1 — hide Source column at
                <sm (320-639px). The badge moves inline next to the
                hostname via the `(default)` parenthetical pattern below. */}
            <Th scope="col" className="max-sm:hidden">
              {t('colSource')}
            </Th>
            <Th scope="col">
              <span className="sr-only">{t('colActions')}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.hostname}>
              {/* UX-M1 — long hostnames wrap on narrow viewports, and the
                  inline `(default)` replaces the hidden Source column. */}
              <Td mono className="[overflow-wrap:anywhere]">
                {row.hostname}
                {row.isDefault ? (
                  <span className="ml-1 aura-text-caption text-[var(--aura-fg-secondary)] sm:hidden">
                    {t('defaultBadgeInline')}
                  </span>
                ) : null}
              </Td>
              <Td className="max-sm:hidden">
                {row.isDefault ? t('defaultBadge') : t('customBadge')}
              </Td>
              <Td align="end">
                <Button
                  variant="ghost"
                  touchHeight
                  disabled={row.isDefault || isPending}
                  aria-label={t('removeAria', { hostname: row.hostname })}
                  onClick={() => {
                    closedViaSuccessRef.current = false;
                    setPendingRemove(row.hostname);
                  }}
                >
                  {t('removeButton')}
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {/* PR-review fix 2026-05-20 UX-H1 — the destructive Remove is
          confirmed; Add stays single-step (non-destructive). */}
      <ConfirmationDialog
        open={pendingRemove !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(null);
        }}
        title={t('removeConfirm.title', { hostname: pendingRemove ?? '' })}
        description={t('removeConfirm.body')}
        cancelLabel={t('removeConfirm.cancel')}
        confirmLabel={t('removeConfirm.confirm')}
        destructive
        // PR-review fix 2026-05-21 R4-M1 — no second submit while one runs.
        confirmDisabled={isPending}
        finalFocus={removeFinalFocus}
        onConfirm={() => {
          if (pendingRemove === null) return;
          // The confirm closes as soon as this returns and reads
          // finalFocus then — see the ref's note.
          closedViaSuccessRef.current = true;
          submit('remove', pendingRemove);
        }}
      />

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
