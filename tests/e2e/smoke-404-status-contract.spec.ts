/**
 * Smoke 404 status contract — P1.4 polish guard (2026-05-17
 * retrospective).
 *
 * Closes the RSC 200-vs-404 status drift class. Symptom in the F4 ship:
 * `/admin/invoices/[invoiceId]/page.tsx` called `notFound()` for crafted
 * IDs but Next.js 16 RSC streaming returned HTTP **200 with not-found
 * body** instead of a clean 404 response. The bug:
 *
 *   1. Broke Constitution Principle I cross-tenant probe contract —
 *      attackers could grep 200 status to enumerate `invoiceId`s.
 *   2. Hid real 404s from monitoring / SRE dashboards that filter on
 *      4xx rate.
 *   3. Confused search-engine indexers (page reported "exists").
 *
 * The fix pattern (proven on F7 broadcasts + applied to F4 invoices):
 *   - co-locate a `not-found.tsx` sibling to `page.tsx`
 *   - add `export const dynamic = 'force-dynamic'` to the page
 *
 * This smoke test probes a few representative `[id]` routes with a
 * fresh random UUID per probe (guaranteed-non-existent) and asserts
 * the route returns HTTP 404 — NOT 200. Probes use signed-in cookies
 * so RBAC redirects don't mask the contract.
 *
 * Adding a NEW dynamic `[id]` route? Add it to the COVERED_ROUTES list
 * below.
 *
 * Failing here means the route is missing one of:
 *   - sibling `not-found.tsx`
 *   - `export const dynamic = 'force-dynamic'` (or `'force-static'`)
 *   - the `notFound()` call in the data-fetch path
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-sign-in';
import { clearE2ERateLimits } from './helpers/rate-limit';

test.beforeEach(async () => {
  await clearE2ERateLimits();
});

// Representative `[id]` routes — pick at least one per route group so
// future regressions show up regardless of which surface is touched.
// Each entry maps a path pattern to its required auth role.
interface CoveredRoute {
  readonly label: string;
  readonly path: (id: string) => string;
  readonly role: 'admin' | 'member';
}

const COVERED_ROUTES: ReadonlyArray<CoveredRoute> = [
  {
    label: '/admin/invoices/[invoiceId] (regression: F4 polish 2026-05-17)',
    path: (id) => `/admin/invoices/${id}`,
    role: 'admin',
  },
  {
    label: '/admin/credit-notes/[creditNoteId]',
    path: (id) => `/admin/credit-notes/${id}`,
    role: 'admin',
  },
  {
    label: '/portal/invoices/[invoiceId]',
    path: (id) => `/portal/invoices/${id}`,
    role: 'member',
  },
  {
    label: '/portal/credit-notes/[creditNoteId]',
    path: (id) => `/portal/credit-notes/${id}`,
    role: 'member',
  },
];

async function probeStatus(
  request: APIRequestContext,
  path: string,
): Promise<number> {
  // Use the shared request context (carries the signed-in session
  // cookie when called after signIn). `failOnStatusCode: false` so
  // a real 404 doesn't throw — we want to assert ON the status.
  const res = await request.get(path, { failOnStatusCode: false });
  return res.status();
}

test.describe('@principle-I @smoke 404 status contract for [id] routes', () => {
  test.skip(
    !process.env.E2E_ADMIN_EMAIL || !process.env.E2E_ADMIN_PASSWORD,
    'E2E_ADMIN_EMAIL/PASSWORD required',
  );
  test.skip(
    !process.env.E2E_MEMBER_EMAIL || !process.env.E2E_MEMBER_PASSWORD,
    'E2E_MEMBER_EMAIL/PASSWORD required',
  );

  for (const route of COVERED_ROUTES) {
    test(`${route.label} → HTTP 404 (not 200) for crafted UUID`, async ({
      page,
    }) => {
      // Sign in to the required role so RBAC redirects don't mask the
      // 404 contract (otherwise an unauthenticated probe might 307 →
      // sign-in instead of hitting the route's notFound branch).
      if (route.role === 'admin') {
        await signInAsAdmin(page);
      } else {
        await signInAsMember(page);
      }

      // Fresh random UUID per probe — collision-free + survives test
      // re-runs without seed cleanup. Format-valid so zod schemas don't
      // 400 the request before the data-fetch reaches `notFound()`.
      const craftedId = randomUUID();
      const status = await probeStatus(page.request, route.path(craftedId));

      expect(
        status,
        `crafted UUID MUST yield 404 (got ${status}). The route is likely ` +
          `missing a sibling not-found.tsx + export const dynamic = ` +
          `'force-dynamic' — RSC streaming will return 200 with not-found ` +
          `body instead of a clean 404 response. See route's not-found.tsx ` +
          `pattern in src/app/(member)/portal/broadcasts/[id]/ or ` +
          `src/app/(staff)/admin/invoices/[invoiceId]/ for reference.`,
      ).toBe(404);
    });
  }
});
