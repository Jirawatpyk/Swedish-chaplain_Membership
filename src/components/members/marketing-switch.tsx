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
 *   - the switch flips OPTIMISTICALLY on click and rolls back on any refusal
 *     or failure, so `aria-checked` never lags one round-trip behind the
 *     toast (review H3 / a11y 5); it stays disabled until the refresh that
 *     brings the server truth has settled;
 *   - `unchanged` (someone else got there first) is an info toast; every
 *     refusal maps to a localized error toast — the 409 `suppressed` one
 *     explains that the person's own unsubscribe takes precedence (FR-025);
 *   - "status unavailable" renders the switch DISABLED: a blind change could
 *     override an unsubscribe nobody could verify (FR-031a);
 *   - under a state-filtered view (`leavesView`, e.g. the FR-027a pre-flight
 *     preset) the row LEAVES the view on refresh: focus is handed to the next
 *     row's switch — else the count line, else the previous row — BEFORE the
 *     refresh, never dropped on <body>, and the toast says so (review H4 /
 *     a11y 2);
 *   - the accessible name carries the contact's name and the current state,
 *     and the hit area is ≥ 24×24 px (the Switch primitive's expanded
 *     pseudo-element plus the 24-px wrapper; FR-035c / WCAG 2.5.8).
 */
import { useRef, useState, useTransition } from 'react';
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

/** The element the count line renders with (audience page) — focus fallback. */
export const AUDIENCE_COUNT_ID = 'audience-count';

/**
 * Where focus goes when this row is about to leave the view: the next
 * switch in the same table, else the count line, else the previous switch.
 */
function focusHandOffTarget(from: HTMLElement): HTMLElement | null {
  const table = from.closest('table');
  const switches = table
    ? Array.from(table.querySelectorAll<HTMLElement>('[role="switch"]'))
    : [];
  const idx = switches.indexOf(from);
  const next = idx >= 0 ? switches[idx + 1] : undefined;
  if (next) return next;
  const count = document.getElementById(AUDIENCE_COUNT_ID);
  if (count) return count;
  const prev = idx > 0 ? switches[idx - 1] : undefined;
  return prev ?? null;
}

export function MarketingSwitch({
  contactId,
  contactName,
  state,
  size = 'default',
  leavesView = false,
}: {
  readonly contactId: string;
  readonly contactName: string;
  readonly state: MarketingState;
  readonly size?: 'sm' | 'default';
  /**
   * True when the current view is filtered by marketing state, so a
   * successful change removes this row on refresh (FR-027a pre-flight).
   */
  readonly leavesView?: boolean;
}): React.ReactElement {
  const t = useTranslations('shared.marketing.switch');
  const tState = useTranslations('shared.marketing.state');
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  // Optimistic value shown until the server truth (`state`) changes under
  // us — the "adjust state when a prop changes" pattern, during render.
  const [optimistic, setOptimistic] = useState<'on' | 'off' | null>(null);
  const [syncedState, setSyncedState] = useState(state);
  if (state !== syncedState) {
    setSyncedState(state);
    setOptimistic(null);
  }

  const checked = (optimistic ?? (state === 'on' ? 'on' : 'off')) === 'on';
  const disabled = state === 'unavailable';
  // FR-025 AMENDMENT (privacy review B-2 / L-1): the person's own objection —
  // their unsubscribe OR their own opt-out — is not something staff can lift,
  // so there is no control to offer, only the badge with its explanation.
  const staffCanAct = state !== 'off_by_contact' && state !== 'unsubscribed';

  async function send(next: 'on' | 'off', opts: { readonly offerUndo: boolean }): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOptimistic(next);
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
        setOptimistic(null);
        const kind = problemKind(body);
        if (res.status === 409 && kind === 'suppressed') toast.error(t('errors.suppressed'));
        else if (res.status === 409 && kind === 'self_opted_out') {
          toast.error(t('errors.selfOptedOut'));
        } else if (res.status === 403) toast.error(t('errors.forbidden'));
        else if (res.status === 404) toast.error(t('errors.notFound'));
        else if (res.status === 429) toast.error(t('errors.rateLimited'));
        else if (res.status === 503 && kind === 'suppression_unavailable') {
          toast.error(t('errors.unavailable'));
        } else toast.error(t('errors.generic'));
        return;
      }

      if (body.outcome === 'unchanged') {
        // The server already held this state — show its truth, not our guess.
        setOptimistic(null);
        toast.info(t('unchanged'));
      } else {
        const message = next === 'off'
          ? t('switchedOff', { name: contactName })
          : t('switchedOn', { name: contactName });
        const toastOptions = {
          ...(leavesView ? { description: t('leftView') } : {}),
          ...(next === 'off' && opts.offerUndo
            ? {
                duration: 10_000,
                action: {
                  label: t('undo'),
                  onClick: () => {
                    void send('on', { offerUndo: false });
                  },
                },
              }
            : {}),
        };
        if (Object.keys(toastOptions).length > 0) toast.success(message, toastOptions);
        else toast.success(message);
        // The row is about to unmount with the refresh — move focus FIRST,
        // or it falls back to <body> (a focus-loss class axe never catches).
        if (leavesView && ref.current) focusHandOffTarget(ref.current)?.focus();
      }
      startRefresh(() => {
        router.refresh();
      });
    } catch {
      setOptimistic(null);
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  if (!staffCanAct) return <></>;

  return (
    <span className="inline-flex min-h-6 min-w-6 items-center">
      <Switch
        ref={ref}
        size={size}
        checked={checked}
        disabled={disabled || busy || isRefreshing}
        aria-label={t('ariaLabel', { name: contactName, state: tState(state) })}
        data-marketing-state={state}
        onCheckedChange={(next) => {
          void send(next ? 'on' : 'off', { offerUndo: true });
        }}
      />
    </span>
  );
}
