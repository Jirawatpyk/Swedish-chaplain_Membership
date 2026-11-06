/**
 * T064 (F7.1a US2) — Contract test for `manageImageAllowlist` use-case.
 *
 * Verifies add/remove flow per contracts/image-upload.md § 1.3:
 *   - valid hostname add → emits audit with before/after count
 *   - remove default entry → CANNOT_REMOVE_DEFAULT_ALLOWLIST_ENTRY
 *   - wildcard hostname → INVALID_HOSTNAME_FORMAT
 *   - duplicate add → no audit (idempotent no-op)
 *
 * RED-first per Constitution Principle II.
 */
import { describe, expect, it, vi } from 'vitest';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import type {
  ImageAllowlistPort,
  AllowlistEntry,
  Hostname,
} from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import { err, ok } from '@/lib/result';

// PR-review fix 2026-05-20 CR-H1 — use hyphen-form slug (underscore
// rejected at runtime by asTenantContext after manageImageAllowlist
// began wrapping in runInTenant for atomic mutation+audit tx).
const TENANT = 'tenant-swe' as never;
const ACTOR = 'user_admin_42';

interface Overrides {
  addResult?: Awaited<ReturnType<ImageAllowlistPort['add']>>;
  removeResult?: Awaited<ReturnType<ImageAllowlistPort['remove']>>;
  findResultBefore?: AllowlistEntry[];
  findResultAfter?: AllowlistEntry[];
}

