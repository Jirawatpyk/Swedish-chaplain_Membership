// @vitest-environment node
/**
 * Spec 140 s2a — every Broadcasts gateway call is bounded (DL5a, DL8, P6).
 *
 * The REAL `resend` SDK and the gateway's raw `fetch` calls run against a
 * stubbed `fetch` that honours `init.signal` the way the platform's does: a
 * hung request settles only when its signal aborts, so a call that passes no
 * signal never settles. Each case races the call against a real-time sentinel,
 * so an unbounded call fails an assertion instead of the test timeout.
 *
 * `AbortSignal.timeout` runs on real timers, so this file never fakes them:
 * the budgets are real milliseconds (50 ms; ~2 s where a retry must fit; 1 s
 * for the CR#3 import budget).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// resend@6.35 reads RESEND_BASE_URL / RESEND_USER_AGENT when a client is built.
vi.hoisted(() => {
  delete process.env['RESEND_BASE_URL'];
  delete process.env['RESEND_USER_AGENT'];
});
import {
  createResendBroadcastsGateway,
} from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import {
  IMPORT_CALL_TIMEOUT_MS,
  RESEND_CALL_TIMEOUT_MS,
  type BroadcastsGatewayPort,
  type CreateBroadcastInput,
} from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { stubResendFetch } from '../../../support/resend/wire-guard';

type Handler = (call: number, init: RequestInit | undefined) => Promise<Response>;

/**
 * Installed before every case and never removed: a call left running by a
 * failing case (an unbounded retry loop sleeping 16 s) meets this, never the
 * network. Between cases the handler answers a transport failure. Spec 140 DR4:
 * it goes through the wire guard, so an account-wide `DELETE /contacts/{email}`
 * fails the case that sent it (re-installed per case, because the guard's check
 * belongs to one test).
 */
