/**
 * 108 PR-D review cycle 14 (whole-branch MEDIUM-7) — the ONE suppression
 * adapter behind both toggles and the audience page
 * (`makeMarketingSuppressionLookup`) was untested; its "unparseable address →
 * not suppressed" branch is the one that lets a "switch on" through, so it
 * must be pinned with its reason: the two email grammars are identical, so the branch is unreachable — NOT because "the list only holds parsed values" (false: the multi-batch webhook path brands without parsing; see the body comment on that case),
 * so an unparseable one cannot be on it — that is a truthful answer, not a
 * fail-open. A repo failure, by contrast, THROWS (the port contract) so the
 * toggle refuses "on" and the audience page degrades to "status unavailable".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupBatch = vi.fn();
const listEmailLowers = vi.fn();
let withList = true;

const loggerError = vi.fn();
const loggerDebug = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), debug: (...a: unknown[]) => loggerDebug(...a), warn: vi.fn(), info: vi.fn() },
}));
const suppressionLookupFailed = vi.fn();
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: { suppressionLookupFailed: (...a: unknown[]) => suppressionLookupFailed(...a) },
}));

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
  loggerError.mockReset();
  loggerDebug.mockReset();
  suppressionLookupFailed.mockReset();
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

  it('an UNPARSEABLE address → false WITHOUT a lookup, and leaves a debug breadcrumb', async () => {
    // The honest reason (review errors LOW-1): `asEmail` (members) and
    // `asEmailLower` (broadcasts) share one grammar, so no stored
    // `contacts.email` can pass one and fail the other. It is NOT "the list
    // only holds parsed values" — the multi-batch webhook path brands without
    // parsing. If this branch ever fires, the two grammars have drifted and
    // somebody must know.
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('not an address')).resolves.toBe(false);
    expect(lookupBatch).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerDebug.mock.calls[0])).not.toContain('not an address');
  });

  it('a repo failure THROWS — never "not suppressed" (fail closed)', async () => {
    lookupBatch.mockRejectedValue(new Error('neon down'));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('jane@example.com')).rejects.toThrow('neon down');
  });

  it('a repo failure is LOGGED (class only) and counted before it is re-thrown', async () => {
    // Review errors HIGH-1: six callers swallow this throw into a degraded
    // state. The composition layer is the one place that can see it, so it
    // logs + counts here and every caller inherits the observability.
    lookupBatch.mockRejectedValue(new Error('neon down: SELECT ... jane@example.com'));
    const port = makeMarketingSuppressionLookup(tenant);
    await expect(port.isSuppressed('jane@example.com')).rejects.toThrow();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('marketing.suppression_lookup_threw');
    expect(fields).toMatchObject({ tenantId: 'test-tenant', op: 'isSuppressed' });
    // Class, never the message — a Postgres error carries the SQL and its
    // parameters, which include the address.
    expect(JSON.stringify(fields)).not.toContain('jane@example.com');
    expect(suppressionLookupFailed).toHaveBeenCalledWith('test-tenant', 'isSuppressed');
  });

  it.each(['lookupSuppressed', 'listSuppressedEmailLowers'] as const)(
    '%s also logs + counts before re-throwing',
    async (op) => {
      lookupBatch.mockRejectedValue(new Error('boom'));
      listEmailLowers.mockRejectedValue(new Error('boom'));
      const port = makeMarketingSuppressionLookup(tenant);
      const call =
        op === 'lookupSuppressed'
          ? port.lookupSuppressed(['jane@example.com'])
          : port.listSuppressedEmailLowers();
      await expect(call).rejects.toThrow('boom');
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError.mock.calls[0]![0]).toMatchObject({ op });
      expect(suppressionLookupFailed).toHaveBeenCalledWith('test-tenant', op);
    },
  );
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
