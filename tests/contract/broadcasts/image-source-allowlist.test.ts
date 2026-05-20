/**
 * T062 (F7.1a US2) — Contract test for `validateImageSourceAllowlist`.
 *
 * Verifies the Application use-case wired against fake ports honours
 * the contracts/image-upload.md § 1.2 spec:
 *   - allowlisted hosts: returns ok
 *   - non-allowlisted hosts: returns err with ALL unsafe srcs
 *     accumulated (FR-011 "highlight all at once" UX)
 *   - emits `broadcast_body_image_source_unsafe` audit on rejection
 *   - audit payload carries unsafeImageSources ONLY (never body)
 *
 * RED-first per Constitution Principle II.
 */
import { describe, expect, it, vi } from 'vitest';
import { validateImageSourceAllowlist } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import type {
  ImageAllowlistPort,
  AllowlistEntry,
  Hostname,
} from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant_swe' as never;
const ACTOR = 'user_admin_42';

const makeDeps = (
  hosts: string[],
): {
  allowlistPort: ImageAllowlistPort;
  audit: AuditPort;
} => {
  const entries: AllowlistEntry[] = hosts.map((h) => ({
    hostname: h as Hostname,
    isDefault: false,
  }));
  return {
    allowlistPort: {
      // CR-H1 port shape — mock invokes fn(null) so use-case runs
      // without DB.
      withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) =>
        fn(null),
      ),
      findByTenantId: vi.fn().mockResolvedValue(entries),
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      remove: vi.fn(),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('validateImageSourceAllowlist contract — T062 (F7.1a US2)', () => {
  it('returns ok when ALL <img src> hostnames are allowlisted', async () => {
    const deps = makeDeps(['cdn.example.com']);
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<p>x<img src="https://cdn.example.com/a.png" alt="ok"></p>',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-001',
    });
    expect(result.ok).toBe(true);
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('returns err with ALL unsafe srcs accumulated', async () => {
    const deps = makeDeps(['cdn.example.com']);
    const html = [
      '<img src="https://attacker1.com/track.gif">',
      '<img src="https://cdn.example.com/ok.png">',
      '<img src="https://attacker2.com/bad.png">',
    ].join('');
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: html,
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-002',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unsafeImageSources).toEqual([
        'https://attacker1.com/track.gif',
        'https://attacker2.com/bad.png',
      ]);
    }
  });

  it('emits broadcast_body_image_source_unsafe audit on rejection', async () => {
    const deps = makeDeps([]);
    await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="https://x.com/y.png">',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-003',
    });
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_body_image_source_unsafe',
        actorUserId: ACTOR,
        tenantId: TENANT,
        payload: expect.objectContaining({
          unsafeImageSources: ['https://x.com/y.png'],
        }),
      }),
    );
  });

  it('does NOT emit audit when body has no <img>', async () => {
    const deps = makeDeps(['cdn.example.com']);
    await validateImageSourceAllowlist(deps, {
      bodyHtml: '<p>hello world</p>',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-004',
    });
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('does NOT include body content in audit payload (privacy invariant)', async () => {
    const deps = makeDeps([]);
    await validateImageSourceAllowlist(deps, {
      bodyHtml:
        '<p>SECRET DRAFT TEXT<img src="https://x.com/y.png"></p>',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-005',
    });
    const call = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(call)).not.toContain('SECRET DRAFT TEXT');
  });

  it('treats malformed src as unsafe', async () => {
    const deps = makeDeps(['cdn.example.com']);
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="not a url">',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-006',
    });
    expect(result.ok).toBe(false);
  });

  it('treats uppercase-host URL as unsafe (R4-L3 — corrected comment scope)', async () => {
    // PR-review fix R4-L3 (Round 4 2026-05-21) — corrected comment:
    // Node's URL parser auto-lowercases the hostname BEFORE asHostname
    // sees the value, so `EXAMPLE.com` becomes `example.com` and the
    // asHostname regex actually PASSES. This test pins the "uppercase
    // raw input → unsafe via allowlist-miss" path, NOT the literal
    // asHostname-err branch the original Phase D comment claimed.
    //
    // The asHostname-err branch (hostnames that survive
    // `.toLowerCase()` but fail RFC-1035) is structurally unreachable
    // in production because URL parser normalisation strips any
    // such characters first. Branch remains defensive but dead-code-
    // equivalent given the lowercase normalisation upstream.
    const deps = makeDeps(['cdn.example.com']);
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="https://EXAMPLE.com/x.png">',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-007u',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unsafeImageSources).toContain(
        'https://EXAMPLE.com/x.png',
      );
    }
  });

  it('allowlist change is visible to next submit within the same call (Scenario 3 propagation — verify-run G1 closure)', async () => {
    // Acceptance Scenario 3 asserts "subsequent submissions validate
    // against the new allowlist within ≤60 seconds of save". The
    // implementation reads the allowlist on every submit (no cache),
    // so propagation is effectively zero and trivially under 60s.
    // This test pins the no-cache invariant: if a future change adds
    // caching, the test breaks unless propagation stays sub-60s.
    const allowlistA = ['host-a.example.com'];
    const allowlistB = ['host-a.example.com', 'host-b.example.com'];

    const allowlistPort: ImageAllowlistPort = {
      withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) =>
        fn(null),
      ),
      findByTenantId: vi.fn(),
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      remove: vi.fn(),
    };
    (allowlistPort.findByTenantId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        allowlistA.map((h) => ({ hostname: h as Hostname, isDefault: false })),
      )
      .mockResolvedValueOnce(
        allowlistB.map((h) => ({ hostname: h as Hostname, isDefault: false })),
      );

    const audit: AuditPort = { emit: vi.fn().mockResolvedValue(undefined) };
    const deps = { allowlistPort, audit };

    // First submit: hostB NOT yet in allowlist → reject
    const firstResult = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="https://host-b.example.com/a.png">',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-007a',
    });
    expect(firstResult.ok).toBe(false);

    // Admin adds hostB to allowlist (modeled by mockResolvedValueOnce
    // returning the updated set).

    // Second submit: hostB now in allowlist → ok. No sleep / no wait.
    const secondResult = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="https://host-b.example.com/a.png">',
      tenantId: TENANT,
      actorUserId: ACTOR,
      requestId: 'req-007b',
    });
    expect(secondResult.ok).toBe(true);
  });
});
