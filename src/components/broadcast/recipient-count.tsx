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
 *
 * `<RecipientCountLine>` renders the state in a polite live region so a
 * screen-reader user hears the count change without focus moving, with
 * locale digit grouping through next-intl's ICU `{count, number}`.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

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
      /** Absent when the server refused before measuring (exceeds / empty). */
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

export function useRecipientCount(props: UseRecipientCountProps): RecipientCountState {
  const url = recipientCountUrl(props);
  // Only SETTLED answers are stored, keyed by the url they answer; the
  // transient states (`idle`, `loading`) are DERIVED from the current url, so
  // the effect never sets state synchronously (react-hooks/set-state-in-effect)
  // and a url change is "loading" on the very same render.
  const [settled, setSettled] = useState<{
    readonly url: string;
    readonly state: RecipientCountState;
  } | null>(null);
  // Monotonic request sequence: only the LATEST request may write state — a
  // late answer for an older segment is dropped even if its fetch outlived
  // the abort.
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    if (url === null) return;
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
      setSettled({ url, state: next });
    }, RECIPIENT_COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  if (url === null) return { status: 'idle' };
  if (settled !== null && settled.url === url) return settled.state;
  return { status: 'loading' };
}

export function RecipientCountLine({ state }: { readonly state: RecipientCountState }): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.recipientCount');
  if (state.status === 'idle') return null;
  let text: string;
  let tone = 'text-muted-foreground';
  switch (state.status) {
    case 'loading':
      text = t('loading');
      break;
    case 'unavailable':
      text = t('unavailable');
      break;
    case 'ready':
      if (state.exceeds) {
        text = t('exceeds', { count: state.count, ceiling: state.ceiling });
        tone = 'text-destructive';
      } else {
        text = t('ready', { count: state.count });
      }
      break;
  }
  return (
    <p role="status" aria-live="polite" className={`text-xs ${tone}`}>
      {text}
    </p>
  );
}
