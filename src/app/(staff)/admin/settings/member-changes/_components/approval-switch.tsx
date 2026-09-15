'use client';

/**
 * F114 US6 (FR-031, FR-032, FR-034, FR-036) — the per-tenant "require
 * approval for member changes" switch on `/admin/settings/member-changes`.
 *
 * Behaviour:
 *   - the control is a labelled Base UI `Switch`; the visible state line is
 *     a `role="status"` live region, so a screen-reader user hears the new
 *     state when the server confirms it (no optimistic flip — the switch
 *     shows the server truth, so `aria-checked` never lies on a refusal);
 *   - switching OFF while requests are waiting opens the platform
 *     confirmation dialog (plain tier — nothing is destroyed: pending
 *     requests stay decidable, FR-032) whose confirm button states the
 *     count; Cancel sends nothing;
 *   - `PATCH /api/admin/settings/member-changes { approvalEnabled }`, same
 *     origin; while in flight the switch is `aria-busy` + dimmed, never
 *     `disabled` (a disabled control drops focus to `<body>`);
 *   - success → toast + status line; a 503 read-only refusal → the platform
 *     read-only copy inline (`role="alert"`), any other failure → the generic
 *     inline alert; state unchanged either way (ux-standards § 4.1).
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { InlineAlert } from '@/components/ui/inline-alert';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type ResponseBody = {
  readonly approvalEnabled?: unknown;
  // read-only-mode 503: flat string (proxy-level gate) OR nested `{ code }`
  // (the route guard) — same dual-shape check as `plans-table.tsx`.
  readonly error?: string | { readonly code?: string };
};

function isReadOnlyRefusal(status: number, body: ResponseBody): boolean {
  if (status !== 503) return false;
  const code = typeof body.error === 'string' ? body.error : body.error?.code;
  return code === 'read_only_mode' || code === 'read-only-mode';
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
  const tErrors = useTranslations('errors');
  const switchId = useId();
  const labelId = useId();
  const descriptionId = useId();
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
      const body = (await res.json().catch(() => ({}))) as ResponseBody;
      if (!res.ok) {
        setError(isReadOnlyRefusal(res.status, body) ? tErrors('readOnlyMode') : t('errors.generic'));
        return;
      }
      // The server's value, not our request — an unchanged no-op still
      // answers with the stored state.
      const value = body.approvalEnabled === true;
      setEnabled(value);
      toast.success(value ? t('toast.on') : t('toast.off'));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-busy={busy || undefined}
          className="mt-0.5 aria-busy:opacity-70"
          onCheckedChange={(next) => {
            if (busy) return;
            if (!next && pendingCount > 0) {
              setConfirmOpen(true);
              return;
            }
            void send(next);
          }}
        />
        <div className="grid gap-1">
          <Label id={labelId} htmlFor={switchId}>
            {t('switchLabel')}
          </Label>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-sm font-medium">
        {enabled ? t('state.on') : t('state.off')}
      </p>

      {enabled && pendingCount > 0 ? (
        <InlineAlert tone="info" role="note">
          {t('offWarning', { count: pendingCount })}
        </InlineAlert>
      ) : null}

      {error !== null ? (
        <InlineAlert tone="destructive" role="alert">
          {error}
        </InlineAlert>
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
