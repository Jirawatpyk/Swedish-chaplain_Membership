// @vitest-environment node
/**
 * Round 7 — **the fix had two hops and only one of them was tested.**
 *
 * Round 6 found a send gate written as `status !== 'draft'` over a set
 * `normaliseStatus` closed by FABRICATING `'queued'` for anything it did not
 * recognise. `'cancelled'` and every unseen status therefore read as "already
 * handed to /send", the send was skipped, the row still advanced to `sending`,
 * and `reconcile-stuck-sending` stamped `sent` and consumed the member's annual
 * E-Blast quota — zero mail, quota spent, row asserting delivery.
 *
 * The fix was two hops: the adapter stops fabricating (returns `'unknown'`), and
 * the gate tests POSITIVELY. Three mutants were applied and killed — **all three
 * on the gate**. Nothing in `tests/` touched `normaliseStatus`, and the shared
 * contract fake's `broadcasts.get` returns a fixed 404, so no test in the repo
 * reached it even once. `default: return 'queued'` survived 1,557 green tests.
 *
 * That matters more than a coverage gap: reintroducing the fabrication restores
 * the round-6 bug in full — the gate would read the invented `'queued'` as proof
 * of a send — with nothing going red.
 *
 * So this asserts the mapping ON THE WIRE, the way its two siblings in this
 * folder do. `'draft'` is pinned because it is the value that proves the set was
 * open: it fell through that default until 2026-09-10, and it is the most
 * ordinary state a broadcast can be in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const BROADCAST_ID = 'bc_11111111-2222-4333-8444-555555555555';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubGet(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(status, body)),
  );
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retrieveBroadcast — the adapter must not invent a status it did not receive', () => {
  it('an UNRECOGNISED status maps to `unknown`, never to a plausible-looking one', async () => {
    stubGet(200, {
      object: 'broadcast',
      id: BROADCAST_ID,
      status: 'some_future_resend_status',
      sent_at: null,
    });

    const outcome = await resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID);

    expect(outcome.kind).toBe('present');
    if (outcome.kind !== 'present') return;
    // The assertion the whole finding is about. `'queued'` here is the round-6
    // bug: the gate reads it as evidence of a send that never happened.
    expect(outcome.resource.status).toBe('unknown');
  });

  /**
   * MEASURED 2026-09-10 against the live account (draft + DELETE, never `/send`):
   * a broadcast created and never sent reports `"status": "draft"`. This case is
   * the standing proof that the unknown-status default catches LIVE values, not
   * hypothetical future ones.
   */
  it('`draft` survives as `draft` — the value that proved the set was open', async () => {
    stubGet(200, {
      object: 'broadcast',
      id: BROADCAST_ID,
      status: 'draft',
      sent_at: null,
    });

    const outcome = await resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID);

    expect(outcome.kind).toBe('present');
    if (outcome.kind !== 'present') return;
    expect(outcome.resource.status).toBe('draft');
  });

  it('`sent` passes through with its timestamp, which the replay audit row needs', async () => {
    stubGet(200, {
      object: 'broadcast',
      id: BROADCAST_ID,
      status: 'sent',
      sent_at: '2026-09-10T04:00:00.000Z',
    });

    const outcome = await resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID);

    expect(outcome.kind).toBe('present');
    if (outcome.kind !== 'present') return;
    expect(outcome.resource.status).toBe('sent');
    // Round 7 M-1: the dispatch replay path stamps this into an append-only
    // audit row instead of `now`, which was up to an hour wrong.
    expect(outcome.resource.sentAt).toBe('2026-09-10T04:00:00.000Z');
  });

  /**
   * Positive control. Without it, a `retrieveBroadcast` that swallowed every
   * response would satisfy the three assertions above while never reporting a
   * missing resource — and `not_found` is the arm the dispatch gate deliberately
   * falls through on.
   */
  it('404 → not_found, not a fabricated present resource', async () => {
    stubGet(404, {
      statusCode: 404,
      name: 'not_found',
      message: 'Broadcast not found',
    });

    const outcome = await resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID);

    expect(outcome).toEqual({ kind: 'not_found' });
  });
});
