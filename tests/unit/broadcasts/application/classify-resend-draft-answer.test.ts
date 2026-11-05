/**
 * Spec 140 s2d (#735) — `classifyResendDraftAnswer`, the ONE table of what
 * Resend's answers about a draft decide, per caller policy. Pure: the callers
 * keep their own calls, pause, throws, timing and log lines, and only map this
 * answer (the characterization matrix,
 * `resend-draft-answer-characterization.test.ts`, proves they still do).
 *
 * Two stages, as each caller runs them:
 *   - the DELETE's answer alone (`probe: null`) — settled, undecided, or
 *     `probe` (GET next, after `REPROBE_PAUSE_MS` when `pause`);
 *   - the DELETE's 404 / 403 plus the GET's answer.
 * The two refusal policies also take the tick's EARLIER probe
 * (`priorProbe`): a 403 on an id it read `cancelled` clears with no GET.
 *
 * `—` = the policy never asks this cell (its overloads refuse it).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResendDraftAnswer,
  type ResendDraftPolicy,
} from '@/modules/broadcasts/application/use-cases/_classify-resend-draft-answer';
import { isHandedStatus, probedStatusOf } from '@/modules/broadcasts/application/use-cases/_probe-refused-send';

type D = 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other';
type G = 'not_found' | 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'unknown' | 'retryable' | 'other';
type Prior = 'draft' | 'cancelled' | null;

const SENT_AT = '2026-05-03T00:00:09.999Z';

function probeOf(g: G) {
  if (g === 'not_found' || g === 'retryable' || g === 'other') return { kind: g };
  return { kind: 'present' as const, status: g, sentAt: SENT_AT };
}

const NA = '—' as const;
type Cell = Record<string, unknown> | typeof NA;
type Row = Readonly<Record<ResendDraftPolicy, Cell>>;

const deleted = { kind: 'deleted' };
const absent = { kind: 'absent' };
const probe = (del: 'absent' | 'forbidden', pause: boolean) => ({ kind: 'probe', deleted: del, pause });
const unsendable = (status: 'cancelled' | 'failed') => ({ kind: 'unsendable', status });
const handed = (status: 'queued' | 'sending' | 'sent') => ({ kind: 'handed', status });
const handedAt = (status: 'queued' | 'sending' | 'sent') => ({ kind: 'handed', status, sentAt: SENT_AT });
const undecided = (del: D, probed: string | null) => ({ kind: 'undecided', deleted: del, probed });

const all = (cell: Cell): Row => ({ in_flight: cell, terminal_draft: cell, erased_refusal: cell, standing_refusal: cell, orphan: cell });

/** Stage 1 — the DELETE's answer alone. `prior` reaches only the two refusal policies. */
const DELETE_ROWS: ReadonlyArray<readonly [D, Prior, Row]> = [
  ['deleted', 'draft', all(deleted)],
  ['deleted', 'cancelled', all(deleted)],
  ['absent', 'draft', { in_flight: probe('absent', true), terminal_draft: absent, erased_refusal: absent, standing_refusal: absent, orphan: probe('absent', true) }],
  ['absent', 'cancelled', { in_flight: probe('absent', true), terminal_draft: absent, erased_refusal: absent, standing_refusal: absent, orphan: probe('absent', true) }],
  [
    'forbidden',
    'draft',
    {
      in_flight: probe('forbidden', false),
      terminal_draft: probe('forbidden', false),
      erased_refusal: undecided('forbidden', null),
      standing_refusal: probe('forbidden', false),
      orphan: probe('forbidden', false),
    },
  ],
  [
    'forbidden',
    'cancelled',
    {
      in_flight: probe('forbidden', false),
      terminal_draft: probe('forbidden', false),
      erased_refusal: unsendable('cancelled'),
      standing_refusal: unsendable('cancelled'),
      orphan: probe('forbidden', false),
    },
  ],
  [
    'forbidden',
    null,
    {
      in_flight: probe('forbidden', false),
      terminal_draft: probe('forbidden', false),
      erased_refusal: undecided('forbidden', null),
      standing_refusal: probe('forbidden', false),
      orphan: probe('forbidden', false),
    },
  ],
  ['retryable', 'draft', all(undecided('retryable', null))],
  ['retryable', 'cancelled', all(undecided('retryable', null))],
  ['other', 'draft', all(undecided('other', null))],
  ['other', 'cancelled', all(undecided('other', null))],
];

