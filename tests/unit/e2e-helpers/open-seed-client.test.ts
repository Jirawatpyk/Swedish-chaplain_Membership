/**
 * 108 T041 review round 1 (security-engineer, L6) — the e2e seed client
 * connects as the BYPASSRLS owner and its callers DELETE by pattern. It had
 * no production-host guard, unlike `tests/integration-setup.ts`. Same
 * fail-closed contract here: a `DATABASE_URL` matching any fragment in
 * `TEST_DB_HOST_BLOCKLIST` must never get a client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMock = vi.fn((_url: unknown, _opts: unknown) => ({ end: vi.fn() }));
vi.mock('postgres', () => ({
  default: (url: unknown, opts: unknown) => postgresMock(url, opts),
}));

import { openSeedClient } from '../../e2e/helpers/open-seed-client';

const ENV_KEYS = ['DATABASE_URL', 'TEST_DB_HOST_BLOCKLIST'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  postgresMock.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('openSeedClient — production-host guard', () => {
  it('throws (fail-closed) when DATABASE_URL matches a blocklisted host fragment', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@ep-prod-abc123.ap-southeast-1.aws.neon.tech/db';
    process.env.TEST_DB_HOST_BLOCKLIST = 'ep-prod-abc123, something-else';
    expect(() => openSeedClient('unit')).toThrow(/blocklisted/i);
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('opens a client for a non-blocklisted host', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@ep-dev-xyz789.ap-southeast-1.aws.neon.tech/db';
    process.env.TEST_DB_HOST_BLOCKLIST = 'ep-prod-abc123';
    const client = openSeedClient('unit');
    expect(client).not.toBeNull();
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it('still no-ops (null) when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    process.env.TEST_DB_HOST_BLOCKLIST = 'ep-prod-abc123';
    expect(openSeedClient('unit')).toBeNull();
    expect(postgresMock).not.toHaveBeenCalled();
  });
});
