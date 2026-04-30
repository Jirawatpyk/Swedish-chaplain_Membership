/**
 * Wave 6b — Unit tests for `enforce-tenant-context.ts` Application helper.
 *
 * Cross-tenant probe defence (FR-037). When a route handler resolves a
 * broadcast and the row's tenant differs from the caller's tenant, this
 * helper:
 *   1. Emits cross-tenant probe audit on a separate tx (best-effort)
 *   2. Returns Result.err — caller maps to 404 (NOT 403, to avoid
 *      leaking existence of other tenants' rows)
 *
 * Two probe variants:
 *   - `broadcast_cross_member_probe` — when memberId is provided (member
 *     is probing another member's broadcast in their own tenant or someone
 *     else's tenant)
 *   - `broadcast_cross_tenant_probe` — when memberId is null (admin-side
 *     probe across tenants)
 */
import { describe, expect, it } from 'vitest';
import { enforceTenantContext } from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';

const callerTenant = asTenantContext('tenant-a');

function makeAudit(throwOnEmit = false): {
  readonly emits: Array<AuditEmitInput>;
  readonly port: AuditPort;
} {
  const emits: Array<AuditEmitInput> = [];
  return {
    emits,
    port: {
      async emit(_tx, event) {
        if (throwOnEmit) throw new Error('audit DB unreachable');
        emits.push(event);
      },
    },
  };
}

describe('enforce-tenant-context — Wave 6b', () => {
  // ---- Same-tenant happy path ---------------------------------------

  it('same tenant → ok(true) without audit emit', async () => {
    const audit = makeAudit();
    const result = await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: callerTenant.slug,
        broadcastId: 'b-1',
        actorUserId: 'u-1',
        memberId: 'm-1',
        requestId: 'req-1',
      },
    );
    expect(result.ok).toBe(true);
    expect(audit.emits).toHaveLength(0);
  });

  // ---- Cross-tenant probes ------------------------------------------

  it('different tenant + memberId !== null → broadcast_cross_member_probe audit', async () => {
    const audit = makeAudit();
    const result = await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: 'tenant-b',
        broadcastId: 'b-leak',
        actorUserId: 'u-attacker',
        memberId: 'm-attacker',
        requestId: 'req-2',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_cross_tenant_probe');
      expect(result.error.observedTenantId).toBe('tenant-b');
      expect(result.error.expectedTenantId).toBe(callerTenant.slug);
    }
    expect(audit.emits).toHaveLength(1);
    expect(audit.emits[0]!.eventType).toBe('broadcast_cross_member_probe');
    expect(audit.emits[0]!.payload['broadcastId']).toBe('b-leak');
    expect(audit.emits[0]!.payload['observedTenantId']).toBe('tenant-b');
  });

  it('different tenant + memberId === null → broadcast_cross_tenant_probe audit', async () => {
    const audit = makeAudit();
    const result = await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: 'tenant-c',
        broadcastId: 'b-leak',
        actorUserId: 'admin-1',
        memberId: null,
        requestId: 'req-3',
      },
    );
    expect(result.ok).toBe(false);
    expect(audit.emits).toHaveLength(1);
    expect(audit.emits[0]!.eventType).toBe('broadcast_cross_tenant_probe');
  });

  // ---- Audit failure swallowed --------------------------------------

  it('audit emit failure does NOT 5xx the request — returns probe error anyway', async () => {
    const audit = makeAudit(true);
    const result = await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: 'tenant-b',
        broadcastId: 'b-x',
        actorUserId: 'u-1',
        memberId: 'm-1',
        requestId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_cross_tenant_probe');
    }
    // emits remain empty because the throwing port never appended
    expect(audit.emits).toHaveLength(0);
  });

  // ---- requestId passthrough ----------------------------------------

  it('requestId is forwarded to the audit emission', async () => {
    const audit = makeAudit();
    await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: 'tenant-b',
        broadcastId: 'b-1',
        actorUserId: 'u-1',
        memberId: 'm-1',
        requestId: 'unique-req-id',
      },
    );
    expect(audit.emits[0]!.requestId).toBe('unique-req-id');
  });

  it('null requestId passes through to audit emission', async () => {
    const audit = makeAudit();
    await enforceTenantContext(
      { tenant: callerTenant, audit: audit.port },
      {
        observedTenantId: 'tenant-b',
        broadcastId: 'b-1',
        actorUserId: 'u-1',
        memberId: null,
        requestId: null,
      },
    );
    expect(audit.emits[0]!.requestId).toBeNull();
  });
});
