/**
 * T087 (F7.1a US7) — Contract test for `updateBroadcastTemplate` use-case.
 *
 * Verifies admin edit per contracts/broadcast-template.md § 1.2:
 *   - port.update called + audit broadcast_template_updated with
 *     before/after value
 *   - Cross-tenant probe (templateId belongs to tenant B) → not_found +
 *     broadcast_cross_tenant_probe audit (RLS confines to tenant A's slice)
 *   - Updating to a non-allowlisted img → template_body_unsafe
 *
 * RED-first per Constitution Principle II. GREEN at Phase 5D T100.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { ValidateImageSourceAllowlistDeps } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import { ok, err } from '@/lib/result';

const TENANT = 'tenant-swe' as never;
const ACTOR_ADMIN = 'user_admin_42';

const dynImport = new Function('m', 'return import(m)') as <T = unknown>(
  modulePath: string,
) => Promise<T>;

interface UpdateBroadcastTemplateModule {
  readonly updateBroadcastTemplate: (
    deps: {
      readonly port: BroadcastTemplatesPort;
      readonly audit: AuditPort;
      readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
    },
    input: {
      readonly tenantId: typeof TENANT;
      readonly actorUserId: string;
      readonly templateId: string;
      readonly name?: string;
      readonly subject?: string;
      readonly bodyHtml?: string;
      readonly requestId: string;
    },
  ) => Promise<
    | { ok: true; value: { templateId: string } }
    | { ok: false; error: { kind: string; [key: string]: unknown } }
  >;
}

const NOW = new Date('2026-05-20T03:00:00Z');
const TEMPLATE_ID = '22222222-2222-2222-2222-222222222222';

const makeTemplate = (overrides?: Partial<BroadcastTemplate>): BroadcastTemplate => ({
  id: TEMPLATE_ID,
  tenantId: TENANT,
  name: 'Monthly Newsletter',
  subject: 'Old Subject',
  bodyHtml: '<p>Old body</p>',
  locale: 'en',
  startedFromCount: 5,
  isSeeded: false,
  createdByUserId: ACTOR_ADMIN,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const makeDeps = (overrides?: {
  existingTemplate?: BroadcastTemplate | null;
  updateResult?: Awaited<ReturnType<BroadcastTemplatesPort['update']>>;
}): {
  port: BroadcastTemplatesPort;
  audit: AuditPort;
  validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
} => {
  const existing = overrides?.existingTemplate ?? makeTemplate();
  const port: BroadcastTemplatesPort = {
    findById: vi.fn().mockResolvedValue(existing),
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi
      .fn()
      .mockResolvedValue(overrides?.updateResult ?? ok(makeTemplate({ name: 'Updated' }))),
    softDelete: vi.fn(),
    incrementStartedFromCount: vi.fn(),
    withTx: vi.fn(
      async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
    ),
  } as BroadcastTemplatesPort;
  return {
    port,
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
    validateImageSourceAllowlist: {
      allowlistPort: {
        findByTenantId: vi.fn().mockResolvedValue([
          { hostname: 'assets.swecham.zyncdata.app', isDefault: true },
        ]),
        withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) =>
          fn(null),
        ),
        seedDefaults: vi.fn().mockResolvedValue(undefined),
        add: vi.fn(),
        remove: vi.fn(),
      } as never,
      audit: { emit: vi.fn().mockResolvedValue(undefined) },
    },
  };
};

describe('updateBroadcastTemplate contract — T087 (F7.1a US7)', () => {
  it('admin updates name → port.update called + audit with before/after', async () => {
    const mod = await dynImport<UpdateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/update-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.updateBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      name: 'New Name',
      requestId: 'req-010',
    });
    expect(r.ok).toBe(true);
    expect(deps.port.update).toHaveBeenCalledWith(
      TENANT,
      TEMPLATE_ID,
      expect.objectContaining({ name: 'New Name' }),
      expect.anything(),
    );
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { eventType: string; payload: Record<string, unknown> };
    expect(auditCall.eventType).toBe('broadcast_template_updated');
    expect(auditCall.payload).toMatchObject({
      templateId: TEMPLATE_ID,
      before: expect.objectContaining({ name: 'Monthly Newsletter' }),
      after: expect.objectContaining({ name: 'New Name' }),
    });
  });

  it('cross-tenant probe (template belongs to tenant B) → not_found + cross-tenant audit', async () => {
    const mod = await dynImport<UpdateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/update-broadcast-template',
    );
    // RLS+FORCE filters tenant B's row out for tenant A context →
    // findById returns null which the use-case translates to not_found
    // and emits broadcast_cross_tenant_probe.
    const deps = makeDeps({ existingTemplate: null });
    const r = await mod.updateBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      name: 'IshouldNotExist',
      requestId: 'req-011',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    // Cross-tenant probe audit emitted on null findById (Principle I)
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_cross_tenant_probe' }),
    );
  });

  it('update body with non-allowlisted <img src> → template_body_unsafe', async () => {
    const mod = await dynImport<UpdateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/update-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.updateBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      bodyHtml: '<p><img src="https://evil.com/x.png" /></p>',
      requestId: 'req-012',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_body_unsafe');
    expect(deps.port.update).not.toHaveBeenCalled();
  });

  it('update on non-existent template (port returns not_found) → not_found', async () => {
    const mod = await dynImport<UpdateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/update-broadcast-template',
    );
    const deps = makeDeps({
      // simulate the case where findById sees the row but a concurrent
      // delete removed it before the UPDATE — port.update returns
      // not_found
      updateResult: err({ kind: 'not_found' }),
    });
    const r = await mod.updateBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      name: 'X',
      requestId: 'req-013',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('subject longer than 200 → invalid_input', async () => {
    const mod = await dynImport<UpdateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/update-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.updateBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      subject: 'x'.repeat(201),
      requestId: 'req-014',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(deps.port.update).not.toHaveBeenCalled();
  });
});
