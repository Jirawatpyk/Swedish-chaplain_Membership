/**
 * Unit tests for `clear-halt.ts` Application use-case (T114).
 *
 * Wave 6 GREEN — Q14 / R3-NEW-3.
 *
 * Strategy: hand-built mocks via DI. The use-case is tiny — happy path
 * + 3 error branches (member_not_found / forbidden / server_error).
 * RBAC is enforced at the route layer; the use-case stays admin-callable
 * for unit testing without the route boundary.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ok, err } from '@/lib/result';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { clearHalt } from '@/modules/broadcasts/application/use-cases/clear-halt';
import type {
  MembersBridgePort,
  MemberHaltError,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/clear-halt.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

function makeAudit(): {
  emits: Array<AuditEmitInput>;
  port: AuditPort;
  throwOnEmit?: boolean;
} {
  const emits: Array<AuditEmitInput> = [];
  return {
    emits,
    port: {
      async emit(_tx, e) {
        emits.push(e);
      },
    },
  };
}

function makeMembersBridge(opts: {
  setHaltResult?: import('@/lib/result').Result<void, MemberHaltError>;
  setHaltThrows?: boolean;
}): {
  port: MembersBridgePort;
  haltCalls: Array<{ memberId: string; halted: boolean }>;
} {
  const haltCalls: Array<{ memberId: string; halted: boolean }> = [];
  return {
    haltCalls,
    port: {
      async getMembersBySegment() {
        return [];
      },
      async getMemberPrimaryContact() {
        return null;
      },
      async lookupContactEmailInTenant() {
        return null;
      },
      async lookupMemberPrimaryContactEmailInTenant() {
        return null;
      },
      async getMembersHaltedInTenant() {
        return [];
      },
      async setMemberHalt(_ctx, memberId, halted) {
        haltCalls.push({ memberId, halted });
        if (opts.setHaltThrows) throw new Error('db down');
        return opts.setHaltResult ?? ok(undefined);
      },
      async markBroadcastsAcknowledged() {
        return ok(undefined);
      },
    },
  };
}

const baseInput = {
  memberId: 'm-42',
  actorUserId: 'admin-7',
  requestId: 'req-clear-halt',
} as const;

const clock = { now: (): Date => FROZEN_NOW };

describe('clear-halt — Wave 6 GREEN (T114)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy: setMemberHalt(memberId, false) called → broadcast_member_dispatch_resumed audit emitted', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({});
    const result = await clearHalt(
      {
        tenant,
        membersBridge: bridge.port,
        audit: audit.port,
        clock,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(bridge.haltCalls).toEqual([{ memberId: 'm-42', halted: false }]);
    const evt = audit.emits.find(
      (e) => e.eventType === 'broadcast_member_dispatch_resumed',
    );
    expect(evt).toBeDefined();
    if (result.ok) {
      expect(result.value.memberId).toBe('m-42');
      expect(result.value.clearedAt).toEqual(FROZEN_NOW);
    }
  });

  it('audit payload contains memberId + clearedByUserId + clearedAt', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({});
    await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    const evt = audit.emits.find(
      (e) => e.eventType === 'broadcast_member_dispatch_resumed',
    );
    expect(evt?.payload).toMatchObject({
      memberId: 'm-42',
      clearedByUserId: 'admin-7',
      clearedAt: FROZEN_NOW.toISOString(),
    });
    expect(evt?.actorUserId).toBe('admin-7');
    expect(evt?.requestId).toBe('req-clear-halt');
    expect(evt?.tenantId).toBe('test-tenant');
  });

  it('rejects when member not found in tenant → member_not_found', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({
      setHaltResult: err({
        kind: 'member_halt.member_not_found',
        memberId: 'm-42',
      }),
    });
    const result = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('member_not_found');
      if (result.error.kind === 'member_not_found') {
        expect(result.error.memberId).toBe('m-42');
      }
    }
    // No audit on failure
    expect(audit.emits).toHaveLength(0);
  });

  it('forbidden bridge error → forbidden with reason kind', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({
      setHaltResult: err({
        kind: 'member_halt.unauthorized',
        actorRole: 'manager',
      }),
    });
    const result = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('forbidden');
      if (result.error.kind === 'forbidden') {
        expect(result.error.reason).toBe('member_halt.unauthorized');
      }
    }
  });

  it('admin role allowed (happy path covers it — bridge does not gate by role)', async () => {
    // Use-case stays admin-callable; route-layer authz is integration-level.
    // This test re-asserts that no extra authz check exists in-use-case.
    const audit = makeAudit();
    const bridge = makeMembersBridge({});
    const result = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  it('clear-halt is idempotent — bridge no-op on already-not-halted still resolves ok', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({ setHaltResult: ok(undefined) });
    const r1 = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    const r2 = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(bridge.haltCalls).toHaveLength(2);
    expect(audit.emits).toHaveLength(2);
  });

  it('membersBridge.setMemberHalt throws → clear_halt.server_error', async () => {
    const audit = makeAudit();
    const bridge = makeMembersBridge({ setHaltThrows: true });
    const result = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('clear_halt.server_error');
      if (result.error.kind === 'clear_halt.server_error') {
        expect(result.error.message).toBe('db down');
      }
    }
  });

  it('audit emit failure does NOT 5xx the request (best-effort branch)', async () => {
    const bridge = makeMembersBridge({});
    const auditPort: AuditPort = {
      async emit() {
        throw new Error('audit table down');
      },
    };
    const result = await clearHalt(
      { tenant, membersBridge: bridge.port, audit: auditPort, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memberId).toBe('m-42');
  });
});
