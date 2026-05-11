/**
 * F8 Phase 6 round-3 I3 fix — unit tests for `seed-demo-members`
 * helper guards.
 *
 * Round-2 C1-test smoke covered the `seedRow()` outcomes (inserted /
 * skipped / repaired-tax-id) end-to-end. This file pins the four
 * pre-flight helpers that are out-of-scope for the smoke test and
 * were originally untested:
 *
 *   - `requireSwechamTenant()` — TENANT_SLUG env-var guard
 *   - `loadPayload()` — JSON file IO + schemaVersion zod parse
 *
 * `findActorUserId()` requires DB so its coverage lives in the
 * integration suite (`tests/integration/scripts/`). `main()` is the
 * orchestration loop covered by the smoke test's per-row assertions.
 */
import { describe, expect, it, afterEach } from 'vitest';

const ORIGINAL_TENANT_SLUG = process.env.TENANT_SLUG;

describe('requireSwechamTenant (Phase 6 round-3 I3)', () => {
  afterEach(() => {
    if (ORIGINAL_TENANT_SLUG === undefined) {
      delete process.env.TENANT_SLUG;
    } else {
      process.env.TENANT_SLUG = ORIGINAL_TENANT_SLUG;
    }
  });

  it('returns swecham TenantContext when TENANT_SLUG=swecham', async () => {
    process.env.TENANT_SLUG = 'swecham';
    const { requireSwechamTenant } = await import(
      '@/../scripts/seed-demo-members'
    );
    const ctx = requireSwechamTenant() as { slug: string };
    expect(ctx.slug).toBe('swecham');
  });

  it('throws when TENANT_SLUG is missing', async () => {
    delete process.env.TENANT_SLUG;
    const { requireSwechamTenant } = await import(
      '@/../scripts/seed-demo-members'
    );
    expect(() => requireSwechamTenant()).toThrow(
      /refusing to run against TENANT_SLUG="".*Set TENANT_SLUG=swecham/s,
    );
  });

  it('throws when TENANT_SLUG is a non-swecham tenant', async () => {
    process.env.TENANT_SLUG = 'test-chamber';
    const { requireSwechamTenant } = await import(
      '@/../scripts/seed-demo-members'
    );
    expect(() => requireSwechamTenant()).toThrow(
      /refusing to run against TENANT_SLUG="test-chamber"/,
    );
  });

  it('throws when TENANT_SLUG is empty string', async () => {
    process.env.TENANT_SLUG = '';
    const { requireSwechamTenant } = await import(
      '@/../scripts/seed-demo-members'
    );
    expect(() => requireSwechamTenant()).toThrow(
      /refusing to run against TENANT_SLUG=""/,
    );
  });
});

describe('loadPayload (Phase 6 round-3 I3)', () => {
  // Round-3 I3: pass an injected reader stub so we never touch the
  // real filesystem. The production callsite uses the default reader
  // that reads `scripts/_demo-data/demo-members.json` via fs/promises.
  const VALID_ROW = {
    companyName: 'Acme Co',
    country: 'TH',
    taxId: null,
    planId: 'regular',
    registrationDate: '2025-01-01',
    status: 'active',
    notes: null,
    billingEmail: null,
    primaryContact: {
      firstName: 'Alice',
      lastName: 'Acme',
      email: 'alice@acme.example',
      phone: null,
      roleTitle: 'CEO',
      preferredLanguage: 'en',
    },
  };

  it('returns parsed payload when JSON matches schema (schemaVersion=1)', async () => {
    const reader = async () =>
      JSON.stringify({
        schemaVersion: 1,
        tenantSlug: 'swecham',
        planYear: 2026,
        rows: [VALID_ROW],
      });
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    const payload = await loadPayload(reader);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.planYear).toBe(2026);
    expect(payload.rows.length).toBe(1);
    expect(payload.rows[0]?.companyName).toBe('Acme Co');
  });

  it('throws operator-friendly error when JSON file is missing', async () => {
    const reader = async () => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    await expect(loadPayload(reader)).rejects.toThrow(
      /demo-members\.json not found.*extract-demo-members\.py/s,
    );
  });

  it('throws schema-mismatch error when schemaVersion is wrong (e.g. 2)', async () => {
    const reader = async () =>
      JSON.stringify({
        schemaVersion: 2,
        tenantSlug: 'swecham',
        planYear: 2026,
        rows: [VALID_ROW],
      });
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    await expect(loadPayload(reader)).rejects.toThrow(/schemaVersion=1/);
  });

  it('throws schema-mismatch error when rows is missing', async () => {
    const reader = async () =>
      JSON.stringify({
        schemaVersion: 1,
        tenantSlug: 'swecham',
        planYear: 2026,
      });
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    await expect(loadPayload(reader)).rejects.toThrow(/schema validation/);
  });

  it('throws schema-mismatch error when planYear is wrong type', async () => {
    const reader = async () =>
      JSON.stringify({
        schemaVersion: 1,
        tenantSlug: 'swecham',
        planYear: 'twenty-twenty-six',
        rows: [VALID_ROW],
      });
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    await expect(loadPayload(reader)).rejects.toThrow(/schema validation/);
  });

  it('throws schema-mismatch error when rows is empty array', async () => {
    const reader = async () =>
      JSON.stringify({
        schemaVersion: 1,
        tenantSlug: 'swecham',
        planYear: 2026,
        rows: [],
      });
    const { loadPayload } = await import('@/../scripts/seed-demo-members');
    await expect(loadPayload(reader)).rejects.toThrow(/schema validation/);
  });
});
