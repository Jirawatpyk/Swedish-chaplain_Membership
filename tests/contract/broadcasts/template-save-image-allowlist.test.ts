/**
 * T091 (F7.1a US7) — Contract test for template save image-allowlist
 * enforcement per critique E9 + FR-017.
 *
 * Verifies templates carrying <img> tags are validated against the
 * tenant allowlist at SAVE time (same rules as broadcast submit — no
 * bypass possible via template authoring).
 *
 * RED-first per Constitution Principle II. GREEN at Phase 5D T099+T100
 * (create + update both pipe through validateImageSourceAllowlist).
 */
import { describe, expect, it, vi } from 'vitest';
import { createBroadcastTemplate } from '@/modules/broadcasts/application/use-cases/create-broadcast-template';
import type { BroadcastTemplatesPort } from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type {
  ImageAllowlistPort,
  AllowlistEntry,
  Hostname,
} from '@/modules/broadcasts/application/ports/image-allowlist-port';
import { ok } from '@/lib/result';

const TENANT = 'tenant-swe' as never;
const ACTOR_ADMIN = 'user_admin_42';

const ALLOWED_HOST = 'assets.swecham.zyncdata.app' as Hostname;
const ALLOWLIST: AllowlistEntry[] = [
  { hostname: ALLOWED_HOST, isDefault: true },
  { hostname: 'resend.com' as Hostname, isDefault: true },
];

const makeDeps = (allowlist: readonly AllowlistEntry[] = ALLOWLIST): {
  port: BroadcastTemplatesPort;
  audit: AuditPort;
  validateImageSourceAllowlist: {
    allowlistPort: ImageAllowlistPort;
    audit: AuditPort;
  };
} => ({
  port: {
    findById: vi.fn().mockResolvedValue(null),
    findByIdAllowDeletedInTx: vi.fn().mockResolvedValue(null),
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(
      ok({
        id: '11111111-1111-1111-1111-111111111111',
        tenantId: TENANT,
        name: 'X',
        subject: 'X',
        bodyHtml: 'X',
        locale: 'en',
        startedFromCount: 0,
        isSeeded: false,
        createdByUserId: ACTOR_ADMIN,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }),
    ),
    update: vi.fn(),
    softDelete: vi.fn(),
    incrementStartedFromCount: vi.fn(),
    withTx: vi.fn(
      async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
    ),
  } as BroadcastTemplatesPort,
  audit: { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) },
  validateImageSourceAllowlist: {
    allowlistPort: {
      findByTenantId: vi.fn().mockResolvedValue(allowlist),
      withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) =>
        fn(null),
      ),
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      remove: vi.fn(),
    } as ImageAllowlistPort,
    audit: { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) },
  },
});

describe('template save image-allowlist enforcement — T091 (F7.1a US7)', () => {
  it('template body with allowlisted <img src> hostname → save succeeds', async () => {
const deps = makeDeps();
    const r = await createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'WithImage',
      subject: 'Hello',
      bodyHtml: `<p><img src="https://${ALLOWED_HOST}/banner.png" alt="banner" /></p>`,
      locale: 'en',
      requestId: 'req-040',
    });
    expect(r.ok).toBe(true);
    expect(deps.port.create).toHaveBeenCalled();
  });

  it('template body with non-allowlisted <img src> → template_body_unsafe', async () => {
const deps = makeDeps();
    const r = await createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'WithBadImage',
      subject: 'Hello',
      bodyHtml: '<p><img src="https://evil.example.com/payload.png" /></p>',
      locale: 'en',
      requestId: 'req-041',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('template_body_unsafe');
      if (r.error.kind === 'template_body_unsafe') {
        expect(r.error.unsafeImageSources).toContain(
          'https://evil.example.com/payload.png',
        );
      }
    }
    expect(deps.port.create).not.toHaveBeenCalled();
  });

  it('template body with MIXED allowed + non-allowed → rejected with only the offending sources', async () => {
const deps = makeDeps();
    const r = await createBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      name: 'MixedImages',
      subject: 'Hello',
      bodyHtml: `<p><img src="https://${ALLOWED_HOST}/ok.png" /><img src="https://evil.example.com/bad.png" /></p>`,
      locale: 'en',
      requestId: 'req-042',
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'template_body_unsafe') {
      expect(r.error.unsafeImageSources).toEqual(['https://evil.example.com/bad.png']);
    }
  });
});
