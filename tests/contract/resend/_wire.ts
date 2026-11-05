/**
 * Spec 141 — a stubbed global `fetch` that records exactly what the real
 * `resend` SDK puts on the wire, so the contract suite pins it across an SDK
 * bump. The API key is never recorded: only whether a Bearer token was sent.
 *
 * Spec 140 s4 (DR4) — the stub goes through the shared wire guard
 * (`tests/support/resend/wire-guard.ts`), so a test whose code sends
 * `DELETE /contacts/{email}` fails. `stubWireRecordOnly` is the guard's own
 * positive control: it records the violations instead of failing the test.
 */
import { vi } from 'vitest';

import { guardResendFetch, type WireViolation } from '../../support/resend/wire-guard';

export interface WireCall {
  readonly method: string;
  readonly url: string;
  readonly bearer: boolean;
  readonly contentType: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

/** Answers call `call` (1-based); `init` is the request as `fetch` received it. */
export type WireResponder = (
  call: number,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

function install(respond: WireResponder, failTest: boolean): { calls: WireCall[]; violations: readonly WireViolation[] } {
  const calls: WireCall[] = [];
  const guarded = guardResendFetch(
    async (input, init) => {
      const headers = new Headers(init?.headers ?? {});
      const raw = typeof init?.body === 'string' ? init.body : null;
      let body: unknown = raw;
      if (raw !== null) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        bearer: (headers.get('authorization') ?? '').startsWith('Bearer '),
        contentType: headers.get('content-type'),
        idempotencyKey: headers.get('idempotency-key'),
        body,
      });
      return respond(calls.length, input, init);
    },
    { failTest },
  );
  vi.stubGlobal('fetch', guarded.fetch);
  return { calls, violations: guarded.violations };
}

/** The stub every contract case uses: a `DELETE /contacts/{email}` fails the test. */
export function stubWire(respond: WireResponder): WireCall[] {
  return install(respond, true).calls;
}

/** The guard's positive control only: violations are returned, not failed. */
export function stubWireRecordOnly(respond: WireResponder): {
  readonly calls: readonly WireCall[];
  readonly violations: readonly WireViolation[];
} {
  return install(respond, false);
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
