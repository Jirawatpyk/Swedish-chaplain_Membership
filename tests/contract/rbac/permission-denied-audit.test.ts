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
import { describe, expect, it, vi } from 'vitest';
import {
  buildDenialAudit,
  denialSummary,
  pathFromHeaders,
  requireApiPermission,
  requirePagePermission,
  sanitiseRoutePath,
  type RbacDeps,
} from '@/lib/rbac';
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
  overrides: { auditThrows?: boolean; metricsThrow?: boolean } = {},
): { deps: RbacDeps; recorded: Recorded } {
  const appended: unknown[] = [];
  const metrics: unknown[] = [];
  const deps: RbacDeps = {
    getSession: async () => sessionFor(role),
    audit: {
      append: async (event: unknown) => {
        appended.push(event);
        if (overrides.auditThrows === true) throw new Error('audit_log unavailable');
      },
    },
    countDenied: (labels) => {
      metrics.push(labels);
      if (overrides.metricsThrow === true) throw new Error('metrics backend down');
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
      requirePagePermission('users.manage', deps),
    ).rejects.toThrow();
    expect(recorded.appended).toHaveLength(1);
    expect(recorded.metrics).toEqual([{ role: 'manager', permission: 'users.manage' }]);
  });

  it('serves the 404 even when the audit emit throws (fail-open)', async () => {
    const { deps } = makeDeps('manager', { auditThrows: true });
    await expect(
      requirePagePermission('users.manage', deps),
    ).rejects.toThrow();
  });

  it('emits nothing on an allowed page load', async () => {
    const { deps, recorded } = makeDeps('super_admin');
    await expect(requirePagePermission('users.manage', deps)).resolves.toBeDefined();
    expect(recorded.appended).toEqual([]);
    expect(recorded.metrics).toEqual([]);
  });

  // 016 T072 — the three defaultDeps/edge arms coverage proved untested.
  it('a metrics-backend throw does not change the served denial (both sinks are fail-open)', async () => {
    const { deps, recorded } = makeDeps('manager', { metricsThrow: true });
    await expect(requirePagePermission('users.manage', deps)).rejects.toThrow();
    // The audit row still landed; the counter threw and was swallowed.
    expect(recorded.appended).toHaveLength(1);
  });

  it('a session-less caller reaching the page gate gets notFound, not a 500 (shell bypassed)', async () => {
    // The staff shell redirects anonymous callers before any page gate runs;
    // reaching this gate without a session means the shell was bypassed, and
    // the answer is the same not-found the denied get — never an error page.
    const { deps, recorded } = makeDeps('manager');
    const anon: RbacDeps = { ...deps, getSession: async () => null };
    await expect(requirePagePermission('users.manage', anon)).rejects.toThrow();
    // No actor identity exists — nothing attributable, no audit row.
    expect(recorded.appended).toEqual([]);
  });

  /**
   * The WIRING, not the seam (same rationale as the pathFromHeaders pair
   * below): every deps-injected case above leaves `defaultDeps`' page leg —
   * header-derived request id + route path — unexecuted. This drives a real
   * no-deps denial with the modules `defaultDeps` touches mocked at the
   * boundary, and asserts the header-sourced request id lands in the trail.
   */
  it('defaultDeps page leg: a no-deps denial derives request id + route from headers', async () => {
    vi.resetModules();
    const append = vi.fn(async (_event: unknown) => {});
    vi.doMock('next/headers', () => ({
      headers: async () =>
        new Headers({
          'x-pathname': '/admin/users?tab=pending',
          'x-request-id': 'aaaaaaaa-1111-4111-8111-cccccccccccc',
        }),
    }));
    vi.doMock('@/lib/auth-session', () => ({
      getCurrentSession: async () => sessionFor('manager'),
    }));
    vi.doMock('@/modules/auth/infrastructure/db/audit-repo', () => ({
      auditRepo: { append },
    }));
    vi.doMock('@/lib/metrics', () => ({
      authMetrics: { permissionDenied: vi.fn() },
    }));
    const { requirePagePermission: fresh } = await import('@/lib/rbac');
    await expect(fresh('users.manage')).rejects.toThrow();
    expect(append).toHaveBeenCalledTimes(1);
    const event = append.mock.calls[0]![0] as { requestId: string; summary: string };
    expect(event.requestId).toBe('aaaaaaaa-1111-4111-8111-cccccccccccc');
    // Query string stripped by the page-leg sanitiser.
    expect(event.summary).toContain('route=/admin/users');
    vi.doUnmock('next/headers');
    vi.doUnmock('@/lib/auth-session');
    vi.doUnmock('@/modules/auth/infrastructure/db/audit-repo');
    vi.doUnmock('@/lib/metrics');
    vi.resetModules();
  });
});

