/**
 * 016 post-ship review finding #9 — no surviving test wrote/asserted a REAL
 * `permission_denied` row against live Postgres. The deleted T081 integration
 * test was the only one; the contract suite injects a mock audit dep, the
 * integration suites mock `requireApiPermission`, and the E2E explicitly
 * declines to re-verify rows.
 *
 * Why live-DB matters here specifically: the denial sink is DOUBLY fail-open
 * by design (`auditRepo.tryAppend` swallows throws into
 * `auth_audit_missing_total`; `recordDenial` never throws), so this repo's
 * two documented silent-no-op classes leave every staff denial trail-less
 * while ALL mock-based suites stay green:
 *   1. the `permission_denied` enum value missing on an environment where
 *      0286's ADD VALUE was skipped by a `when`-collision silent no-op — the
 *      INSERT throws, tryAppend swallows, nothing lands;
 *   2. an RLS / null-tx insert that "succeeds" writing nothing — never
 *      throws, so even the auditMissing metric stays flat.
 * Both classes fail THIS test, because it drives the real
 * `buildDenialAudit → auditRepo.append` sink and then SELECTs the row back.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { buildDenialAudit, denialSummary } from '@/lib/rbac';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('integration: permission_denied lands in live Postgres (finding #9)', () => {
  let actor: TestUser;

  beforeAll(async () => {
    actor = await createActiveTestUser('manager');
  });

  afterAll(async () => {
    // The audit row itself REMAINS (append-only trigger blocks DELETE) —
    // accepted pollution, same as every other integration audit writer.
    await deleteTestUser(actor);
  });

  it(
    'the real denial sink writes a selectable row with actor + requestId + route',
    async () => {
      const requestId = randomUUID();

      await auditRepo.append(
        buildDenialAudit({
          actorUserId: actor.userId,
          role: 'manager',
          permissionKey: 'users.manage',
          // Query string must be stripped by the row builder — the trail
          // records the ROUTE, never the arguments.
          routePath: '/admin/users?tab=pending',
          requestId,
          sourceIp: '203.0.113.99',
        }),
      );

      const rows = await db
        .select({
          eventType: auditLog.eventType,
          actorUserId: auditLog.actorUserId,
          summary: auditLog.summary,
          sourceIp: auditLog.sourceIp,
          requestId: auditLog.requestId,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.requestId, requestId),
            eq(auditLog.eventType, 'permission_denied'),
          ),
        );

      expect(rows.length, 'exactly one denial row must land').toBe(1);
      const row = rows[0]!;
      expect(row.summary).toBe(
        denialSummary('manager', 'users.manage', '/admin/users'),
      );
      expect(row.actorUserId).toBe(actor.userId);
      expect(row.sourceIp).toBe('203.0.113.99');
      expect(row.requestId).toBe(requestId);
    },
    60_000,
  );

  it(
    'an unknown role string stays visible verbatim in the trail (never coerced)',
    async () => {
      const requestId = randomUUID();
      await auditRepo.append(
        buildDenialAudit({
          actorUserId: actor.userId,
          role: 'corrupted_role',
          permissionKey: 'users.manage',
          routePath: '/admin/users',
          requestId,
          sourceIp: null,
        }),
      );
      const rows = await db
        .select({ summary: auditLog.summary })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.requestId, requestId),
            eq(auditLog.eventType, 'permission_denied'),
          ),
        );
      expect(rows.length).toBe(1);
      expect(rows[0]!.summary).toContain('role=corrupted_role');
    },
    60_000,
  );
});