const closed: Handler = async () => {
  throw new TypeError('fetch closed: the case that made this request has ended');
};
let handler: Handler = closed;
let requests: Array<{ readonly url: string; readonly signal: AbortSignal | null }> = [];
const recordingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  requests.push({ url: String(input), signal: init?.signal ?? null });
  return handler(requests.length, init);
};
beforeEach(() => {
  stubResendFetch(recordingFetch);
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const server5xx = (): Response =>
  json(500, { statusCode: 500, name: 'internal_server_error', message: 'boom' });

/** No answer until the signal aborts; with no signal, no answer at all. */
const hang: Handler = (_call, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** A 200 whose body never ends until the signal aborts (a stall mid-body). */
const hangBody: Handler = async (_call, init) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

type Settled =
  | { readonly value: unknown }
  | { readonly thrown: { readonly kind: unknown; readonly subKind: unknown } }
  | 'still running';

async function settleWithin(run: Promise<unknown>, ms: number): Promise<{ settled: Settled; elapsedMs: number }> {
  const started = performance.now();
  const outcome = run.then(
    (value): Settled => ({ value }),
    (e: { kind?: unknown; subKind?: unknown }): Settled => ({ thrown: { kind: e?.kind, subKind: e?.subKind } }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sentinel = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  try {
    const settled = await Promise.race([outcome, sentinel]);
    return { settled, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const INPUT: CreateBroadcastInput = {
  audienceId: 'aud_1',
  subject: 'Hello',
  htmlBody: '<p>hi</p>',
  fromName: 'SweCham',
  fromEmail: 'noreply@example.com',
  replyToEmail: 'office@example.com',
  broadcastNameForResendDashboard: 'SweCham — Hello',
  tenantDisplayName: 'SweCham',
  locale: 'en',
};

type Run = (g: BroadcastsGatewayPort) => Promise<unknown>;

/** Every port method that throws a classified error. */
const THROWING: ReadonlyArray<readonly [string, Run]> = [
  ['createAudience', (g) => g.createAudience('probe')],
  ['createBroadcast', (g) => g.createBroadcast(INPUT)],
  ['sendBroadcast', (g) => g.sendBroadcast('bc_1', 'idem-key-1')],
  // Spec 140 s4 — the two calls below refuse a non-UUID segment id with no request.
  ['getAudienceContactCount', (g) => g.getAudienceContactCount('0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19')],
  ['retrieveBroadcast', (g) => g.retrieveBroadcast('bc_1')],
  ['removeContactFromAudience', (g) => g.removeContactFromAudience('0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19', 'a@example.com')],
  ['listAudiences', (g) => g.listAudiences({ deadlineAt: new Date(Date.now() + 60_000) })],
  ['deleteAudience', (g) => g.deleteAudience('0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19')],
  ['deleteBroadcast', (g) => g.deleteBroadcast('bc_1')],
  ['createContactImport', (g) => g.createContactImport('aud_1', ['a@example.com'])],
  ['getContactImport', (g) => g.getContactImport('imp_1')],
];

/** The two single-attempt calls that answer an outcome instead of throwing. */
const ONCE: ReadonlyArray<readonly [string, Run]> = [
  ['retrieveBroadcastOnce', (g) => g.retrieveBroadcastOnce('bc_1')],
  ['deleteBroadcastOnce', (g) => g.deleteBroadcastOnce('bc_1')],
];

const CREATES = THROWING.filter(([name]) =>
  ['createAudience', 'createBroadcast', 'createContactImport'].includes(name),
);

beforeEach(() => {
  vi.useRealTimers();
  handler = closed;
  requests = [];
});

describe('DL8 — every broadcasts gateway call aborts at callTimeoutMs on a hung fetch', () => {
  const C = 50;

  it('the cases below cover every port method', () => {
    const covered = [...THROWING, ...ONCE].map(([name]) => name).sort();
    expect(covered).toEqual(Object.keys(createResendBroadcastsGateway()).sort());
  });

  it.each(THROWING)('%s aborts at callTimeoutMs on a hung fetch (50 ms)', async (_name, run) => {
    handler = hang;
    const { settled } = await settleWithin(run(createResendBroadcastsGateway({ callTimeoutMs: C, importCallTimeoutMs: C })), 1_000);
    expect(settled).toEqual({ thrown: { kind: 'retryable', subKind: 'timeout' } });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });

  it.each(ONCE)('%s aborts at callTimeoutMs on a hung fetch (50 ms) and answers retryable', async (_name, run) => {
    handler = hang;
    const { settled } = await settleWithin(run(createResendBroadcastsGateway({ callTimeoutMs: C, importCallTimeoutMs: C })), 1_000);
    expect(settled).toEqual({ value: { kind: 'retryable' } });
  });

  // A stall after the headers: the SDK reads the body with `response.json()`,
  // the raw calls with `res.text()`. The signal aborts the body read too, and
  // that is a timeout, not an unreadable answer.
  it.each([
    ['retrieveBroadcast (SDK body)', ((g) => g.retrieveBroadcast('bc_1')) as Run, { thrown: { kind: 'retryable', subKind: 'timeout' } }],
    ['getContactImport (raw body)', ((g) => g.getContactImport('imp_1')) as Run, { thrown: { kind: 'retryable', subKind: 'timeout' } }],
    ['retrieveBroadcastOnce (raw body)', ((g) => g.retrieveBroadcastOnce('bc_1')) as Run, { value: { kind: 'retryable' } }],
  ])('%s: a body that stalls mid-read is a timeout', async (_name, run, expected) => {
    handler = hangBody;
    const { settled } = await settleWithin(run(createResendBroadcastsGateway({ callTimeoutMs: C, importCallTimeoutMs: C })), 1_000);
    expect(settled).toEqual(expected);
  });

  it('the production budget is 10 s, and 30 s for a contact import', () => {
    expect(RESEND_CALL_TIMEOUT_MS).toBe(10_000);
    expect(IMPORT_CALL_TIMEOUT_MS).toBe(30_000);
  });
});

describe('DL5a — a create is not retried in-process on a 5xx or a timeout', () => {
  // The default 10 s budget: a backoff would fit, so one request is the policy,
  // not the budget.
  it.each(CREATES)('%s: one request on a 5xx', async (_name, run) => {
    handler = async () => server5xx();
    const { settled } = await settleWithin(run(createResendBroadcastsGateway()), 1_500);
    expect({ settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'server_5xx' } },
      requests: 1,
    });
  });

  it.each(CREATES)('%s: one request on a timeout', async (_name, run) => {
    handler = hang;
    const { settled } = await settleWithin(run(createResendBroadcastsGateway({ callTimeoutMs: 50, importCallTimeoutMs: 50 })), 1_000);
    expect({ settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'timeout' } },
      requests: 1,
    });
  });
});

// Review round 1, CR#1: a 429 created nothing (Resend refused the request for
// its rate), so a create still retries it inside the budget; anything that may
// have reached Resend (a 5xx, a network failure, a timeout) stays one attempt.
describe('CR#1 — a create retries a 429 but not a 5xx or a timeout', () => {
  const rateLimited = (): Response =>
    json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' });

  it.each(CREATES)('%s: a create retries a 429 but not a 5xx or a timeout', async (_name, run) => {
    handler = async (call) => (call === 1 ? rateLimited() : json(201, { object: 'x', id: 'x_1' }));
    const after429 = await settleWithin(run(createResendBroadcastsGateway()), 2_500);
    expect({ settled: 'value' in (after429.settled as object), requests: requests.length }).toEqual({
      settled: true,
      requests: 2,
    });

    requests = [];
    handler = async () => server5xx();
    const after5xx = await settleWithin(run(createResendBroadcastsGateway()), 1_500);
    expect({ settled: after5xx.settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'server_5xx' } },
      requests: 1,
    });

    requests = [];
    handler = hang;
    const afterTimeout = await settleWithin(run(createResendBroadcastsGateway({ callTimeoutMs: 50, importCallTimeoutMs: 50 })), 1_000);
    expect({ settled: afterTimeout.settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'timeout' } },
      requests: 1,
    });
  });
});

