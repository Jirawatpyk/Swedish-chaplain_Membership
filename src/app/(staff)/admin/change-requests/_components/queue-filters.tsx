'use client';

/**
 * F114 US4 — the /admin/change-requests filter bar (state · outcome · date range).
 *
 * URL is the source of truth (the page validates `?state=&outcome=&from=&to=`
 * and applies the tenant-day bounds); the four controls STAGE locally and the
 * URL is patched on Apply — the `credit-note-filters` / member-page invoice
 * filter shape, so typing a date never churns the router. The state and
 * outcome controls are the shadcn `Select` (Base UI) like every other admin
 * filter (renewals `tier-filter-select`, broadcasts `queue-filters`): the
 * queue used to be the one surface on a native `<select>` (PR-2 review).
 *
 * The outcome control exists only while the STAGED state is `decided` — the
 * only state that has an outcome — and leaving `decided` resets the staged
 * outcome, so a later return to `decided` never re-applies a choice the admin
 * did not make again. The member and submitter scoping (`?memberId=`,
 * `?submitter=`) belong to the chips the page renders under this bar; Apply
 * keeps them, Clear drops everything (the page's "clear" always meant the
 * default pending view). When the URL's filters change under this instance
 * (Back / Forward, a chip link) the controls re-stage from the URL — adjusted
 * DURING render, never by re-keying the component: a remount on every Apply
 * would destroy the button the admin just pressed and drop focus to `<body>`
 * (the re-review's N1).
 *
 * A11y (the UX review of this bar): a Base UI trigger renders a `<button>`,
 * whose accessible name comes from its CONTENT — here the selected value, not
 * the field's purpose — so each trigger carries `aria-label` ("Status" /
 * "Outcome"); the visible `<Label htmlFor>` stays for the click target and
 * the visual. Apply / Clear are never `disabled` while pending (a focused
 * button that turns disabled drops focus to `<body>`); `aria-busy` + a
 * re-entry guard do that job, and Clear hands focus to Apply before it
 * unmounts itself.
 */
import { useCallback, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, TranslatedSelectValue } from '@/components/ui/select';
// the Domain file, not the module barrel — the barrel re-exports server-only
// use cases (the review client imports the same way)
import {
  CHANGE_REQUEST_OUTCOMES,
  CHANGE_REQUEST_STATES,
  type ChangeRequestOutcome,
  type ChangeRequestState,
} from '@/modules/members/domain/change-request/change-request';

const ANY_OUTCOME = 'any' as const;
const DEFAULT_STATE: ChangeRequestState = 'pending';

