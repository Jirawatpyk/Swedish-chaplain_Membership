/**
 * N4 (Round 3) — shared assertion for the B3 outer try/catch contract
 * across all 9 wrapped /api/auth/** routes.
 *
 * Pins:
 *   - `response.status === 500`
 *   - `body.error === 'server-error'`
 *   - `body.requestId` is a non-empty string
 *
 * Pre-N4 only sign-in / change-password / redeem-invite had a 500
 * contract test; the other 6 routes were uncovered. A future refactor
 * that strips `requestId` from one route's catch — or partially rolls
 * back B3 — would slip through. Calling this helper once per route
 * gives uniform regression coverage without duplicating 20 lines.
 */
import type { NextResponse } from 'next/server';
import { expect } from 'vitest';

/**
 * Assert that a NextResponse matches the B3 500-with-requestId contract.
 * Awaits `response.json()` internally so the caller doesn't have to.
 */
export async function assertRoute500WithRequestId(
  response: NextResponse,
): Promise<void> {
  expect(response.status).toBe(500);
  const body = (await response.json()) as {
    error?: string;
    requestId?: string;
  };
  expect(body.error).toBe('server-error');
  expect(typeof body.requestId).toBe('string');
  expect((body.requestId ?? '').length).toBeGreaterThan(0);
}
