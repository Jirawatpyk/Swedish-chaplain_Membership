'use client';

/**
 * F114 US6 (FR-031, FR-032, FR-034, FR-036) — the per-tenant "require
 * approval for member changes" switch on `/admin/settings/member-changes`.
 *
 * Behaviour:
 *   - the control is AURA's `Switch` (spec 122 US10c), named through
 *     `aria-labelledby` → its own visible label and described by the text
 *     under it; the label's `for` points at the switch, so a click on the
 *     label text toggles it (UX M1).
 *     No optimistic
 *     flip — the switch shows the server truth, so `aria-checked` never lies
 *     on a refusal; the visible state line is plain text, not a live region
 *     (the success toast is the one announcement — UX M3);
 *   - a pending-count note is rendered whenever requests are waiting, in BOTH
 *     setting states (the OFF copy is FR-032's "still decidable"), with the
 *     count as an underlined link to the queue (UX H2);
 *   - switching OFF while requests are waiting opens the platform
 *     confirmation dialog (plain tier — nothing is destroyed: pending
 *     requests stay decidable, FR-032) whose body states the consequence and
 *     whose confirm button is the short count-bearing form ("Switch off (3)"
 *     — the sentence overflowed the 320 px footer, UX H1); Cancel sends
 *     nothing;
 *   - `PATCH /api/admin/settings/member-changes { approvalEnabled }`, same
 *     origin; while in flight the switch row is `aria-busy` + dimmed, never
 *     `disabled` (a disabled control drops focus to `<body>`);
 *   - success → state line, and a toast ONLY when the value actually
 *     transitioned (`changedAt` non-null; R-L5 — an unchanged no-op writes no
 *     audit row, so announcing "switched on" would claim a change the trail
 *     does not have); a 503 read-only refusal → the setting-specific
 *     read-only copy inline (`role="alert"`, UX M5), any other failure → the
 *     generic inline alert; state unchanged either way (ux-standards § 4.1);
 *   - a 200 whose body carries no BOOLEAN `approvalEnabled` is one of those
 *     failures, not a `false` (PR-3 review B7): the card shows the stored
 *     value, so inventing one it never read would announce "Approval is off"
 *     about a tenant the server had just switched on.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
import { Alert, Switch } from '@jirawatpyk/aura-react';

/**
 * The 200 body this card can act on. Read off an `unknown` (C2): `res.json()`
 * answers whatever came back, so the two fields are NARROWED here rather than
 * asserted with a cast that would make a missing field look like a present
 * one.
 */
function readApproval(body: unknown): { readonly approvalEnabled: boolean; readonly changed: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { approvalEnabled?: unknown }).approvalEnabled;
  if (typeof value !== 'boolean') return null;
  const changedAt = (body as { changedAt?: unknown }).changedAt;
  return { approvalEnabled: value, changed: changedAt !== null && changedAt !== undefined };
}

export function ApprovalSwitch({
  initialEnabled,
  pendingCount,
}: {
  readonly initialEnabled: boolean;
  /** Pending requests at render — the switch-off confirmation names it. */
  readonly pendingCount: number;
}): React.ReactElement {
  const t = useTranslations('admin.settings.memberChanges');
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function send(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings/member-changes', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalEnabled: next }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(isReadOnlyRefusal(res.status, body) ? t('errors.readOnly') : t('errors.generic'));
        return;
      }
      // The server's value, not our request — an unchanged no-op still
      // answers with the stored state. A 200 the card cannot READ (no
      // boolean `approvalEnabled`: a truncated body, a reshaped envelope, a
      // proxy's HTML page) is a FAILURE, not a `false` (PR-3 review B7):
      // coercing it announced "Approval is off" about a tenant the server had
      // just switched on, and the state line then disagreed with both the
      // stored value and the audit row.
      const answer = readApproval(body);
      if (answer === null) {
        setError(t('errors.generic'));
        return;
      }
      setEnabled(answer.approvalEnabled);
      // `changedAt: null` = the stored value already matched: the upsert ran
      // (and stamped `updated_at`) but nothing TRANSITIONED, so there is no
      // audit row — and "Approval switched on" would claim a change the trail
      // does not record (UX/reliability R-L5). The state line above already
      // shows the stored value, so the no-op needs no announcement.
      if (answer.changed) {
        toast.success(answer.approvalEnabled ? t('toast.on') : t('toast.off'));
      }
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-[var(--aura-space-4)]">
      {/* Spec 122 US10c: AURA's switch carries its own visible label and
          description (aria-labelledby / aria-describedby). It shows the
          server's value only — `checked` follows `enabled`, never the click.
          While a request is in flight the row is `aria-busy` and dimmed, but
          the switch is never `disabled`, so focus stays on it. */}
      <div aria-busy={busy || undefined} className="aria-busy:opacity-70">
        <Switch
          checked={enabled}
          label={t('switchLabel')}
          description={t('description')}
          onChange={(next) => {
            if (busy) return;
            if (!next && pendingCount > 0) {
              setConfirmOpen(true);
              return;
            }
            void send(next);
          }}
        />
      </div>

      {/* Plain text on purpose: the toast already announces the change; a
          second polite region read the same news twice (UX M3). */}
      <p className="aura-text-sm font-medium text-[var(--aura-fg-primary)]">
        {enabled ? t('state.on') : t('state.off')}
      </p>

      {pendingCount > 0 ? (
        <Alert tone="info" role="note">
          {t.rich(enabled ? 'pending.on' : 'pending.off', {
            count: pendingCount,
            // Persistent underline — an in-paragraph link's only non-colour
            // affordance (WCAG 1.4.1; the ledger's M5 rule). The alert's own
            // text colour is kept — never muted on a link.
            link: (chunks) => (
              <Link
                href="/admin/change-requests"
                className="rounded-[var(--aura-radius-xs)] font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]"
              >
                {chunks}
              </Link>
            ),
          })}
        </Alert>
      ) : null}

      {error !== null ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}

      <ConfirmationDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirm.title')}
        description={t('confirm.body', { count: pendingCount })}
        confirmLabel={t('confirm.confirm', { count: pendingCount })}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => send(false)}
      />
    </div>
  );
}