function isState(v: string | null): v is ChangeRequestState {
  return v !== null && (CHANGE_REQUEST_STATES as readonly string[]).includes(v);
}
function isOutcome(v: string | null): v is ChangeRequestOutcome {
  return v !== null && (CHANGE_REQUEST_OUTCOMES as readonly string[]).includes(v);
}
// the page's rule (`isYmd`: a REAL calendar day, not only the shape — the
// tenant-day helper throws on `2026-02-30`) without js-joda in the client
// bundle: a UTC round-trip is exact for `YYYY-MM-DD`. A date the page would
// refuse is never echoed as a staged filter (re-review R1).
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymd(v: string | null): string {
  if (v === null || !YMD_RE.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '' : v;
}

export function ChangeRequestQueueFilters() {
  const tFilters = useTranslations('admin.changeRequests.filters');
  const tReview = useTranslations('admin.changeRequests.review');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const applyRef = useRef<HTMLButtonElement>(null);

  const urlState = params.get('state');
  const urlOutcome = params.get('outcome');
  const [state, setState] = useState<ChangeRequestState>(isState(urlState) ? urlState : DEFAULT_STATE);
  const [outcome, setOutcome] = useState<ChangeRequestOutcome | typeof ANY_OUTCOME>(isOutcome(urlOutcome) ? urlOutcome : ANY_OUTCOME);
  const urlFrom = ymd(params.get('from'));
  const urlTo = ymd(params.get('to'));
  const [from, setFrom] = useState(urlFrom);
  const [to, setTo] = useState(urlTo);

  // re-stage from the URL when its filters change under this same instance
  // (React's "adjust state during render" — no effect, no remount)
  const urlKey = `${urlState ?? ''}|${urlOutcome ?? ''}|${urlFrom}|${urlTo}`;
  const [stagedFor, setStagedFor] = useState(urlKey);
  if (stagedFor !== urlKey) {
    setStagedFor(urlKey);
    setState(isState(urlState) ? urlState : DEFAULT_STATE);
    setOutcome(isOutcome(urlOutcome) ? urlOutcome : ANY_OUTCOME);
    setFrom(urlFrom);
    setTo(urlTo);
  }

  // the page's `filtered`, read the way the page reads it: a value the page
  // would drop (`?state=bogus`) is no filter, `state=pending` is the default
  // view, an outcome counts only under `decided`, member and submitter
  // scoping count
  const p = (k: string) => params.get(k) ?? '';
  const hasFilters =
    (isState(urlState) && urlState !== DEFAULT_STATE) ||
    (urlState === 'decided' && isOutcome(urlOutcome)) ||
    p('memberId') !== '' ||
    p('submitter') !== '' ||
    urlFrom !== '' ||
    urlTo !== '';

  const replaceUrl = useCallback(
    (qs: string) => {
      startTransition(() => {
        // same-page filter → keep the scroll position (the renewals
        // `urgency-bucket-tabs.tsx` rule)
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [pathname, router],
  );

  const apply = () => {
    if (pending) return;
    const next = new URLSearchParams();
    // the pending default writes no param — the page's default view is the
    // URL-less one (`defaultView` gates the pending summary)
    if (state !== DEFAULT_STATE) next.set('state', state);
    if (state === 'decided' && outcome !== ANY_OUTCOME) next.set('outcome', outcome);
    for (const keep of ['memberId', 'submitter'] as const) {
      const v = params.get(keep);
      if (v) next.set(keep, v);
    }
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    // a filter change restarts paging — never carry the cursor
    replaceUrl(next.toString());
  };

  const clear = () => {
    if (pending) return;
    // this button unmounts once the URL is empty — park focus on Apply first
    applyRef.current?.focus();
    setState(DEFAULT_STATE);
    setOutcome(ANY_OUTCOME);
    setFrom('');
    setTo('');
    replaceUrl('');
  };

  const onStateChange = (v: string | null) => {
    const nextState = isState(v) ? v : DEFAULT_STATE;
    setState(nextState);
    if (nextState !== 'decided') setOutcome(ANY_OUTCOME);
  };

  return (
    <form
      className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end"
      aria-label={tFilters('label')}
      aria-busy={pending}
      data-testid="queue-filters"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="flex flex-col">
        <Label htmlFor="cr-filter-state">{tFilters('state')}</Label>
        <Select value={state} onValueChange={onStateChange}>
          <SelectTrigger id="cr-filter-state" className="w-full" aria-label={tFilters('state')}>
            <TranslatedSelectValue translate={(v) => (isState(v) ? tReview(`state.${v}`) : null)} />
          </SelectTrigger>
          <SelectContent>
            {CHANGE_REQUEST_STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {tReview(`state.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state === 'decided' ? (
        <div className="flex flex-col">
          <Label htmlFor="cr-filter-outcome">{tFilters('outcome')}</Label>
          <Select value={outcome} onValueChange={(v) => setOutcome(isOutcome(v) ? v : ANY_OUTCOME)}>
            <SelectTrigger id="cr-filter-outcome" className="w-full" aria-label={tFilters('outcome')}>
              <TranslatedSelectValue translate={(v) => (isOutcome(v) ? tReview(`outcome.${v}`) : tFilters('anyOutcome'))} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_OUTCOME}>{tFilters('anyOutcome')}</SelectItem>
              {CHANGE_REQUEST_OUTCOMES.map((o) => (
                <SelectItem key={o} value={o}>
                  {tReview(`outcome.${o}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex flex-col">
        <Label htmlFor="cr-filter-from">{tFilters('from')}</Label>
        <Input id="cr-filter-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex flex-col">
        <Label htmlFor="cr-filter-to">{tFilters('to')}</Label>
        <Input id="cr-filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {/* the buttons keep the last (auto) column whether or not the outcome
          control is in the row, so choosing "Decided" does not shove them;
          on a phone they fill the row like the sibling filter bars */}
      <div className={`grid gap-2 sm:flex sm:items-center lg:col-start-5 ${hasFilters ? 'grid-cols-2' : ''}`}>
        {/* `aria-busy` alone has no styling anywhere in the app — the dim is the
            visible "working" signal the old `disabled` used to give (re-review N2) */}
        <Button ref={applyRef} type="submit" variant="outline" aria-busy={pending} className="aria-busy:opacity-70">
          {tFilters('apply')}
        </Button>
        {hasFilters ? (
          <Button type="button" variant="ghost" aria-busy={pending} className="aria-busy:opacity-70" onClick={clear}>
            {tFilters('clear')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
