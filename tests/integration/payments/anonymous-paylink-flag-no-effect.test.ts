/**
 * T163 (optional, post-audit G5) — F5.1 forward-compat verification.
 *
 * Plan authority: `specs/009-online-payment/plan.md` § FR-016a + Q3.
 * Spec authority: spec.md FR-016a — `tenant_payment_settings.allow_anonymous_paylink`
 * is a forward-compat flag for F5.1 (signed-token unauthenticated clerk-pay-
 * link). In F5 MVP the flag MUST default to `false` and toggling it to `true`
 * MUST have zero user-facing effect — there is no `/api/payments/anonymous`
 * route, no signed-token endpoint exposed, and admin UI either omits the
 * setting or shows a "Coming in F5.1" placeholder.
 *
 * This test asserts:
 *   (a) the column defaults to `false` on insert when omitted
 *   (b) the repo round-trips both `false` and `true` correctly across
 *       reads + writes (so F5.1 promotion can flip the flag without
 *       schema migration)
 *   (c) NO route file under `src/app/api/payments/anonymous/**` exists
 *       in the F5 codebase (file-system invariant — the URL space is
 *       reserved for F5.1 and MUST NOT collide with any F5 surface)
 *   (d) no F5 use-case branch reads the flag (file-system grep — the
 *       flag MUST be invisible to F5 MVP runtime behaviour)
 *
 * Why integration not contract: (a) hits real Postgres for the column
 * default; (b)+(c)+(d) are file-system invariants but live in this
 * file for cohesion with the FR-016a contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInTenant } from '@/lib/db';
import {
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('FR-016a allow_anonymous_paylink — forward-compat flag has no F5 effect', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenant = pair.a;
  });

  afterAll(async () => {
    if (tenant) {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .delete(tenantPaymentSettings)
          .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      });
    }
  });

  it('(a) column defaults to false when not supplied on insert', async () => {
    // Cast: the column definition has DEFAULT false but the repo's
    // typed insert helper requires the field. The intent of the test
    // is to assert the SCHEMA's DEFAULT works, so we drop the field
    // by widening the typed shape and rely on the underlying SQL.
    const settings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      // allowAnonymousPaylink: intentionally OMITTED to test column DEFAULT
    } as unknown as NewTenantPaymentSettingsRow;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);

      const [row] = await tx
        .select({
          allowAnonymousPaylink: tenantPaymentSettings.allowAnonymousPaylink,
        })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));

      expect(row).toBeDefined();
      expect(row?.allowAnonymousPaylink).toBe(false);
    });
  });

  it('(b) repo round-trips false → true → false correctly', async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      // Flip to true.
      await tx
        .update(tenantPaymentSettings)
        .set({ allowAnonymousPaylink: true })
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));

      const [afterTrue] = await tx
        .select({
          allowAnonymousPaylink: tenantPaymentSettings.allowAnonymousPaylink,
        })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      expect(afterTrue?.allowAnonymousPaylink).toBe(true);

      // Flip back to false.
      await tx
        .update(tenantPaymentSettings)
        .set({ allowAnonymousPaylink: false })
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));

      const [afterFalse] = await tx
        .select({
          allowAnonymousPaylink: tenantPaymentSettings.allowAnonymousPaylink,
        })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      expect(afterFalse?.allowAnonymousPaylink).toBe(false);
    });
  });

  it('(c) no /api/payments/anonymous route exists in F5 MVP', () => {
    const cwd = process.cwd();
    const reservedRoutes = [
      'src/app/api/payments/anonymous',
      'src/app/api/payments/anonymous/[token]',
      'src/app/api/payments/anonymous/initiate',
      'src/app/api/payments/anonymous/[token]/route.ts',
      'src/app/api/payments/anonymous/initiate/route.ts',
    ];
    for (const route of reservedRoutes) {
      expect(
        existsSync(join(cwd, route)),
        `${route} MUST NOT exist in F5 — reserved for F5.1 (FR-016a forward-compat)`,
      ).toBe(false);
    }
  });

  it('(d) no F5 use-case branches on allow_anonymous_paylink in MVP runtime', () => {
    // Intent: the flag MUST be invisible to F5 MVP runtime behaviour.
    // The flag is read by the repo's typed shape (Drizzle column) but
    // MUST NOT be checked in any use-case `if`/`switch`/conditional.
    // We grep the use-case directory for the flag name. The repo file
    // is allowed to surface the field (it has to round-trip the
    // column); the schema/test files are allowed to reference it.
    const cwd = process.cwd();
    const useCaseDirRel = 'src/modules/payments/application';
    const fs = await import('node:fs');
    const path = await import('node:path');

    const offenders: string[] = [];
    function walk(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const content = readFileSync(full, 'utf-8');
        if (
          content.includes('allowAnonymousPaylink') ||
          content.includes('allow_anonymous_paylink')
        ) {
          offenders.push(path.relative(cwd, full));
        }
      }
    }
    walk(join(cwd, useCaseDirRel));

    expect(
      offenders,
      `F5 application layer MUST NOT branch on allow_anonymous_paylink. Offenders: ${offenders.join(
        ', ',
      )}`,
    ).toEqual([]);
  });
});
