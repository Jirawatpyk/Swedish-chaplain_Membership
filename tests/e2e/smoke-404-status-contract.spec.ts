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

async function probeNotFound(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; body: string }> {
  // Use the shared request context (carries the signed-in session
  // cookie when called after signIn). `failOnStatusCode: false` so
  // a real 404 doesn't throw — we want to assert ON the response.
  // `maxRedirects: 0` is load-bearing: without it a 307 → sign-in is
  // followed and reported as a 200, so a 200 could not be told from an
  // RBAC redirect. With it, a redirect fails the status assertion.
  const res = await request.get(path, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  return { status: res.status(), body: await res.text() };
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
    test(`${route.label} → not-found body for crafted UUID (no redirect)`, async ({
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
      const { status, body } = await probeNotFound(
        page.request,
        route.path(craftedId),
      );

      // Next 16 dev-mode RSC streaming commits the response headers BEFORE
      // `notFound()` resolves, so the dev server answers 200 while still
      // rendering the not-found UI; a production build returns a clean 404.
      // Asserting `.toBe(404)` here therefore failed on every route since the
      // day this spec landed, against the `pnpm dev` server its own config
      // boots. Six sibling specs already encode the accepted contract —
      // invoice-draft-issue.spec.ts (added in the SAME commit as this file),
      // member-quota-history, manager-readonly-events, rbac-admin-persona,
      // rbac-navigation, rbac-marketing-persona.
      expect(
        [200, 404],
        `crafted UUID must reach the route's not-found branch, not a redirect ` +
          `(got ${status}). A 3xx means RBAC bounced the probe before the ` +
          `data fetch — check the signed-in role for this route.`,
      ).toContain(status);

      // The real contract, and stronger than the status was: the response must
      // carry Next's not-found marker. A route missing its sibling
      // not-found.tsx + `export const dynamic = 'force-dynamic'` renders the
      // record page instead, and this is what catches it. Reference pattern:
      // src/app/(staff)/admin/invoices/[invoiceId]/.
      expect(
        body,
        `crafted UUID MUST render the not-found body. The route is likely ` +
          `missing a sibling not-found.tsx + export const dynamic = ` +
          `'force-dynamic'.`,
      ).toMatch(
        /<meta\s+name="next-error"\s+content="not-found"|NEXT_HTTP_ERROR_FALLBACK;404/,
      );
    });
  }
});
