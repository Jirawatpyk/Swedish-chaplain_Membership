/**
 * Spec 141 — a stubbed global `fetch` that records exactly what the real
 * `resend` SDK puts on the wire, so the contract suite pins it across an SDK
 * bump. The API key is never recorded: only whether a Bearer token was sent.
 */
import { vi } from 'vitest';

export interface WireCall {
  readonly method: string;
  readonly url: string;
  readonly bearer: boolean;
  readonly contentType: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

export function stubWire(respond: (call: number) => Response | Promise<Response>): WireCall[] {
  const calls: WireCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      return respond(calls.length);
    }),
  );
  return calls;
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
