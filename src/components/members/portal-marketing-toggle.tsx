'use client';

/**
 * 108 PR-D (US6 — FR-032, FR-033, FR-051) — the contact's OWN marketing
 * control on /portal/profile.
 *
 *   - on / off (by contact or by staff) → a switch; PATCH
 *     `/api/portal/profile/marketing` with a fresh `Idempotency-Key` per
 *     request and `{ optOut }`;
 *   - the switch flips OPTIMISTICALLY on click and rolls back on any refusal
 *     or failure, staying disabled until the refresh that brings the server
 *     truth has settled (same pattern as the staff `MarketingSwitch`;
 *     whole-branch review LOW-6);
 *   - unsubscribed → plain text and NO control: the person's own unsubscribe
 *     stands and is not something to flip from here (FR-025);
 *   - unavailable → plain text and NO control, same as unsubscribed
 *     (code-review finding 3): a switch we cannot vouch for asserts a state.
 *     The explanation stays (FR-031a), and a 503 from the write says so
 *     rather than "something went wrong";
 *   - primary contact → the FR-033 note: invoices and payment emails are
 *     unaffected by this preference.
 *
 * Only the session's own state is ever rendered — the page never passes
 * another contact's state in (FR-032).
 */
import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import type { MarketingState } from '@/modules/members';

type ResponseBody = { readonly outcome?: string; readonly error?: { readonly code?: string } };

export function PortalMarketingToggle({
  state,
  isPrimary,
}: {
  readonly state: MarketingState;
  readonly isPrimary: boolean;
}): React.ReactElement {
  const t = useTranslations('portal.profile.marketing');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const stateId = useId();
  const hintId = useId();

  // Optimistic value shown until the server truth (`state`) changes under
  // us — the "adjust state when a prop changes" pattern, during render.
  const [optimistic, setOptimistic] = useState<'on' | 'off' | null>(null);
  const [syncedState, setSyncedState] = useState(state);
  if (state !== syncedState) {
    setSyncedState(state);
    setOptimistic(null);
  }

  const checked = (optimistic ?? (state === 'on' ? 'on' : 'off')) === 'on';
  // Code-review finding 3, corrected. The reported scenario ("a person cannot
  // opt OUT during an outage") is inverted: `checked` is false for
  // `unavailable`, so the rendered switch already SHOWS off and the direction
  // it blocks is opting IN — which the server refuses with 503 anyway. The
  // real defect is the misrepresentation: an UNKNOWN state was drawn as a
  // definite "off", so someone still receiving marketing saw a control saying
  // they were not. Do what `unsubscribed` already does — state the situation in
  // words and render no control, rather than a control in a position we cannot
  // vouch for.
  const controllable = state !== 'unsubscribed' && state !== 'unavailable';
  // a11y review 11 asked that a screen-reader user hear the state and, when it
  // cannot be changed, WHY. That was met with `aria-describedby` on a disabled
  // switch; with no switch rendered for `unavailable` (finding 3) the two
  // strings sit in the flow right after the label, where browse mode reads them
  // in order. So `describedBy` is now just the state sentence — the switch only
  // exists in states that have nothing extra to explain.
  const describedBy = stateId;

  async function send(optOut: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOptimistic(optOut ? 'off' : 'on');
    try {
      const res = await fetch('/api/portal/profile/marketing', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ optOut }),
      });
      const body = (await res.json().catch(() => ({}))) as ResponseBody;
      if (!res.ok) {
        setOptimistic(null);
        // Name the refusal (review errors MEDIUM-3 / LOW-2): 409 is three
        // different things and 503 is a transient outage the copy already
        // explains — "Something went wrong" told the member none of that.
        const code = body.error?.code;
        if (res.status === 409 && code === 'suppressed') toast.error(t('toast.errors.suppressed'));
        else if (res.status === 429) toast.error(t('toast.errors.rateLimited'));
        else if (res.status === 503 && code === 'suppression_unavailable') {
          toast.error(t('toast.errors.unavailable'));
        } else toast.error(t('toast.errors.generic'));
        // Round-1 finding 5, narrowed by round-2 finding 3: only a 409
        // proves the rendered state is stale (the address reached the
        // suppression list since this page loaded, so the control should be
        // gone). A 429 or a 503 is the server asking us to back off — and on
        // `suppression_unavailable` a refresh re-runs the lookup that threw.
        if (res.status === 409 && code === 'suppressed') startRefresh(() => router.refresh());
        return;
      }
      if (body.outcome === 'unchanged') {
        // The server already held this state — show its truth, not our guess.
        setOptimistic(null);
        toast.info(t('toast.unchanged'));
      } else {
        toast.success(optOut ? t('toast.switchedOff') : t('toast.switchedOn'));
      }
      startRefresh(() => {
        router.refresh();
      });
    } catch {
      setOptimistic(null);
      toast.error(t('toast.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="portal-marketing"
      data-marketing-state={state}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{t('label')}</span>
        {controllable && (
          <span className="inline-flex min-h-6 min-w-6 items-center">
            <Switch
              checked={checked}
              disabled={busy || isRefreshing}
              aria-label={t('switchLabel')}
              aria-describedby={describedBy}
              onCheckedChange={(next) => {
                void send(!next);
              }}
            />
          </span>
        )}
        {/* A STATE, not an empty sentinel — muted is reserved for the hints
            below (spec Assumptions; review M7). */}
        <span id={stateId} className="text-sm text-foreground">
          {t(`state.${state}`)}
        </span>
      </div>
      {state === 'unsubscribed' && (
        <p className="text-xs text-muted-foreground">{t('unsubscribedHint')}</p>
      )}
      {state === 'unavailable' && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('unavailableHint')}
        </p>
      )}
      {isPrimary && <p className="text-xs text-muted-foreground">{t('primaryNote')}</p>}
    </div>
  );
}
