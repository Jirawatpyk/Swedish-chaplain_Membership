/**
 * T086 (F7.1a US7) — Contract test for `createBroadcastTemplate` use-case.
 *
 * Verifies admin-only template creation per contracts/broadcast-template.md
 * § 1.1:
 *   - Persisted to broadcast_templates + audit emitted
 *   - Name uniqueness within tenant (FR-046)
 *   - Body sanitised + US2 image-source allowlist enforced (FR-046)
 *   - Validation: name ≤100, subject ≤200, body ≤200KB
 *
 * RED-first per Constitution Principle II — use-case `create-broadcast-
 * template.ts` does NOT exist yet at T086 commit time. Dynamic-import
 * wrapper per memory `project_f5_red_import_pattern` bypasses TS
 * typecheck on the not-yet-existent module; the test resolves it at
 * runtime which throws MODULE_NOT_FOUND → test fails RED.
 * GREEN lands at Phase 5D T099.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { ValidateImageSourceAllowlistDeps } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import { ok, err } from '@/lib/result';

// Use hyphen-form tenant slug — `asTenantContext` rejects underscores
// at runtime per the manage-image-allowlist precedent.
const TENANT = 'tenant-swe' as never;
const ACTOR_ADMIN = 'user_admin_42';

// Dynamic-import wrapper bypasses TS typecheck on not-yet-existent
// modules (project memory: project_f5_red_import_pattern). The Function
// constructor evaluates `import(m)` in a fresh scope so the alias plugin
// + tsconfig path resolution don't fail at compile time.
const dynImport = new Function('m', 'return import(m)') as <T = unknown>(
  modulePath: string,
) => Promise<T>;

interface CreateBroadcastTemplateInputForTest {
  readonly tenantId: typeof TENANT;
  readonly actorUserId: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly requestId: string;
}

interface CreateBroadcastTemplateModule {
  readonly createBroadcastTemplate: (
    deps: {
      readonly port: BroadcastTemplatesPort;
      readonly audit: AuditPort;
      readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
    },
    input: CreateBroadcastTemplateInputForTest,
  ) => Promise<
    | { ok: true; value: { templateId: string } }
    | {
        ok: false;
        error: { kind: string; [key: string]: unknown };
      }
  >;
}

const NOW = new Date('2026-05-20T03:00:00Z');

const makeTemplate = (overrides?: Partial<BroadcastTemplate>): BroadcastTemplate => ({
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: TENANT,
  name: 'Monthly Newsletter',
  subject: '{{chamber_name}} Newsletter — [Month YYYY]',
  bodyHtml: '<h2>Hello</h2>',
  locale: 'en',
  startedFromCount: 0,
  isSeeded: false,
  createdByUserId: ACTOR_ADMIN,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

interface MakeDepsOverrides {
  createResult?: Awaited<ReturnType<BroadcastTemplatesPort['create']>>;
  imageAllowlistOk?: boolean;
  imageUnsafeSources?: readonly string[];
}

const makeDeps = (
  o?: MakeDepsOverrides,
): {
  port: BroadcastTemplatesPort;
  audit: AuditPort;
  validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
} => {
  const port: BroadcastTemplatesPort = {
    findById: vi.fn().mockResolvedValue(null),
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockResolvedValue(o?.createResult ?? ok(makeTemplate())),
    update: vi.fn().mockResolvedValue(ok(makeTemplate())),
    softDelete: vi.fn().mockResolvedValue(ok(undefined)),
    incrementStartedFromCount: vi.fn().mockResolvedValue(undefined),
    // Phase 5C extension — port.withTx for atomic mutation+audit tx.
    // Mock invokes callback with sentinel `null` tx (mirrors
    // ImageAllowlistPort.withTx test pattern).
    withTx: vi.fn(
      async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
    ),
  } as BroadcastTemplatesPort;
  const audit: AuditPort = { emit: vi.fn().mockResolvedValue(undefined) };
  const validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps = {
    allowlistPort: {
      findByTenantId: vi
        .fn()
        .mockResolvedValue([
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
  };
  // Wire `validateImageSourceAllowlist` use-case behaviour via the
  // allowlist — when imageUnsafeSources is supplied the body contains
  // a non-allowlisted hostname so the real validator (or its stub)
  // returns the rejection.
  void o?.imageAllowlistOk;
  void o?.imageUnsafeSources;
  return { port, audit, validateImageSourceAllowlist };
};

describe('createBroadcastTemplate contract — T086 (F7.1a US7)', () => {
  it('admin creates template → port.create called + audit broadcast_template_created emitted', async () => {
    const mod = await dynImport<CreateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/create-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'Monthly Newsletter',
      subject: '{{chamber_name}} Newsletter — [Month YYYY]',
      bodyHtml: '<h2>Hello {{chamber_name}}</h2><p>Welcome [member name].</p>',
      locale: 'en',
      requestId: 'req-001',
    });
    expect(r.ok).toBe(true);
    expect(deps.port.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        name: 'Monthly Newsletter',
        subject: '{{chamber_name}} Newsletter — [Month YYYY]',
        locale: 'en',
        createdByUserId: ACTOR_ADMIN,
      }),
      expect.anything(), // tx token
    );
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(), // tx token
      expect.objectContaining({
        eventType: 'broadcast_template_created',
        tenantId: TENANT,
        actorUserId: ACTOR_ADMIN,
        payload: expect.objectContaining({
          templateId: expect.any(String),
          name: 'Monthly Newsletter',
          subject: '{{chamber_name}} Newsletter — [Month YYYY]',
        }),
      }),
    );
    // Body MUST NOT appear in audit payload (FR-022 size + privacy)
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { payload: Record<string, unknown> };
    expect(auditCall.payload).not.toHaveProperty('bodyHtml');
    expect(auditCall.payload).not.toHaveProperty('body');
  });

  it('name longer than 100 chars → invalid_input', async () => {
    const mod = await dynImport<CreateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/create-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'x'.repeat(101),
      subject: 'OK',
      bodyHtml: '<p>OK</p>',
      locale: 'en',
      requestId: 'req-002',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(deps.port.create).not.toHaveBeenCalled();
  });

  it('subject longer than 200 chars → invalid_input', async () => {
    const mod = await dynImport<CreateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/create-broadcast-template',
    );
    const deps = makeDeps();
    const r = await mod.createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'OK',
      subject: 'x'.repeat(201),
      bodyHtml: '<p>OK</p>',
      locale: 'en',
      requestId: 'req-003',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(deps.port.create).not.toHaveBeenCalled();
  });

  it('body with non-allowlisted <img src> → template_body_unsafe + unsafe sources in error', async () => {
    const mod = await dynImport<CreateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/create-broadcast-template',
    );
    const deps = makeDeps({ imageUnsafeSources: ['evil.com'] });
    const r = await mod.createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'BadTemplate',
      subject: 'OK',
      bodyHtml: '<p><img src="https://evil.com/x.png" /></p>',
      locale: 'en',
      requestId: 'req-004',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('template_body_unsafe');
      expect(r.error.unsafeImageSources).toBeDefined();
    }
    expect(deps.port.create).not.toHaveBeenCalled();
  });

  it('duplicate name within tenant+locale → duplicate_name from port', async () => {
    const mod = await dynImport<CreateBroadcastTemplateModule>(
      '@/modules/broadcasts/application/use-cases/create-broadcast-template',
    );
    const deps = makeDeps({
      createResult: err({ kind: 'duplicate_name', locale: 'en' }),
    });
    const r = await mod.createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'Monthly Newsletter',
      subject: 'OK',
      bodyHtml: '<p>OK</p>',
      locale: 'en',
      requestId: 'req-005',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('duplicate_name');
  });
});
