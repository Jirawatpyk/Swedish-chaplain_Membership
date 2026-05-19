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

const TENANT = 'tenant_swe' as never;
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
      findByTenantId: findMock,
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(o?.addResult ?? ok(undefined)),
      remove: vi.fn().mockResolvedValue(o?.removeResult ?? ok(undefined)),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
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
});