const makeDeps = (
  o?: Overrides,
): { port: ImageAllowlistPort; audit: AuditPort } => {
  const before: AllowlistEntry[] =
    o?.findResultBefore ?? [
      { hostname: 'assets.swecham.zyncdata.app' as Hostname, isDefault: true },
      { hostname: 'resend.com' as Hostname, isDefault: true },
    ];
  const after: AllowlistEntry[] =
    o?.findResultAfter ?? [
      ...before,
      { hostname: 'newcdn.example.com' as Hostname, isDefault: false },
    ];
  const findMock = vi.fn();
  findMock.mockResolvedValueOnce(before);
  findMock.mockResolvedValueOnce(after);
  return {
    port: {
      // PR-review fix 2026-05-20 CR-H1 — port mock invokes the fn
      // with a sentinel `null` tx so the use-case logic runs against
      // the port mocks without needing a real DB connection. Mirrors
      // F7 MVP BroadcastsRepo.withTx mock pattern.
      withTx: vi.fn(async <T>(_tenantId: never, fn: (tx: unknown) => Promise<T>) =>
        fn(null),
      ),
      findByTenantId: findMock,
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(o?.addResult ?? ok(undefined)),
      remove: vi.fn().mockResolvedValue(o?.removeResult ?? ok(undefined)),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('manageImageAllowlist contract — T064 (F7.1a US2)', () => {
  it('action=add with valid hostname succeeds + emits audit', async () => {
    const deps = makeDeps();
    const r = await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'add',
      hostname: 'newcdn.example.com',
      requestId: 'req-001',
    });
    expect(r.ok).toBe(true);
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_image_allowlist_updated',
        payload: expect.objectContaining({
          action: 'add',
          hostname: 'newcdn.example.com',
        }),
      }),
    );
  });

  it('remove default entry → cannot_remove_default error, no audit', async () => {
    const deps = makeDeps({
      removeResult: err({ kind: 'cannot_remove_default' }),
    });
    const r = await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'remove',
      hostname: 'assets.swecham.zyncdata.app',
      requestId: 'req-002',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cannot_remove_default');
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('add wildcard hostname rejected (invalid_hostname)', async () => {
    const deps = makeDeps();
    const r = await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'add',
      hostname: '*.example.com',
      requestId: 'req-003',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_hostname');
    expect(deps.port.add).not.toHaveBeenCalled();
  });

  it('audit payload includes beforeCount + afterCount', async () => {
    const deps = makeDeps();
    await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'add',
      hostname: 'newcdn.example.com',
      requestId: 'req-004',
    });
    const call = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call?.payload).toMatchObject({
      action: 'add',
      hostname: 'newcdn.example.com',
      beforeCount: 2,
      afterCount: 3,
    });
  });

  it('does NOT emit audit when port returns duplicate (idempotent)', async () => {
    const deps = makeDeps({ addResult: err({ kind: 'duplicate' }) });
    await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'add',
      hostname: 'assets.swecham.zyncdata.app',
      requestId: 'req-005',
    });
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('seeds platform default hosts on every invocation (C1 verify-run fix)', async () => {
    const deps = makeDeps();
    await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'add',
      hostname: 'newcdn.example.com',
      requestId: 'req-006',
    });
    // Per spec FR-010 + verify-run finding C1, the use-case MUST seed
    // platform-mandated default hosts (resend.com etc.) so a fresh
    // tenant's allowlist is never empty when an admin opens the
    // settings page or a member uploads an inline image.
    expect(deps.port.seedDefaults).toHaveBeenCalledWith(
      TENANT,
      expect.arrayContaining([expect.stringMatching(/resend\.com/)]),
    );
  });

  it('remove not_found emits broadcast_cross_tenant_probe defensively (T128b)', async () => {
    // T128b (F7.1a Phase 6) — defensive cross-tenant probe emit pattern.
    // When port.remove returns `not_found`, the hostname does not exist
    // in the actor's tenant (RLS+FORCE already filtered cross-tenant
    // rows out). Per data-model § 7 + Constitution Principle I sub-clause
    // 4, the use-case MUST emit a forensic probe audit even though the
    // RLS layer absorbed the offending row visibility.
    const deps = makeDeps({
      removeResult: err({ kind: 'not_found' }),
    });
    const r = await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'remove',
      hostname: 'foreign-host.example.com',
      requestId: 'req-probe-007',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');

    // The probe audit fires INSTEAD OF the allowlist_updated audit
    // (no mutation happened — the err short-circuits before the emit
    // at line ~163 of manage-image-allowlist.ts).
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(emitCalls.length).toBeGreaterThanOrEqual(1);
    const probeCall = emitCalls.find(
      (c) => (c[1] as { eventType: string }).eventType === 'broadcast_cross_tenant_probe',
    );
    expect(probeCall).toBeDefined();
    expect(probeCall?.[1]).toMatchObject({
      eventType: 'broadcast_cross_tenant_probe',
      actorUserId: ACTOR,
      tenantId: TENANT,
      payload: expect.objectContaining({
        surface: 'tenant_image_source_allowlist',
        operation: 'remove',
        probedHostname: 'foreign-host.example.com',
        expectedTenantId: TENANT,
      }),
      requestId: 'req-probe-007',
    });
  });

  it('remove cannot_remove_default does NOT emit cross-tenant probe (legitimate state)', async () => {
    // T128b counterpoint — `cannot_remove_default` is a LEGITIMATE
    // rejection (admin tried to remove a platform-default row, blocked
    // by FR-010). It is NOT a cross-tenant probe — the row exists in
    // the actor's own tenant. No forensic emit required.
    const deps = makeDeps({
      removeResult: err({ kind: 'cannot_remove_default' }),
    });
    await manageImageAllowlist(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      action: 'remove',
      hostname: 'resend.com',
      requestId: 'req-default-008',
    });
    // No probe audit — defensive emit is scoped to `not_found` only.
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const probeCall = emitCalls.find(
      (c) => (c[1] as { eventType: string }).eventType === 'broadcast_cross_tenant_probe',
    );
    expect(probeCall).toBeUndefined();
  });

  it('remove not_found + audit.emit THROWS → still returns err(not_found), NO 5xx escalation (H10 atomicity)', async () => {
    // H10 (review finding pr-test-analyzer#1, 2026-05-21) — the T128b
    // probe-emit is best-effort: when `audit.emit` throws inside the
    // catch path, the use-case MUST still return `err({kind:'not_found'})`
    // to the caller (NOT 5xx). A regression removing the try/catch
    // (turning best-effort into hard-fail) would slip through the
    // existing two cases — this test pins the contract.
    //
    // H3 Round 2 enhancement 2026-05-21: also pins
    // `broadcastsMetrics.auditEmitFailed` counter increment so a
    // regression dropping the counter call inside `safeAuditEmit`
    // (which the probe-emit delegates to via `emitCrossTenantProbe`)
    // turns into a hard test failure. The counter is the SLO-alarm
    // source per docs/observability.md § 22.2.
    const { broadcastsMetrics } = await import('@/lib/metrics');
    const metricSpy = vi
      .spyOn(broadcastsMetrics, 'auditEmitFailed')
      .mockImplementation(() => undefined);

    try {
      const deps = makeDeps({
        removeResult: err({ kind: 'not_found' }),
      });
      // Force audit.emit to reject on the probe call. The success-path
      // emit at L163 of manage-image-allowlist.ts never fires because
      // the remove `err` short-circuits before it.
      (deps.audit.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('audit storage down — chaos test'),
      );

      let threw = false;
      let result: Awaited<ReturnType<typeof manageImageAllowlist>> | null = null;
      try {
        result = await manageImageAllowlist(deps, {
          tenantId: TENANT,
          actorUserId: ACTOR,
          action: 'remove',
          hostname: 'foreign-host.example.com',
          requestId: 'req-h10-atomicity',
        });
      } catch {
        threw = true;
      }

      // (a) Use-case did NOT throw — caught the audit failure
      expect(threw).toBe(false);
      // (b) Use-case returned err(not_found) — surfaces as 404 at the route
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.error.kind).toBe('not_found');
      }
      // (c) Audit was attempted (the probe emit fired before throwing)
      expect((deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      // (d) H3 Round 2 — counter incremented with event type + tenant
      expect(metricSpy).toHaveBeenCalledWith(
        'broadcast_cross_tenant_probe',
        TENANT,
      );
    } finally {
      metricSpy.mockRestore();
    }
  });
});
