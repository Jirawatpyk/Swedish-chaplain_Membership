'use client';

/**
 * 108 PR-C T089 (US5 / FR-040, FR-040b, FR-041; SC-004) — the compose page's
 * live recipient count.
 *
 * `useRecipientCount` calls the numbers-only count endpoint for the segment
 * the member (or the admin, on a proxied member's behalf) is choosing:
 * debounced 400 ms and coalesced (one request for the LATEST segment), with a
 * request sequence so a late answer for an older segment can never overwrite
 * a newer one. A non-200 or a network failure is `unavailable` — never a
 * stale number (FR-040b); the custom list is counted client-side and is
 * `idle` here, as is a tier with no codes or an admin with no member picked.
 * A `retryNonce` bump re-runs the SAME url (review 2026-09-07 round 2, UX
 * H-5: `unavailable` used to be terminal for a fixed-url segment).
 *
 * `<RecipientCountLine>` renders the state in a polite live region so a
 * screen-reader user hears the count change without focus moving, with
 * locale digit grouping through next-intl's ICU `{count, number}`. The
 * region is ALWAYS in the DOM (empty when idle) so an insertion is never
 * what a screen reader has to notice, and the line never shifts the form.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert, Users } from 'lucide-react';

export type RecipientCountState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'ready';
      readonly count: number;
      readonly ceiling: number;
      readonly exceeds: boolean;
      /** Staff route only (review 2026-09-07, M-3) — the member body omits it. */
      readonly orphans?: number;
      /**
       * Measured on every outcome since round 2 (C8); optional here so an
       * older server's body still renders. Read by the `empty` copy.
       */
      readonly droppedByPreference?: number;
    };

export type CountableSegmentKind = 'all_members' | 'tier' | 'custom' | 'event_attendees_last_90d';

export interface RecipientCountSegment {
  readonly kind: CountableSegmentKind;
  readonly tierCodes: ReadonlyArray<string>;
}

export type UseRecipientCountProps =
  | { readonly mode: 'member'; readonly segment: RecipientCountSegment }
  | { readonly mode: 'admin'; readonly memberId: string | null; readonly segment: RecipientCountSegment };

/** Debounce window (contract § 5 / tasks T089). */
export const RECIPIENT_COUNT_DEBOUNCE_MS = 400;

/**
 * The URL to count, or `null` when there is nothing to count server-side.
 * Exported for tests and for the e2e helper; pure.
 */
export function recipientCountUrl(props: UseRecipientCountProps): string | null {
  const { segment } = props;
  if (segment.kind === 'custom') return null;
  if (segment.kind === 'tier' && segment.tierCodes.length === 0) return null;
  const params = new URLSearchParams();
  if (props.mode === 'admin') {
    if (props.memberId === null) return null;
    params.set('member_id', props.memberId);
  }
  params.set('segment', segment.kind);
  if (segment.kind === 'tier') params.set('tier', segment.tierCodes.join(','));
  const base = props.mode === 'admin' ? '/api/admin/broadcasts/recipient-count' : '/api/broadcasts/recipient-count';
  return `${base}?${params.toString()}`;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function toReady(body: unknown): RecipientCountState {
  if (typeof body !== 'object' || body === null) return { status: 'unavailable' };
  const b = body as Record<string, unknown>;
  // The three fields every answer carries are required; the two MEASURED
  // fields are optional but, when present, must be well-formed — a malformed
  // value is a malformed body, never coerced.
  if (
    !isNonNegativeInt(b['count']) ||
    !isNonNegativeInt(b['ceiling']) ||
    typeof b['exceeds'] !== 'boolean' ||
    (b['droppedByPreference'] !== undefined && !isNonNegativeInt(b['droppedByPreference'])) ||
    (b['orphans'] !== undefined && !isNonNegativeInt(b['orphans']))
  ) {
    return { status: 'unavailable' };
  }
  return {
    status: 'ready',
    count: b['count'],
    ceiling: b['ceiling'],
    exceeds: b['exceeds'],
    ...(isNonNegativeInt(b['orphans']) && { orphans: b['orphans'] }),
    ...(isNonNegativeInt(b['droppedByPreference']) && { droppedByPreference: b['droppedByPreference'] }),
  };
}

export function useRecipientCount(props: UseRecipientCountProps, retryNonce = 0): RecipientCountState {
  const url = recipientCountUrl(props);
  // The settled answer is keyed by (url, retryNonce): a retry is a NEW key
  // for the same url, so the line reads "loading" on the very same render
  // and the old `unavailable` never lingers.
  const key = url === null ? null : `${url}#${retryNonce}`;
  // Only SETTLED answers are stored, keyed by the request they answer; the
  // transient states (`idle`, `loading`) are DERIVED from the current key, so
  // the effect never sets state synchronously (react-hooks/set-state-in-effect)
  // and a key change is "loading" on the very same render.
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: RecipientCountState;
  } | null>(null);
  // Monotonic request sequence: only the LATEST request may write state — a
  // late answer for an older segment is dropped even if its fetch outlived
  // the abort.
  const seqRef = useRef(0);

  useEffect(() => {
    // Bumped BEFORE the null check on purpose: a segment that becomes
    // uncountable must invalidate an in-flight answer for the previous one.
    const seq = ++seqRef.current;
    if (url === null || key === null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let next: RecipientCountState;
      try {
        const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          next = { status: 'unavailable' };
        } else {
          const body: unknown = await res.json().catch(() => null);
          if (seq !== seqRef.current) return;
          next = toReady(body);
        }
      } catch {
        if (seq !== seqRef.current) return;
        next = { status: 'unavailable' };
      }
      setSettled({ key, state: next });
    }, RECIPIENT_COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, key]);

  if (key === null) return { status: 'idle' };
  if (settled !== null && settled.key === key) return settled.state;
  return { status: 'loading' };
}

