'use client';

/**
 * 108 PR-D (FR-030, FR-030b, FR-030c, FR-051) — the STAFF marketing toggle,
 * shared by the member detail page and the Marketing audience page. Render
 * it only for holders of `contacts.marketing` (the page decides); others see
 * the read-only `MarketingStateBadge`.
 *
 * Behaviour:
 *   - no confirmation dialog either way (FR-030c); switching OFF offers a
 *     10-second Undo in the success toast; switching ON takes effect at once;
 *   - EVERY request — the Undo included — mints its OWN `Idempotency-Key`. A
 *     reused key would hand back the stored "off" outcome and make Undo a
 *     silent no-op (FR-030b);
 *   - `unchanged` (someone else got there first) is an info toast; every
 *     refusal maps to a localized error toast — the 409 `suppressed` one
 *     explains that the person's own unsubscribe takes precedence (FR-025);
 *   - "status unavailable" renders the switch DISABLED: a blind change could
 *     override an unsubscribe nobody could verify (FR-031a);
 *   - the accessible name carries the contact's name and the current state,
 *     and the hit area is ≥ 24×24 px (the Switch primitive's expanded
 *     pseudo-element plus the 24-px wrapper; FR-035c / WCAG 2.5.8).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import type { MarketingState } from '@/modules/members';

type ProblemBody = { readonly type?: string; readonly outcome?: string };

const PROBLEM_KIND_RE = /\/errors\/([a-z_]+)$/;
function problemKind(body: ProblemBody): string | null {
  const m = typeof body.type === 'string' ? PROBLEM_KIND_RE.exec(body.type) : null;
  return m?.[1] ?? null;
}

export function MarketingSwitch({
  contactId,
  contactName,
  state,
  onChanged,
  size = 'default',
}: {
  readonly contactId: string;
  readonly contactName: string;
  readonly state: MarketingState;
  /** Fired after a successful change (the page may re-fetch or re-sort). */
  readonly onChanged?: (() => void) | undefined;
  readonly size?: 'sm' | 'default';
}): React.ReactElement {
  const t = useTranslations('shared.marketing.switch');
  const tState = useTranslations('shared.marketing.state');
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const checked = state === 'on';
  const disabled = state === 'unavailable';

  async function send(next: 'on' | 'off', opts: { readonly offerUndo: boolean }): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/contacts/${encodeURIComponent(contactId)}/marketing`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Fresh per request — the Undo must not replay the "off" outcome.
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ state: next }),
      });
      const body = (await res.json().catch(() => ({}))) as ProblemBody;

      if (!res.ok) {
        const kind = problemKind(body);
        if (res.status === 409 && kind === 'suppressed') toast.error(t('errors.suppressed'));
        else if (res.status === 403) toast.error(t('errors.forbidden'));
        else if (res.status === 404) toast.error(t('errors.notFound'));
        else if (res.status === 429) toast.error(t('errors.rateLimited'));
        else if (res.status === 503 && kind === 'suppression_unavailable') {
          toast.error(t('errors.unavailable'));
        } else toast.error(t('errors.generic'));
        return;
      }

      if (body.outcome === 'unchanged') {
        toast.info(t('unchanged'));
      } else if (next === 'off' && opts.offerUndo) {
        toast.success(t('switchedOff', { name: contactName }), {
          duration: 10_000,
          action: {
            label: t('undo'),
            onClick: () => {
              void send('on', { offerUndo: false });
            },
          },
        });
      } else {
        toast.success(next === 'off' ? t('switchedOff', { name: contactName }) : t('switchedOn', { name: contactName }));
      }
      router.refresh();
      onChanged?.();
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex min-h-6 min-w-6 items-center">
      <Switch
        size={size}
        checked={checked}
        disabled={disabled || busy}
        aria-label={t('ariaLabel', { name: contactName, state: tState(state) })}
        data-marketing-state={state}
        onCheckedChange={(next) => {
          void send(next ? 'on' : 'off', { offerUndo: true });
        }}
      />
    </span>
  );
}
