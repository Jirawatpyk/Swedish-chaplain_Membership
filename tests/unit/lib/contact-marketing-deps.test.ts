/**
 * 108 PR-D review cycle 14 (whole-branch MEDIUM-7) — the ONE suppression
 * adapter behind both toggles and the audience page
 * (`makeMarketingSuppressionLookup`) was untested; its "unparseable address →
 * not suppressed" branch is the one that lets a "switch on" through, so it
 * must be pinned with its reason: the list only ever holds PARSED addresses,
 * so an unparseable one cannot be on it — that is a truthful answer, not a
 * fail-open. A repo failure, by contrast, THROWS (the port contract) so the
 * toggle refuses "on" and the audience page degrades to "status unavailable".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupBatch = vi.fn();
const listEmailLowers = vi.fn();
let withList = true;

vi.mock('@/modules/members', () => ({
  drizzleContactRepo: { __contactRepo: true },
  drizzleMemberRepo: { __memberRepo: true },
  f3DrizzleAuditAdapter: { __audit: true },
}));
vi.mock('@/modules/broadcasts', () => ({
  asEmailLower: (raw: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: { kind: 'invalid_email' } },
  makeDrizzleMarketingUnsubscribesRepo: () =>
    withList ? { lookupBatch, listEmailLowers } : { lookupBatch },
}));

import {
  buildContactMarketingDeps,
  buildMarketingAudienceDeps,
  makeMarketingSuppressionLookup,
} from '@/lib/contact-marketing-deps';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');

beforeEach(() => {
  withList = true;
  lookupBatch.mockReset();
  listEmailLowers.mockReset();
});

describe('makeMarketingSuppressionLookup — isSuppressed', () => {
  it('a listed address → true (lower-cased before the lookup)', async () => {
    lookupBatch.mockResolvedValue(new Set(['jane@example.com']));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('Jane@Example.com')).resolves.toBe(true);
    expect(lookupBatch).toHaveBeenCalledWith('test-tenant', ['jane@example.com']);
  });

  it('an unlisted address → false', async () => {
    lookupBatch.mockResolvedValue(new Set());
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('jane@example.com')).resolves.toBe(false);
  });

  it('an UNPARSEABLE address → false WITHOUT a lookup (it cannot be on a list of parsed values)', async () => {
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('not an address')).resolves.toBe(false);
    expect(lookupBatch).not.toHaveBeenCalled();
  });

  it('a repo failure THROWS — never "not suppressed" (fail closed)', async () => {
    lookupBatch.mockRejectedValue(new Error('neon down'));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('jane@example.com')).rejects.toThrow('neon down');
  });
});

describe('makeMarketingSuppressionLookup — batch + list', () => {
  it('lookupSuppressed drops unparseable input, skips the repo for an empty batch', async () => {
    lookupBatch.mockResolvedValue(new Set(['b@example.com']));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.lookupSuppressed(['nope'])).resolves.toEqual(new Set());
    expect(lookupBatch).not.toHaveBeenCalled();
    const r = await port.lookupSuppressed(['A@example.com', 'nope', 'b@example.com']);
    expect([...r]).toEqual(['b@example.com']);
    expect(lookupBatch).toHaveBeenCalledWith('test-tenant', ['a@example.com', 'b@example.com']);
  });

  it('listSuppressedEmailLowers passes the repo set through, and THROWS when the repo lacks it', async () => {
    listEmailLowers.mockResolvedValue(new Set(['x@example.com']));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.listSuppressedEmailLowers()).resolves.toEqual(new Set(['x@example.com']));
    withList = false;
    const bare = makeMarketingSuppressionLookup(tenant);
    await expect(bare.listSuppressedEmailLowers()).rejects.toThrow(/listEmailLowers/);
  });
});

describe('composition roots', () => {
  it('buildContactMarketingDeps / buildMarketingAudienceDeps wire the members adapters + the lookup', () => {
    const write = buildContactMarketingDeps(tenant);
    expect(write.tenant).toBe(tenant);
    expect(write.contactRepo).toEqual({ __contactRepo: true });
    expect(write.audit).toEqual({ __audit: true });
    expect(typeof write.marketingSuppression.isSuppressed).toBe('function');
    const read = buildMarketingAudienceDeps(tenant);
    expect(read.memberRepo).toEqual({ __memberRepo: true });
    expect(typeof read.marketingSuppression.listSuppressedEmailLowers).toBe('function');
  });
});