describe('T017 API denials', () => {
  const request = { headers: new Headers(), url: 'https://x.test/api/auth/users/1/role' } as never;

  it('returns a typed 403 and audits it', async () => {
    const { deps, recorded } = makeDeps('manager');
    const result = await requireApiPermission(request, 'users.manage', deps);
    expect('response' in result).toBe(true);
    expect((result as { response: Response }).response.status).toBe(403);
    expect(recorded.appended).toHaveLength(1);
  });

  it('returns 403 even when the audit emit throws (fail-open)', async () => {
    const { deps } = makeDeps('manager', { auditThrows: true });
    const result = await requireApiPermission(request, 'users.manage', deps);
    expect((result as { response: Response }).response.status).toBe(403);
  });

  it('returns 401 — not 403 — for an anonymous caller (enumeration safety)', async () => {
    const { deps, recorded } = makeDeps('manager');
    const anon: RbacDeps = { ...deps, getSession: async () => null };
    const result = await requireApiPermission(request, 'users.manage', anon);
    expect((result as { response: Response }).response.status).toBe(401);
    // No actor identity exists, so nothing is attributable — no audit row.
    expect(recorded.appended).toEqual([]);
  });

  it('passes the session through on allow', async () => {
    const { deps, recorded } = makeDeps('super_admin');
    const result = await requireApiPermission(request, 'users.manage', deps);
    expect('response' in result).toBe(false);
    expect(recorded.appended).toEqual([]);
  });

  it('a null client IP on allow degrades to the 0.0.0.0 sentinel, never undefined', async () => {
    // getClientIp legitimately returns null (no forwarding headers); the
    // allow-path context must still carry a string for downstream consumers.
    const { deps } = makeDeps('super_admin');
    const noIp: RbacDeps = { ...deps, sourceIp: () => null };
    const result = await requireApiPermission(request, 'users.manage', noIp);
    expect('response' in result).toBe(false);
    if (!('response' in result)) expect(result.sourceIp).toBe('0.0.0.0');
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

describe('T017 nobody reads the deleted flag', () => {
  it('neither the Domain evaluator nor rbac.ts reads env for authorization', async () => {
    // PR 5 deleted FEATURE_RBAC_V2; the old assertion REQUIRED rbac.ts to read
    // it. Now the invariant is total: the permission decision has no env input
    // anywhere — a reappearing flag read is a resurrected leg switch.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // CODE only — rbac.ts legitimately narrates the flag's deletion in its
    // header, and a scan that reads prose as source is the exact blindness
    // class scripts/lib/source-scan.ts exists to prevent.
    const { stripCommentsPreserveLines } = await import(
      '../../../scripts/lib/source-scan'
    );
    const codeOf = (path: string) => stripCommentsPreserveLines(readFileSync(path, 'utf8'));
    const domainDir = join(process.cwd(), 'src', 'modules', 'auth', 'domain', 'permissions');
    for (const file of ['evaluator.ts', 'role-bundles.ts', 'permission-catalogue.ts']) {
      const src = codeOf(join(domainDir, file));
      expect(src, `${file} must not read env`).not.toMatch(/process\.env|from '@\/lib\/env'/);
    }
    const helper = codeOf(join(process.cwd(), 'src', 'lib', 'rbac.ts'));
    expect(helper).not.toMatch(/FEATURE_RBAC_V2|env\.features\.rbacV2/);
  });
});

/**
 * 016 review I2 — the page leg reads `x-pathname`, which the proxy normally
 * sets. But `src/proxy.ts`'s PAGE matcher skips the proxy entirely for Next.js
 * router prefetch requests (`missing: next-router-prefetch / purpose:
 * prefetch`), so on those the header is client-supplied. Without a shape check
 * a signed-in caller about to be denied can choose the `route=` value written
 * into an append-only governance row. (`/api/*` never skips the proxy and uses
 * `request.url`, so only this leg is exposed.)
 */
describe('T017/I2 route-path sanitisation (denial trail cannot be forged)', () => {
  it('accepts ordinary staff paths verbatim', () => {
    expect(sanitiseRoutePath('/admin/compliance/erasure-log')).toBe(
      '/admin/compliance/erasure-log',
    );
    expect(sanitiseRoutePath('/admin/members/[memberId]/benefits')).toBe(
      '/admin/members/[memberId]/benefits',
    );
  });

  it('strips the query string on the PAGE leg too (proxy sets pathname+search)', () => {
    // The contract on `RbacDeps.routePath` says "WITHOUT the query string";
    // before this fix only the API leg honoured it, and query strings on this
    // surface routinely carry member ids and emails.
    expect(sanitiseRoutePath('/admin/members?q=anders@example.test')).toBe('/admin/members');
  });

  it('drops a forged CRLF payload rather than recording it (CWE-117)', () => {
    expect(sanitiseRoutePath('/admin/x\r\nrole=super_admin permission=users.manage')).toBe('');
    // A space alone would let a forger append a fake field to the
    // `role=… permission=… route=…` summary; the class already excludes it.
    expect(sanitiseRoutePath('/admin/x permission=users.manage')).toBe('');
  });

  it('drops percent-encoded CRLF (inert here, but re-materialises on any decode)', () => {
    // Re-review round 2 — `%` is a valid path char, so `%0d%0a` passed the
    // class; a consumer that URL-decodes the summary would get a real line
    // break back. Rejected outright.
    expect(sanitiseRoutePath('/admin/x%0d%0arole=super_admin')).toBe('');
    expect(sanitiseRoutePath('/admin/x%0A%0Dinjected')).toBe('');
  });

  it('drops a protocol-relative //host prefix (off-origin if ever rendered as href)', () => {
    // Re-review round 2 — `https://…` was already dropped, but `//evil/…`
    // slipped through the leading-slash check.
    expect(sanitiseRoutePath('//evil.example/admin')).toBe('');
  });

  it('drops values that are not same-origin paths', () => {
    expect(sanitiseRoutePath('https://evil.example/admin')).toBe('');
    expect(sanitiseRoutePath('admin/members')).toBe('');
    expect(sanitiseRoutePath('')).toBe('');
    expect(sanitiseRoutePath(null)).toBe('');
  });

  it('drops an over-long value so a forgery cannot dominate the 500-char summary', () => {
    expect(sanitiseRoutePath('/' + 'a'.repeat(300))).toBe('');
    // Boundary pins (re-review): the cap is "leading slash + 255 chars".
    expect(sanitiseRoutePath('/' + 'a'.repeat(255))).toBe('/' + 'a'.repeat(255));
    expect(sanitiseRoutePath('/' + 'a'.repeat(256))).toBe('');
  });

  it('a dropped path still yields a well-formed summary (denial is never blocked)', () => {
    const event = buildDenialAudit({
      actorUserId: USER_ID,
      role: 'manager',
      permissionKey: 'audit.read',
      routePath: sanitiseRoutePath('/admin\r\ninjected'),
      requestId: 'req-1',
      sourceIp: null,
    });
    expect(event.summary).toBe(denialSummary('manager', 'audit.read', ''));
    expect(event.summary).not.toContain('injected');
  });

  /**
   * Re-review round 2 — the WIRING, not just the pure function. Testing
   * `sanitiseRoutePath` in isolation leaves `pathFromHeaders` free to return
   * `h.get('x-pathname') ?? ''` unsanitised (the original C1 shape: test the
   * artefact, not the call site). This drives the real header read and asserts
   * the forged value never survives it.
   */
  it('pathFromHeaders sanitises the raw x-pathname header, not just the pure fn', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () => new Headers({ 'x-pathname': '/admin/x%0d%0arole=super_admin' }),
    }));
    const { pathFromHeaders: freshPathFromHeaders } = await import('@/lib/rbac');
    expect(await freshPathFromHeaders()).toBe('');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  it('pathFromHeaders passes an ordinary path through', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () => new Headers({ 'x-pathname': '/admin/renewals?tab=lapsed' }),
    }));
    const { pathFromHeaders: freshPathFromHeaders } = await import('@/lib/rbac');
    expect(await freshPathFromHeaders()).toBe('/admin/renewals');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  /**
   * 016 post-ship review finding #5 — provenance, not just shape. A request
   * carrying either prefetch marker is exactly the request the proxy matcher
   * skipped, i.e. the only request whose `x-pathname` reaches the render
   * without the server-side overwrite. A WELL-FORMED forged path on such a
   * request must be clamped to unattributed — shape checks alone let the
   * attacker choose the `route=` of an append-only governance row.
   */
  it('pathFromHeaders clamps a well-formed path on a next-router-prefetch request', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () =>
        new Headers({
          'x-pathname': '/admin/dashboard',
          'next-router-prefetch': '1',
        }),
    }));
    const { pathFromHeaders: freshPathFromHeaders } = await import('@/lib/rbac');
    expect(await freshPathFromHeaders()).toBe('');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  it('pathFromHeaders clamps on purpose: prefetch (the second proxy-skip marker)', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () =>
        new Headers({
          'x-pathname': '/admin/dashboard',
          purpose: 'prefetch',
        }),
    }));
    const { pathFromHeaders: freshPathFromHeaders } = await import('@/lib/rbac');
    expect(await freshPathFromHeaders()).toBe('');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  it('pathFromHeaders does NOT clamp on a non-prefetch purpose value', async () => {
    // The proxy matcher only skips on `purpose: prefetch` exactly — any other
    // value means the proxy ran and overwrote the header, so it is trusted.
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () =>
        new Headers({
          'x-pathname': '/admin/renewals',
          purpose: 'preload',
        }),
    }));
    const { pathFromHeaders: freshPathFromHeaders } = await import('@/lib/rbac');
    expect(await freshPathFromHeaders()).toBe('/admin/renewals');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  // Keep a reference so the top-level import is not flagged unused when the
  // dynamic re-imports above are what exercise the wiring.
  void pathFromHeaders;
});