describe('P6 — one signal spans every attempt of a retried call', () => {
  // Room for exactly one 1 s backoff: a retry fits only while the budget left
  // exceeds the next backoff + 1 s. Every bound is relative to C (review round
  // 1, CR#4): a per-attempt signal would end case (a) at 1 s + C ≈ 1.33 C, and
  // a missing budget guard would end case (b) at or after C.
  const C = 3_000;

  it('a retried GET never exceeds C in total (a 5xx, then a hang)', async () => {
    handler = async (call, init) => (call === 1 ? server5xx() : hang(call, init));
    const { settled, elapsedMs } = await settleWithin(
      createResendBroadcastsGateway({ callTimeoutMs: C }).retrieveBroadcast('bc_1'),
      C * 1.25,
    );
    expect({ settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'timeout' } },
      requests: 2,
    });
    expect(elapsedMs).toBeLessThan(C * 1.2);
  });

  it('a retried GET that keeps failing fast gives up before C, never sleeping past it', async () => {
    handler = async () => server5xx();
    const { settled, elapsedMs } = await settleWithin(
      createResendBroadcastsGateway({ callTimeoutMs: C }).getContactImport('imp_1'),
      C * 1.25,
    );
    expect({ settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'server_5xx' } },
      requests: 2,
    });
    expect(elapsedMs).toBeLessThan(C * 0.75);
  });
});

// Review round 2, CR#3: a contact import uploads the whole CSV (up to the
// 5,000 / 50,000 ceiling), so it has its own budget, 30 s by default; it is
// still one attempt.
describe('CR#3 — createContactImport has its own budget', () => {
  it('createContactImport aborts at importCallTimeoutMs, not callTimeoutMs', async () => {
    handler = hang;
    // Wide windows for CI (review round 3, code-review #8): on callTimeoutMs the
    // call would end at 50 ms, long before the 300 ms check; on its own 1 s
    // budget it is still pending then and settled well inside 2.5 s.
    const run = createResendBroadcastsGateway({ callTimeoutMs: 50, importCallTimeoutMs: 1_000 }).createContactImport(
      'aud_1',
      ['a@example.com'],
    );
    const early = await settleWithin(run, 300);
    expect(early.settled).toBe('still running');
    const late = await settleWithin(run, 2_200);
    expect({ settled: late.settled, requests: requests.length }).toEqual({
      settled: { thrown: { kind: 'retryable', subKind: 'timeout' } },
      requests: 1,
    });
    // Review round 4: it ends AT its 1 s budget, not merely inside the window, so a
    // doubled or summed budget (~2 s) is red.
    expect(early.elapsedMs + late.elapsedMs).toBeLessThan(1_800);
  });
});
