/**
 * 108 PR-D review cycle 14 (whole-branch MEDIUM-12) — ONE production-host
 * guard shared by the integration harness (`tests/integration-setup.ts`) and
 * the e2e seed client (`tests/e2e/helpers/open-seed-client.ts`), so the two
 * cannot drift: both fail CLOSED on a matching host fragment AND on an
 * unset / empty `TEST_DB_HOST_BLOCKLIST` (a guard with nothing to check is
 * not a guard).
 */
import { describe, expect, it } from 'vitest';
import {
  assertDbHostNotBlocklisted,
  DB_HOST_BLOCKLIST_PLACEHOLDER,
  DB_HOST_BLOCKLIST_PLACEHOLDERS,
} from '../../helpers/db-host-guard';
import { readFileSync } from 'node:fs';

const DEV = 'postgresql://u:p@ep-dev-xyz789.ap-southeast-1.aws.neon.tech/db';
const PROD = 'postgresql://u:p@ep-prod-abc123.ap-southeast-1.aws.neon.tech/db';

describe('assertDbHostNotBlocklisted', () => {
  it('passes for a host outside a populated list', () => {
    expect(() => assertDbHostNotBlocklisted(DEV, 'ep-prod-abc123, something-else', 'unit')).not.toThrow();
  });

  it('throws naming the matched fragment', () => {
    expect(() => assertDbHostNotBlocklisted(PROD, 'ep-prod-abc123', 'unit')).toThrow(/ep-prod-abc123/);
  });

  it.each([undefined, '', '   ', ',,', ' , '])('throws on an unset / empty list (%j) — fail closed', (raw) => {
    expect(() => assertDbHostNotBlocklisted(DEV, raw, 'unit')).toThrow(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('the message carries the caller label so the operator knows which harness refused', () => {
    expect(() => assertDbHostNotBlocklisted(PROD, 'ep-prod-abc123', 'integration')).toThrow(/\[integration\]/);
  });

  // Code-review finding 7: "empty → refuse" did not cover "wrong → pass". A
  // fresh checkout copies `.env.example` to `.env.local` and inherits a
  // NON-EMPTY value that matches no real host — the guard ran and blocked
  // nothing, which is worse than no guard because it reads as protection.
  it('throws on the .env.example placeholder — a value that matches nothing is not a guard', () => {
    expect(() => assertDbHostNotBlocklisted(DEV, DB_HOST_BLOCKLIST_PLACEHOLDER, 'unit')).toThrow(
      /placeholder/i,
    );
    expect(() =>
      assertDbHostNotBlocklisted(DEV, `${DB_HOST_BLOCKLIST_PLACEHOLDER}, ep-real-prod`, 'unit'),
    ).toThrow(/placeholder/i);
  });

  it('throws on EVERY placeholder that has ever shipped, not just the current one', () => {
    // Round-2 review finding 6: rejecting only the newest sentinel protects
    // fresh clones and nobody else — every checkout made before that change
    // still holds the previous value, which is non-empty and matches nothing.
    expect(DB_HOST_BLOCKLIST_PLACEHOLDERS.length).toBeGreaterThan(1);
    for (const value of DB_HOST_BLOCKLIST_PLACEHOLDERS) {
      expect(() => assertDbHostNotBlocklisted(DEV, value, 'unit')).toThrow(/placeholder/i);
    }
  });

  it('the shipped .env.example carries exactly that placeholder (the two cannot drift)', () => {
    // Without this, someone "helpfully" replaces the sentinel with a
    // realistic-looking id and the guard silently stops rejecting it.
    const envExample = readFileSync('.env.example', 'utf8');
    const expected = `TEST_DB_HOST_BLOCKLIST="${DB_HOST_BLOCKLIST_PLACEHOLDER}"`;
    expect(envExample).toContain(expected);
  });
});
