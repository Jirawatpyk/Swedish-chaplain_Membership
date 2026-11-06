/**
 * Spec 140 s4, DR4 — a `fetch` stub that fails the test on any account-wide
 * Resend contact delete, `DELETE /contacts/{email}` (or `/contacts/{id}`).
 *
 * The Resend account is ONE account shared by every tenant, so that request
 * would destroy another tenant's contact, and with it the `unsubscribed` flag
 * the import's `on_conflict=upsert` preserves. The gateway detaches with the
 * segment-scoped `DELETE /contacts/{email}/segments/{id}` instead. Every test
 * stub of `fetch` under the Resend gateway or SDK goes through this, so a code
 * path that starts sending the global delete fails the suite. It is opt-in:
 * a new test that stubs `fetch` directly instead of through `stubWire` or
 * `stubResendFetch` is not guarded, so route every new Resend stub here.
 *
 * It RECORDS a violation and never throws: the SDK's `fetchRequest` catches a
 * throw from `fetch` and answers `application_error`, which a test would then
 * read as an ordinary transient failure. The check runs from
 * `onTestFinished`, so it fails the test the request was made in, after its
 * `afterEach` (an `unstubAllGlobals` there cannot drop it). Call it inside a
 * test or a `beforeEach`; that is where vitest knows the current test.
 *
 * The match runs on the normalised URL, on any host, case-insensitively, with a
 * trailing slash and a query string allowed: `new URL(...)`, the method from
 * `init` or else from the `Request`. A URL that cannot be parsed is recorded
 * too, so the guard fails closed instead of going blind.
 */
import { expect, onTestFinished, vi, type Mock } from 'vitest';

export interface WireViolation {
  readonly method: string;
  readonly url: string;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const ACCOUNT_WIDE_CONTACT_PATH = /^\/+contacts\/[^/]+\/?$/i;

/** The violation `input`/`init` make, or `null`. Never throws. */
export function accountWideContactDelete(input: RequestInfo | URL, init?: RequestInit): WireViolation | null {
  const isRequest = input instanceof Request;
  const raw = isRequest ? input.url : String(input);
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  let pathname: string;
  try {
    pathname = new URL(raw, 'http://unparsed.invalid').pathname;
  } catch {
    return { method, url: raw };
  }
  return method === 'DELETE' && ACCOUNT_WIDE_CONTACT_PATH.test(pathname) ? { method, url: raw } : null;
}

/**
 * Wrap `impl` in the guard. The returned `fetch` is a `vi.fn`, so a test can
 * still read its calls. With `failTest: false` nothing is registered and the
 * caller reads `violations` itself (the guard's own positive control).
 */
export function guardResendFetch(
  impl: FetchImpl,
  { failTest = true }: { readonly failTest?: boolean } = {},
): { readonly fetch: Mock<FetchImpl>; readonly violations: readonly WireViolation[] } {
  const violations: WireViolation[] = [];
  if (failTest) {
    onTestFinished(() => {
      expect(violations, 'spec 140 DR4: an account-wide DELETE /contacts/{email} reached the wire').toEqual([]);
    });
  }
  const fetch = vi.fn<FetchImpl>(async (input, init) => {
    const violation = accountWideContactDelete(input, init);
    if (violation !== null) violations.push(violation);
    return impl(input, init);
  });
  return { fetch, violations };
}

/** `vi.stubGlobal('fetch', …)` through the guard; the default fails the test. */
export function stubResendFetch(impl: FetchImpl): ReturnType<typeof guardResendFetch> {
  const guarded = guardResendFetch(impl);
  vi.stubGlobal('fetch', guarded.fetch);
  return guarded;
}
