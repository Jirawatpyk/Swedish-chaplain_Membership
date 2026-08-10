/**
 * T017 — denial-audit contract (016-rbac-permissions PR 2, US2).
 *
 * Pins what a denial writes and, more importantly, that a denial still DENIES
 * when the audit write fails. The audit emit is fail-open by design: an
 * `audit_log` outage must not become an authorization bypass, and must not
 * become a 500 either — the caller still gets its 404/403.
 *
 * Payload is pinned exactly (contracts/permission-evaluator.md § 2):
 *   { actor_user_id, role (the REAL role, never coerced), permission_key,
 *     route_path (no query string), request_id }
 * `audit_log` has no structured-metadata column (F1 folds detail into
 * `summary`), so role / permission_key / route_path are encoded in a
 * deterministic summary string that this test owns.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDenialAudit,
  denialSummary,
  requireApiPermission,
  requirePagePermission,
  type RbacDeps,
} from '@/lib/rbac';
import { legacyAdminOnly, legacySessionOnly } from '@/modules/auth/domain/permissions/legacy-shim';
import { ROLES, type Role } from '@/modules/auth/domain/role';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function sessionFor(role: string) {
  return {
    session: { id: 'sess-1', userId: USER_ID },
    user: { id: USER_ID, role, status: 'active', email: 'staff@example.test' },
  } as never;
}

interface Recorded {
  readonly appended: unknown[];
  readonly metrics: unknown[];
}

function makeDeps(
  role: string,
  overrides: { rbacV2?: boolean; auditThrows?: boolean } = {},
): { deps: RbacDeps; recorded: Recorded } {
  const appended: unknown[] = [];
  const metrics: unknown[] = [];
  const deps: RbacDeps = {
    rbacV2: overrides.rbacV2 ?? true,
    getSession: async () => sessionFor(role),
    audit: {
      append: async (event: unknown) => {
        appended.push(event);
        if (overrides.auditThrows === true) throw new Error('audit_log unavailable');
      },
    },
    countDenied: (labels) => {
      metrics.push(labels);
    },
    routePath: () => '/admin/secret',
    requestId: () => 'req-123',
    sourceIp: () => '203.0.113.9',
  };
  return { deps, recorded: { appended, metrics } };
}

describe('T017 denial audit payload', () => {
  it('encodes role, permission key and route path in a deterministic summary', () => {
    expect(denialSummary('manager', 'users.manage', '/admin/users')).toBe(
      'role=manager permission=users.manage route=/admin/users',
    );
  });

  it('strips the query string from route_path', () => {
    const event = buildDenialAudit({
      actorUserId: USER_ID,
      role: 'manager',
      permissionKey: 'users.manage',
      routePath: '/admin/users?role=admin&page=2',
      requestId: 'req-1',
      sourceIp: null,
    });
    expect(event.summary).toBe('role=manager permission=users.manage route=/admin/users');
  });

  it('records the REAL role for a value outside the Role union', () => {
    // A role string the app does not know must never be coerced to a known
    // role in the trail — forensics needs the literal value that was rejected.
    const event = buildDenialAudit({
      actorUserId: USER_ID,
      role: 'auditor' as Role,
      permissionKey: 'audit.read',
      routePath: '/admin/audit',
      requestId: 'req-2',
      sourceIp: null,
    });
    expect(event.summary).toContain('role=auditor');
  });

  it('uses the permission_denied event type and carries the actor + request id', () => {
    const event = buildDenialAudit({
      actorUserId: USER_ID,
      role: 'manager',
      permissionKey: 'users.manage',
      routePath: '/admin/users',
      requestId: 'req-3',
      sourceIp: '203.0.113.9',
    });
    expect(event.eventType).toBe('permission_denied');
    expect(event.actorUserId).toBe(USER_ID);
    expect(event.requestId).toBe('req-3');
    expect(event.sourceIp).toBe('203.0.113.9');
  });
});

describe('T017 page denials', () => {
  it('emits one denial audit + one metric per denied page load', async () => {
    const { deps, recorded } = makeDeps('manager');
    await expect(
      requirePagePermission('users.manage', legacySessionOnly, deps),
    ).rejects.toThrow();
    expect(recorded.appended).toHaveLength(1);
    expect(recorded.metrics).toEqual([{ role: 'manager', permission: 'users.manage' }]);
  });

  it('serves the 404 even when the audit emit throws (fail-open)', async () => {
    const { deps } = makeDeps('manager', { auditThrows: true });
    await expect(
      requirePagePermission('users.manage', legacySessionOnly, deps),
    ).rejects.toThrow();
  });

  it('emits nothing on an allowed page load', async () => {
    const { deps, recorded } = makeDeps('super_admin');
    await expect(requirePagePermission('users.manage', legacySessionOnly, deps)).resolves.toBeDefined();
    expect(recorded.appended).toEqual([]);
    expect(recorded.metrics).toEqual([]);
  });
});

describe('T017 API denials', () => {
  const request = { headers: new Headers(), url: 'https://x.test/api/auth/users/1/role' } as never;

  it('returns a typed 403 and audits it', async () => {
    const { deps, recorded } = makeDeps('manager');
    const result = await requireApiPermission(request, 'users.manage', legacyAdminOnly, deps);
    expect('response' in result).toBe(true);
    expect((result as { response: Response }).response.status).toBe(403);
    expect(recorded.appended).toHaveLength(1);
  });

  it('returns 403 even when the audit emit throws (fail-open)', async () => {
    const { deps } = makeDeps('manager', { auditThrows: true });
    const result = await requireApiPermission(request, 'users.manage', legacyAdminOnly, deps);
    expect((result as { response: Response }).response.status).toBe(403);
  });

  it('returns 401 — not 403 — for an anonymous caller (enumeration safety)', async () => {
    const { deps, recorded } = makeDeps('manager');
    const anon: RbacDeps = { ...deps, getSession: async () => null };
    const result = await requireApiPermission(request, 'users.manage', legacyAdminOnly, anon);
    expect((result as { response: Response }).response.status).toBe(401);
    // No actor identity exists, so nothing is attributable — no audit row.
    expect(recorded.appended).toEqual([]);
  });

  it('passes the session through on allow', async () => {
    const { deps, recorded } = makeDeps('super_admin');
    const result = await requireApiPermission(request, 'users.manage', legacyAdminOnly, deps);
    expect('response' in result).toBe(false);
    expect(recorded.appended).toEqual([]);
  });
});

describe('T017 every role produces a denial that is attributable', () => {
  // `users.manage` is superAdminOnly, so exactly one role passes. Every other
  // role — including the unknown-value case — must produce an audited denial
  // that records its own literal role.
  for (const role of [...ROLES, 'auditor']) {
    it(`${role}`, async () => {
      const { deps, recorded } = makeDeps(role);
      const result = await requireApiPermission(
        { headers: new Headers(), url: 'https://x.test/api/auth/invite' } as never,
        'users.manage',
        legacyAdminOnly,
        deps,
      );
      if (role === 'super_admin') {
        expect('response' in result).toBe(false);
        return;
      }
      expect((result as { response: Response }).response.status).toBe(403);
      expect(recorded.appended).toHaveLength(1);
      expect((recorded.appended[0] as { summary: string }).summary).toContain(`role=${role}`);
    });
  }
});

describe('T017 flag-OFF leg denials are audited the same way', () => {
  it('a marketing actor denied by D16 totalisation still produces a trail', async () => {
    const { deps, recorded } = makeDeps('marketing', { rbacV2: false });
    const result = await requireApiPermission(
      { headers: new Headers(), url: 'https://x.test/api/members' } as never,
      'members.read',
      legacySessionOnly,
      deps,
    );
    expect((result as { response: Response }).response.status).toBe(403);
    expect((recorded.appended[0] as { summary: string }).summary).toContain('role=marketing');
  });

  it('an admin allowed by the legacy row is not audited', async () => {
    const { deps, recorded } = makeDeps('admin', { rbacV2: false });
    const result = await requireApiPermission(
      { headers: new Headers(), url: 'https://x.test/api/members' } as never,
      'members.read',
      legacySessionOnly,
      deps,
    );
    expect('response' in result).toBe(false);
    expect(recorded.appended).toEqual([]);
  });
});

describe('T017 the helper is the only env-flag reader', () => {
  it('src/lib/rbac.ts reads the flag; the Domain evaluator never does', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const domainDir = join(process.cwd(), 'src', 'modules', 'auth', 'domain', 'permissions');
    for (const file of ['evaluator.ts', 'legacy-shim.ts', 'role-bundles.ts', 'permission-catalogue.ts']) {
      const src = readFileSync(join(domainDir, file), 'utf8');
      expect(src, `${file} must not read env`).not.toMatch(/process\.env|from '@\/lib\/env'/);
    }
    const helper = readFileSync(join(process.cwd(), 'src', 'lib', 'rbac.ts'), 'utf8');
    expect(helper).toMatch(/FEATURE_RBAC_V2|env\.features\.rbacV2/);
  });
});
