/**
 * The e2e `page` fixture fails a test on any pageerror. On WebKit, a test that
 * navigates while Next's RSC fetch for the previous route is still in flight
 * cancels that fetch, and WebKit rejects it as `TypeError: Load failed`
 * (Chromium's AbortError is swallowed by Next). Only that pairing is noise;
 * every other "Load failed" must still fail the test.
 */
import { describe, expect, it } from 'vitest';
import {
  isCancelledNavigationError,
  isCancelledRscRequest,
} from '../../e2e/helpers/cancelled-navigation-noise';

describe('isCancelledRscRequest', () => {
  it('is true for a cancelled or aborted RSC fetch on either engine', () => {
    expect(isCancelledRscRequest('http://localhost:3100/admin/members/x?_rsc=1o9hs', 'Load request cancelled')).toBe(true);
    expect(isCancelledRscRequest('http://localhost:3100/portal?_rsc=abc', 'net::ERR_ABORTED')).toBe(true);
  });

  it('is false for a non-RSC request or a failure that is not a cancellation', () => {
    expect(isCancelledRscRequest('http://localhost:3100/api/payments/initiate', 'Load request cancelled')).toBe(false);
    expect(isCancelledRscRequest('http://localhost:3100/portal?_rsc=abc', 'net::ERR_CONNECTION_REFUSED')).toBe(false);
  });
});

describe('isCancelledNavigationError', () => {
  const loadFailed = { name: 'TypeError', message: 'Load failed' };

  it('is true for "Load failed" within the window of a cancelled RSC fetch', () => {
    expect(isCancelledNavigationError(loadFailed, 10_300, [10_000])).toBe(true);
  });

  it('is false for "Load failed" with no cancelled RSC fetch nearby', () => {
    expect(isCancelledNavigationError(loadFailed, 10_300, [])).toBe(false);
    expect(isCancelledNavigationError(loadFailed, 20_000, [10_000])).toBe(false);
  });

  it('is false for any other error, even right after a cancelled RSC fetch', () => {
    expect(isCancelledNavigationError({ name: 'Error', message: 'MISSING_MESSAGE: x' }, 10_100, [10_000])).toBe(false);
    expect(isCancelledNavigationError({ name: 'TypeError', message: 'Load failed for /api/x' }, 10_100, [10_000])).toBe(false);
  });
});
