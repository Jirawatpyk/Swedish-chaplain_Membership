/**
 * F8 Phase 2 Wave G · T054 — composition root + HMAC adapter sanity.
 *
 * Pins the wiring shape so a future refactor can't silently drop a
 * surface (e.g. token signer adapter swap leaving verifier broken).
 * Includes a real HMAC round-trip across the signer + verifier pair.
 */
import { describe, expect, it } from 'vitest';
import {
  makeRenewalsDeps,
  f8OnPaidCallbacks,
} from '@/modules/renewals/infrastructure/renewals-deps';
import { buildPayload } from '@/modules/renewals/domain/renewal-link-token';

describe('makeRenewalsDeps composition root (T054)', () => {
  it('returns a deps object with the wired Wave G surface', () => {
    const deps = makeRenewalsDeps('test-swecham');
    expect(deps.tenant.slug).toBe('test-swecham');
    expect(typeof deps.scheduledPlanChangeRepo).toBe('object');
    expect(typeof deps.auditEmitter.emit).toBe('function');
    expect(typeof deps.auditEmitter.emitInTx).toBe('function');
    expect(typeof deps.tokenSigner.sign).toBe('function');
    expect(typeof deps.tokenVerifier.verify).toBe('function');
    expect(typeof deps.eventAttendees.isAvailable).toBe('function');
    expect(typeof deps.eventAttendees.listAttendances).toBe('function');
  });

  it('binds a fresh tenant context per call', () => {
    const a = makeRenewalsDeps('tenant-a');
    const b = makeRenewalsDeps('tenant-b');
    expect(a.tenant.slug).toBe('tenant-a');
    expect(b.tenant.slug).toBe('tenant-b');
    expect(a.tenant.slug).not.toBe(b.tenant.slug);
  });

  it('eventAttendees stub returns isAvailable=false (FR-029a fallback)', () => {
    const deps = makeRenewalsDeps('test-swecham');
    expect(deps.eventAttendees.isAvailable()).toBe(false);
  });

  it('eventAttendees stub returns [] for any (tenant, member)', async () => {
    const deps = makeRenewalsDeps('test-swecham');
    expect(await deps.eventAttendees.listAttendances('test-swecham', 'mem-1')).toEqual([]);
  });
});

describe('f8OnPaidCallbacks (Phase 5 wired — T123 markCycleCompleteFromInvoicePaid + Phase 7 T183 apply-pending-tier-upgrade)', () => {
  it('returns the F8 cycle-complete + tier-upgrade-apply callbacks (2 entries)', () => {
    const callbacks = f8OnPaidCallbacks('any-tenant');
    expect(callbacks).toHaveLength(2);
    expect(typeof callbacks[0]).toBe('function');
    expect(typeof callbacks[1]).toBe('function');
  });
});

describe('renewal-link-token HMAC round-trip (T048 + T054)', () => {
  it('sign → verify round-trips for a fresh payload (primary key)', () => {
    const deps = makeRenewalsDeps('test-swecham');
    const now = new Date('2026-05-04T12:00:00Z');
    const payload = buildPayload({
      tenantId: 'test-swecham',
      memberId: 'mem-1',
      cycleId: 'cyc-1',
      now,
    });
    const signed = deps.tokenSigner.sign(payload);
    expect(signed.token.startsWith('v1.')).toBe(true);
    expect(signed.tokenSha256.byteLength).toBe(32);

    const verified = deps.tokenVerifier.verify(signed.token, {
      expectedTenantId: 'test-swecham',
      now,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.payload.mid).toBe('mem-1');
      expect(verified.value.payload.cid).toBe('cyc-1');
      expect(verified.value.verifiedWith).toBe('primary');
    }
  });

  it('rejects malformed token shape', () => {
    const deps = makeRenewalsDeps('test-swecham');
    const r = deps.tokenVerifier.verify('not-a-valid-token', {
      expectedTenantId: 'test-swecham',
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed_token');
  });

  it('rejects tampered MAC', () => {
    const deps = makeRenewalsDeps('test-swecham');
    const now = new Date('2026-05-04T12:00:00Z');
    const payload = buildPayload({
      tenantId: 'test-swecham',
      memberId: 'mem-1',
      cycleId: 'cyc-1',
      now,
    });
    const signed = deps.tokenSigner.sign(payload);
    // Replace last 5 chars of the MAC with a string of identical
    // length but different bytes — still passes the v1.x.y shape but
    // fails HMAC verification.
    const tampered =
      signed.token.slice(0, signed.token.length - 5) + 'XXXXX';
    const r = deps.tokenVerifier.verify(tampered, {
      expectedTenantId: 'test-swecham',
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('signature_mismatch');
  });

  it('rejects token signed for a different tenant', () => {
    const deps = makeRenewalsDeps('test-swecham');
    const now = new Date('2026-05-04T12:00:00Z');
    const payload = buildPayload({
      tenantId: 'test-swecham',
      memberId: 'mem-1',
      cycleId: 'cyc-1',
      now,
    });
    const signed = deps.tokenSigner.sign(payload);
    const r = deps.tokenVerifier.verify(signed.token, {
      expectedTenantId: 'other-tenant',
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'tenant_mismatch') {
      expect(r.error.expectedTenantId).toBe('other-tenant');
      expect(r.error.tokenTenantId).toBe('test-swecham');
    }
  });

  it('rejects expired token (now > exp)', () => {
    const deps = makeRenewalsDeps('test-swecham');
    const issuedAt = new Date('2026-05-04T12:00:00Z');
    const farFuture = new Date('2026-07-04T12:00:00Z'); // +60 days, past 30d TTL
    const payload = buildPayload({
      tenantId: 'test-swecham',
      memberId: 'mem-1',
      cycleId: 'cyc-1',
      now: issuedAt,
    });
    const signed = deps.tokenSigner.sign(payload);
    const r = deps.tokenVerifier.verify(signed.token, {
      expectedTenantId: 'test-swecham',
      now: farFuture,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('expired');
  });
});