export function RecipientCountLine({
  state,
  onRetry,
}: {
  readonly state: RecipientCountState;
  /** Review round 2 (UX H-5) — re-runs the count for the same segment. */
  readonly onRetry?: () => void;
}): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.recipientCount');
  let text: string | null = null;
  // Review 2026-09-07 round 2 (UX H-5 / L-6): the tones say what the state
  // IS. `text-muted-foreground` is this codebase's empty-state sentinel, so
  // a failure must not wear it; a measured number is the most actionable
  // figure on the form and gets weight; a refusal is red.
  let tone = 'text-muted-foreground';
  let icon: React.ReactElement | null = null;
  let retry = false;
  switch (state.status) {
    case 'idle':
      break;
    case 'loading':
      text = t('loading');
      break;
    case 'unavailable':
      text = t('unavailable');
      tone = 'text-warning';
      icon = <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />;
      retry = true;
      break;
    case 'ready':
      // Re-review 2026-09-07 (finding #4) — a MEASURED refusal blocks the
      // submit and the count only re-runs on a url or nonce change, so the
      // member had no way to re-ask after staff fixed the cause. Retry on
      // every state the count blocks on, not only `unavailable`.
      retry = state.exceeds || state.count === 0;
      if (state.exceeds) {
        text = t('exceeds', { count: state.count, ceiling: state.ceiling });
        tone = 'text-destructive';
      } else if (state.count === 0) {
        // Review round 2 (i18n H1): "0 recipients will receive" was a lie —
        // the submit would be refused. And a tier where everyone objected
        // must read differently from a tier with nobody in it (FR-022a).
        text = t('empty', { dropped: state.droppedByPreference ?? 0 });
        tone = 'text-destructive';
      } else {
        text = t('ready', { count: state.count });
        tone = 'font-medium text-foreground';
        icon = <Users className="size-3.5 shrink-0" aria-hidden="true" />;
      }
      break;
  }
  return (
    // Always rendered, `min-h` for two lines of TH / SV, so the count
    // settling never shifts the form (UX M-4) and the live region exists
    // before its content changes (L-1 — an inserted region is not announced).
    <div className={`flex min-h-10 items-start gap-1.5 text-sm ${tone}`}>
      {/*
        /code-review 2026-09-07 (finding #8) — the retry BUTTON used to live
        inside this region. A live region announces its whole text content on
        every change, so the control's label was read as part of the status
        ("Counting recipients… Try again"), and inserting/removing an
        interactive element inside a live region is announced as a status
        change rather than offered as an action. The region now holds only the
        status text; the button is a sibling. `aria-live="polite"` is kept
        alongside `role="status"` — redundant, but it is the hook the e2e
        reflow assertion selects on and it costs nothing.
      */}
      <p role="status" aria-live="polite" className="flex items-start gap-1.5">
        {icon !== null ? <span className="mt-0.5">{icon}</span> : null}
        {text !== null ? <span>{text}</span> : null}
      </p>
      {retry ? (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 shrink-0 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          {t('retry')}
        </button>
      ) : null}
    </div>
  );
}