/** Stage 2 — a 404 or a 403, then the GET's answer. */
const PROBE_ROWS: ReadonlyArray<readonly ['absent' | 'forbidden', G, Row]> = [
  ['absent', 'not_found', { in_flight: absent, terminal_draft: NA, erased_refusal: NA, standing_refusal: NA, orphan: absent }],
  ...(['draft', 'cancelled', 'failed', 'unknown', 'retryable', 'other'] as const).map(
    (g) => ['absent', g, { in_flight: undecided('absent', g), terminal_draft: NA, erased_refusal: NA, standing_refusal: NA, orphan: undecided('absent', g) }] as const,
  ),
  // In flight a 404 then a handed GET is already sent (evidence); an orphan's is undecided.
  ...(['queued', 'sending', 'sent'] as const).map(
    (g) => ['absent', g, { in_flight: handed(g), terminal_draft: NA, erased_refusal: NA, standing_refusal: NA, orphan: undecided('absent', g) }] as const,
  ),
  ...(['not_found', 'draft', 'unknown', 'retryable', 'other'] as const).map(
    (g) =>
      [
        'forbidden',
        g,
        { in_flight: undecided('forbidden', g), terminal_draft: undecided('forbidden', g), erased_refusal: NA, standing_refusal: undecided('forbidden', g), orphan: undecided('forbidden', g) },
      ] as const,
  ),
  ...(['queued', 'sending', 'sent'] as const).map(
    (g) => ['forbidden', g, { in_flight: handed(g), terminal_draft: handed(g), erased_refusal: NA, standing_refusal: handedAt(g), orphan: handed(g) }] as const,
  ),
  ['forbidden', 'cancelled', { in_flight: unsendable('cancelled'), terminal_draft: unsendable('cancelled'), erased_refusal: NA, standing_refusal: unsendable('cancelled'), orphan: unsendable('cancelled') }],
  // A 403 then `failed`: unexpected in flight, an unsendable copy everywhere else.
  ['forbidden', 'failed', { in_flight: undecided('forbidden', 'failed'), terminal_draft: unsendable('failed'), erased_refusal: NA, standing_refusal: unsendable('failed'), orphan: unsendable('failed') }],
];

const POLICIES: ReadonlyArray<ResendDraftPolicy> = ['in_flight', 'terminal_draft', 'erased_refusal', 'standing_refusal', 'orphan'];
const isRefusal = (p: ResendDraftPolicy) => p === 'erased_refusal' || p === 'standing_refusal';

describe('classifyResendDraftAnswer — the DELETE alone', () => {
  const cells = DELETE_ROWS.flatMap(([d, prior, row]) => POLICIES.map((p) => [p, d, prior, row[p]] as const));
  it.each(cells)('%s: DELETE %s, priorProbe %s', (policy, d, prior, want) => {
    const classify = classifyResendDraftAnswer as (...args: unknown[]) => unknown;
    const got = isRefusal(policy) ? classify(policy, d, null, prior) : classify(policy, d, null);
    expect(got).toEqual(want);
  });
});

describe('classifyResendDraftAnswer — a 404 / 403, then the GET', () => {
  const cells = PROBE_ROWS.flatMap(([d, g, row]) => POLICIES.filter((p) => row[p] !== NA).map((p) => [p, d, g, row[p]] as const));
  it.each(cells)('%s: DELETE %s, GET %s', (policy, d, g, want) => {
    const classify = classifyResendDraftAnswer as (...args: unknown[]) => unknown;
    expect(classify(policy, d, probeOf(g))).toEqual(want);
  });

  it('standing_refusal: a handed GET from a double with no sentAt → sentAt null', () => {
    const classify = classifyResendDraftAnswer as (...args: unknown[]) => unknown;
    expect(classify('standing_refusal', 'forbidden', { kind: 'present', status: 'sent' })).toEqual({ kind: 'handed', status: 'sent', sentAt: null });
  });

  it('only standing_refusal carries sentAt: no other policy can leak it', () => {
    const classify = classifyResendDraftAnswer as (...args: unknown[]) => unknown;
    for (const p of ['in_flight', 'terminal_draft', 'orphan'] as const) {
      expect(JSON.stringify(classify(p, 'forbidden', probeOf('sent')))).not.toContain(SENT_AT);
    }
  });
});

describe('probedStatusOf', () => {
  it.each([
    [probeOf('sent'), 'sent'],
    [probeOf('failed'), 'failed'],
    [probeOf('not_found'), 'not_found'],
    [probeOf('retryable'), 'retryable'],
    [probeOf('other'), 'other'],
  ] as const)('%j → %s', (p, want) => {
    expect(probedStatusOf(p as never)).toBe(want);
  });

  // Spec 140 slice 3 (the status readers, option a) — the same reader takes the
  // bounded `retrieveBroadcast` outcome too, so every probe reads one shape and
  // a `failed` there (were the union ever widened) is named, not folded.
  it.each([
    [{ kind: 'present', resource: { id: 'rb-1', status: 'draft', sentAt: null } }, 'draft'],
    [{ kind: 'present', resource: { id: 'rb-1', status: 'sent', sentAt: SENT_AT } }, 'sent'],
    [{ kind: 'present', resource: { id: 'rb-1', status: 'failed', sentAt: null } }, 'failed'],
    [{ kind: 'not_found' }, 'not_found'],
  ] as const)('retrieveBroadcast outcome %j → %s', (p, want) => {
    expect(probedStatusOf(p as never)).toBe(want);
  });
});

describe('isHandedStatus', () => {
  it('failed is not handed — Resend never delivered it (MEASURED 2026-10-29)', () => {
    expect(isHandedStatus('failed')).toBe(false);
  });
});
