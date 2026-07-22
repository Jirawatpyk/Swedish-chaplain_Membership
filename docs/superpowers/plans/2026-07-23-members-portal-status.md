# Members Directory Portal Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show on `/admin/members` which members can actually log into the portal, let staff filter to the ones who still need inviting, make the bulk invite work for them, and stop the Plan/Status columns from overflowing into their neighbours.

**Architecture:** Four independently shippable phases. Phase A is a CSS-only fix. Phase B derives a 4-state portal badge from the primary contact (a pure domain function + one batched repo read joined through `contacts`, mirroring the existing `loadMembersMembershipStatus` enrichment). Phase C adds a needs-invite toggle chip backed by a single `EXISTS` predicate in the shared directory WHERE-builder plus a `COUNT(*)`. Phase D extends the existing bulk invite so it re-sends to members whose invitation expired instead of skipping them.

**Tech Stack:** Next.js 16 App Router (server components), React 19, TypeScript 5.7 strict, Drizzle ORM on Neon Postgres, TanStack Table v8, next-intl, Vitest, Playwright.

**Design doc:** `docs/superpowers/specs/2026-07-23-members-table-portal-status-design.md` — read it before starting. Every decision below traces to a `D<n>` in its §2.

## Global Constraints

- **Package manager is `pnpm`, never `npm`.**
- **No schema migration, no new audit event type, no new npm dependency.** If a task seems to need one, stop and escalate — it means the plan is wrong.
- **Never run `prettier --write`** on this repo. Hand-format to match surrounding code.
- **`pnpm typecheck` is the final gate** after your last edit in a task, before committing. It is not in the pre-push hook.
- **Integration tests**: pass the file **path positionally** — `pnpm test:integration tests/integration/members/x.test.ts`. Passing `-- <pattern>` runs the whole ~40-minute suite. Never run the `tests/integration/members/` folder as a whole (82 files; workers die around ~42).
- **E2E**: always `--workers=1`.
- **i18n**: every new key must exist in all three of `src/i18n/messages/{en,th,sv}.json`. `pnpm check:i18n` fails the build on a missing EN key.
- **Tenant isolation**: every query inside `runInTenant(ctx, async (tx) => …)` must use that `tx`, never the global `db` singleton — a pool-global query silently bypasses RLS.
- **`invitations` column grant**: `chamber_app` may read only `user_id`, `consumed_at`, `expires_at`. Referencing `id` or `created_at` anywhere in a query — including in a `WHERE` — raises Postgres `42501`.
- **Commits**: Conventional Commits, enforced by a commit-msg hook.
- **Branch**: `feat/members-portal-status` (already created, holds the two design-doc commits).

## File Structure

**Phase A — overlap fix**
- Modify: `src/components/members/members-table.tsx` (Plan cell ~:554, Status cell ~:609)
- Create: `tests/e2e/helpers/long-content-member-seed.ts` — seeds a member whose plan name and contact name are long enough to overflow
- Create: `tests/e2e/members-table-overflow.spec.ts`

**Phase B — portal badge**
- Create: `src/modules/members/domain/portal-state.ts` — `PortalState` + `derivePortalState`
- Modify: `src/modules/members/application/ports/member-repo.ts` — add `findPendingInvitationsForPrimaryContacts`
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` — implement it
- Create: `src/modules/members/application/use-cases/load-members-portal-status.ts`
- Modify: `src/modules/members/index.ts` — barrel exports
- Modify: `src/app/(staff)/admin/members/page.tsx` — wire the read, extend the row
- Modify: `src/components/members/members-table.tsx` — Contact cell badges
- Modify: `src/components/members/members-table-skeleton.tsx` — second line in Contact
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Tests: `tests/unit/members/domain/portal-state.test.ts`, `tests/unit/members/application/load-members-portal-status.test.ts`, `tests/integration/members/portal-status-batch-read.test.ts`

**Phase C — chip + filter**
- Modify: `drizzle-member-repo.ts` — extract `buildDirectoryWhere`, add the predicate + `countMembersNeedingPortalInvite`
- Modify: `member-repo.ts` — `portalNeedsInvite` on both filter types + the count method
- Create: `src/modules/members/application/use-cases/count-members-needing-portal-invite.ts`
- Modify: `src/app/(staff)/admin/members/page.tsx` — `?portal=` allow-list, `hasFilters`, first `Promise.all`, all three return branches
- Modify: `src/components/members/directory-filters.tsx` — the chip
- Modify: `src/components/members/empty-states.tsx` — `MembersAllInvitedEmptyState`
- Tests: `tests/integration/members/portal-needs-invite-filter.test.ts`, `tests/e2e/members-portal-chip.spec.ts`

**Phase D — bulk resend**
- Modify: `src/modules/members/application/use-cases/bulk-send-portal-invite.ts`
- Modify: `src/app/api/members/bulk/route.ts`
- Modify: `src/components/members/` bulk result toast copy + `src/i18n/messages/*`
- Tests: `tests/integration/members/bulk-send-portal-invite-resend.test.ts`

---

# PHASE A — Column overlap fix

Ships alone. No dependency on B/C/D.

### Task 1: E2E fixture + failing overflow test

**Files:**
- Create: `tests/e2e/helpers/long-content-member-seed.ts`
- Create: `tests/e2e/members-table-overflow.spec.ts`

**Interfaces:**
- Produces: `seedLongContentMember(): Promise<{ memberId: string; companyName: string } | null>` — used only by this spec.

**Why a fixture at all:** the existing directory specs are written to tolerate an empty table (`tests/e2e/members-directory-search.spec.ts:11-13`) and there is no members seed helper. A test that iterates "every row" would iterate nothing and pass while guarding nothing.

- [ ] **Step 1: Write the seed helper**

Create `tests/e2e/helpers/long-content-member-seed.ts`. Model it on `tests/e2e/helpers/lapsed-member-seed.ts` (read that file first — same postgres client setup, same "no real PII" rule, same idempotent deterministic ids).

```ts
/**
 * E2E seed — a DUMMY member whose plan name and contact name are long
 * enough to overflow the directory's fixed column widths (Plan 150px,
 * Contact 175px). Without it the overflow spec passes vacuously.
 *
 * Also gives the member a lapsed renewal cycle so the Status cell renders
 * the widest possible content (status control + pencil + Lapsed badge).
 */
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

const DUMMY_MEMBER_ID = '00000000-0000-4000-8000-0000010ec001';
const DUMMY_CONTACT_ID = '00000000-0000-4000-8000-0000010ec011';
const DUMMY_PLAN_ID = 'e2e-long-name-plan';
// 46 chars — comfortably wider than the 150px Plan column.
const DUMMY_PLAN_NAME = 'Corporate Platinum Plus Membership Package 2026';
const DUMMY_COMPANY = 'Overflow Fixture Trading Company Limited (E2E)';
const DUMMY_CONTACT_FIRST = 'Bartholomew';
const DUMMY_CONTACT_LAST = 'Featherstonehaugh-Wickersham';

export interface LongContentMemberSeed {
  readonly memberId: string;
  readonly companyName: string;
  readonly planName: string;
}

export async function seedLongContentMember(): Promise<LongContentMemberSeed | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[e2e seed long-content] skipped — DATABASE_URL missing');
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const planYear = new Date().getUTCFullYear();

    // Clone a real active plan row so every NOT NULL column is satisfied,
    // then override plan_id + plan_name. Same technique as lapsed-member-seed.
    const source = (
      await sql<Array<{ plan_id: string; plan_year: number }>>`
        SELECT plan_id, plan_year FROM membership_plans
        WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
        ORDER BY plan_year DESC, created_at ASC
        LIMIT 1
      `
    )[0];
    if (!source) {
      console.warn('[e2e seed long-content] skipped — no active plan to clone');
      return null;
    }

    await sql`
      INSERT INTO membership_plans
        SELECT * FROM membership_plans
        WHERE tenant_id = ${TENANT_ID} AND plan_id = ${source.plan_id}
          AND plan_year = ${source.plan_year}
      ON CONFLICT DO NOTHING
    `;
    await sql`
      UPDATE membership_plans
        SET plan_name = jsonb_build_object('en', ${DUMMY_PLAN_NAME}::text)
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${DUMMY_PLAN_ID}
        AND plan_year = ${planYear}
    `;

    await sql`
      INSERT INTO members (tenant_id, member_id, company_name, country, plan_id,
                           plan_year, status)
      VALUES (${TENANT_ID}, ${DUMMY_MEMBER_ID}, ${DUMMY_COMPANY}, 'TH',
              ${DUMMY_PLAN_ID}, ${planYear}, 'active')
      ON CONFLICT (tenant_id, member_id) DO UPDATE
        SET company_name = EXCLUDED.company_name,
            plan_id = EXCLUDED.plan_id,
            plan_year = EXCLUDED.plan_year
    `;
    await sql`
      INSERT INTO contacts (tenant_id, contact_id, member_id, first_name,
                            last_name, email, is_primary)
      VALUES (${TENANT_ID}, ${DUMMY_CONTACT_ID}, ${DUMMY_MEMBER_ID},
              ${DUMMY_CONTACT_FIRST}, ${DUMMY_CONTACT_LAST},
              'overflow.fixture@e2e.invalid', true)
      ON CONFLICT (tenant_id, contact_id) DO UPDATE
        SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
    `;

    return {
      memberId: DUMMY_MEMBER_ID,
      companyName: DUMMY_COMPANY,
      planName: DUMMY_PLAN_NAME,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
```

Before running, verify the real column list of `members` and `contacts` (`\d members` equivalent — read `src/modules/members/infrastructure/db/schema-contacts.ts` and the members schema file) and add any NOT NULL column this INSERT is missing. Legal-entity/address columns may be required.

- [ ] **Step 2: Write the failing spec**

Create `tests/e2e/members-table-overflow.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signInAsAdmin } from './helpers/admin-session';
import { seedLongContentMember } from './helpers/long-content-member-seed';

/**
 * Regression guard for the directory's fixed-width columns bleeding into
 * their neighbours. `<td>` is overflow:visible under `table-fixed`, so the
 * cell BOX never overlaps — only its painted content does. Therefore assert
 * the content's right edge against the cell's right edge, not scrollWidth.
 */
test.describe('members directory — column overflow @a11y', () => {
  test('Plan and Status cell content stays inside its column', async ({ page }) => {
    const seed = await seedLongContentMember();
    test.skip(seed === null, 'seed unavailable (no DATABASE_URL)');

    await signInAsAdmin(page);
    await page.goto(`/admin/members?q=${encodeURIComponent(seed!.companyName)}`);

    const row = page.getByRole('row').filter({ hasText: seed!.companyName });
    await expect(row).toBeVisible();

    for (const columnIndex of [/* Plan */ 3, /* Status */ 5]) {
      const cell = row.getByRole('cell').nth(columnIndex);
      const bleed = await cell.evaluate((td) => {
        const cellRight = td.getBoundingClientRect().right;
        let worst = 0;
        for (const child of Array.from(td.querySelectorAll('*'))) {
          worst = Math.max(worst, child.getBoundingClientRect().right - cellRight);
        }
        return worst;
      });
      // 1px tolerance for sub-pixel rounding.
      expect(bleed).toBeLessThanOrEqual(1);
    }
  });
});
```

Confirm the column indices against the live header order before trusting them: with the admin selection checkbox the order is select(0), Member No.(1), Company(2), Plan(3), Contact(4), Status(5), Engagement(6), Last activity(7).

- [ ] **Step 3: Run it and confirm it FAILS**

```bash
pnpm test:e2e tests/e2e/members-table-overflow.spec.ts --workers=1
```

Expected: FAIL, with `bleed` well above 1 (the long plan name spills past the Plan column). **If it passes, the fixture is not producing long-enough content — fix the fixture before continuing.** A green test here guards nothing.

- [ ] **Step 4: Commit the red test**

```bash
git add tests/e2e/helpers/long-content-member-seed.ts tests/e2e/members-table-overflow.spec.ts
git commit -m "test(members): failing e2e guard for directory column overflow"
```

---

### Task 2: Fix the Plan and Status cells

**Files:**
- Modify: `src/components/members/members-table.tsx:554-569` (Plan), `:609-662` (Status)

**Interfaces:**
- Consumes: nothing. Produces: nothing (presentation only).

- [ ] **Step 1: Fix the Plan cell**

Replace the cell renderer at `:561-567`:

```tsx
        return (
          <span title={row.plan_id} className="text-sm whitespace-nowrap">
            {label}
            <span aria-hidden="true"> · </span>
            {row.plan_year}
          </span>
        );
```

with:

```tsx
        return (
          // 057 overflow fix — `whitespace-normal break-words` replaces
          // `whitespace-nowrap`. Under `table-fixed` + <colgroup>, nowrap
          // content wider than the 150px column PAINTS OVER the next column
          // (td is overflow:visible). Wrapping keeps a long plan name inside
          // its column; short names still render on one line, so row density
          // is unchanged for the common case. `break-words` covers a single
          // long token with no spaces.
          <span
            title={row.plan_id}
            className="text-sm whitespace-normal break-words"
          >
            {label}
            <span aria-hidden="true"> · </span>
            {row.plan_year}
          </span>
        );
```

- [ ] **Step 2: Fix the Status cell**

At `:616`, change the wrapper from a horizontal row to a vertical stack:

```tsx
        <span className="inline-flex items-center gap-1.5">
```

becomes:

```tsx
        // 057 overflow fix — the status control plus a Lapsed/Suspended badge
        // exceeds the 130px column when laid out horizontally and painted over
        // the Engagement column. Stacking drops the badge onto its own line.
        // The badge MUST stay a sibling of InlineStatusCell (never a child) —
        // inside the <button> it would fire the status toggle and pollute the
        // button's accessible name.
        <span className="flex flex-col items-start gap-1">
```

- [ ] **Step 3: Run the E2E guard — it must now PASS**

```bash
pnpm test:e2e tests/e2e/members-table-overflow.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 4: Run the directory a11y + existing table tests**

```bash
pnpm test:e2e tests/e2e/members-a11y.spec.ts --workers=1
pnpm test tests/unit/members
pnpm typecheck
```

Expected: all PASS. If a component test asserted `whitespace-nowrap`, delete that assertion rather than reverting the fix — asserting class names is a known-brittle pattern here.

- [ ] **Step 5: Commit**

```bash
git add src/components/members/members-table.tsx
git commit -m "fix(members): stop Plan and Status cells overflowing adjacent columns"
```

---

# PHASE B — Portal status badge

Depends on nothing in Phase A (they touch different cells of the same file — if both are in flight, land A first).

### Task 3: Domain — `derivePortalState`

**Files:**
- Create: `src/modules/members/domain/portal-state.ts`
- Test: `tests/unit/members/domain/portal-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PortalState = 'active' | 'invited' | 'invite_expired' | 'not_invited';
  export function derivePortalState(input: {
    readonly linkedUserId: string | null;
    readonly pendingInvitation: { readonly expiresAt: Date } | null;
    readonly now: Date;
  }): PortalState;
  ```

**Coverage note:** `src/modules/members/domain/**` carries a blanket 100% threshold on **lines, branches, functions AND statements** (`vitest.config.ts:190-195`). Four rules, four-plus tests.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/members/domain/portal-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derivePortalState } from '@/modules/members/domain/portal-state';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';

describe('derivePortalState', () => {
  it('returns not_invited when no user is linked', () => {
    expect(
      derivePortalState({ linkedUserId: null, pendingInvitation: null, now: NOW }),
    ).toBe('not_invited');
  });

  it('returns not_invited even if an invitation somehow exists without a link', () => {
    expect(
      derivePortalState({
        linkedUserId: null,
        pendingInvitation: { expiresAt: new Date('2026-07-30T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('not_invited');
  });

  it('returns active when a user is linked and no invitation is pending', () => {
    expect(
      derivePortalState({ linkedUserId: USER, pendingInvitation: null, now: NOW }),
    ).toBe('active');
  });

  it('returns invited when the pending invitation is still live', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: new Date('2026-07-30T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('invited');
  });

  it('returns invite_expired when the pending invitation is past expiry', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: new Date('2026-07-20T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('invite_expired');
  });

  it('treats expiry exactly at now as expired (matches the detail page boundary)', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: NOW },
        now: NOW,
      }),
    ).toBe('invite_expired');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test tests/unit/members/domain/portal-state.test.ts
```

Expected: FAIL — cannot resolve `@/modules/members/domain/portal-state`.

- [ ] **Step 3: Implement**

Create `src/modules/members/domain/portal-state.ts`:

```ts
/**
 * Portal-access state of a member's PRIMARY contact, as shown in the admin
 * members directory (design doc 2026-07-23 §3.1, D1/D2).
 *
 * Pure domain — no framework imports. `now` is injected so the badge (derived
 * here) and the needs-invite SQL filter (derived from a bound timestamp) judge
 * expiry against the SAME instant (D8).
 *
 * `linkedUserId === null` safely means "never invited": `contacts.linked_user_id`
 * has an FK to `users` with ON DELETE SET NULL (0009_members_contacts.sql:137),
 * so the nightly prune of expired pending users nulls the column rather than
 * leaving a dangling id. (The Drizzle schema declares the column without the
 * reference — read the migration, not schema-contacts.ts.)
 */

export type PortalState =
  | 'active'
  | 'invited'
  | 'invite_expired'
  | 'not_invited';

export interface DerivePortalStateInput {
  readonly linkedUserId: string | null;
  /**
   * The FRESHEST unconsumed invitation for the linked user, or null when the
   * user has none (which — given the repo's never-redeemed anti-join — means
   * they activated). The repo is responsible for picking "freshest"; this
   * function trusts it.
   */
  readonly pendingInvitation: { readonly expiresAt: Date } | null;
  readonly now: Date;
}

export function derivePortalState(input: DerivePortalStateInput): PortalState {
  if (input.linkedUserId === null) return 'not_invited';
  if (input.pendingInvitation === null) return 'active';
  // `<=` matches the detail page's inline expiry test
  // (admin/members/[memberId]/page.tsx:270-276) so the two surfaces cannot
  // disagree on a borderline invitation.
  return input.pendingInvitation.expiresAt.getTime() <= input.now.getTime()
    ? 'invite_expired'
    : 'invited';
}
```

- [ ] **Step 4: Point the detail page's copy of this rule at the new helper**

The member detail page derives the same expiry verdict inline
(`src/app/(staff)/admin/members/[memberId]/page.tsx:270-276`). Migrating it is
out of scope, so leave a breadcrumb so the next person to touch either one sees
the other. Extend that existing JSDoc block with:

```ts
   * The SAME `expiresAt <= now` boundary is implemented by
   * `derivePortalState` (src/modules/members/domain/portal-state.ts), which
   * powers the directory's portal badge. Change one and you must change the
   * other, or the detail page and the directory will disagree about a
   * borderline invitation. The boundary case is pinned by
   * tests/unit/members/domain/portal-state.test.ts.
```

This is the whole "drift guard" — a test that re-implements the detail page's
expression would only assert against its own copy and prove nothing.

- [ ] **Step 5: Run the test and the coverage gate**

```bash
pnpm test tests/unit/members/domain/portal-state.test.ts
pnpm typecheck
```

Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/domain/portal-state.ts \
        tests/unit/members/domain/portal-state.test.ts \
        src/app/\(staff\)/admin/members/\[memberId\]/page.tsx
git commit -m "feat(members): add derivePortalState domain rule"
```

---

### Task 4: Repo — batched pending-invitation read

**Files:**
- Modify: `src/modules/members/application/ports/member-repo.ts` (add to the `MemberRepo` interface, near `findPendingInvitationsForMember` ~:362)
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (implement beside `findPendingInvitationsForMember` ~:1402)
- Test: `tests/integration/members/portal-status-batch-read.test.ts`

**Interfaces:**
- Produces:
  ```ts
  findPendingInvitationsForPrimaryContacts(
    ctx: TenantContext,
    memberIds: readonly MemberId[],
  ): Promise<Result<ReadonlyArray<{
    readonly memberId: MemberId;
    readonly expiresAt: Date;
  }>, RepoError>>
  ```

**Read first:** `drizzle-member-repo.ts:1370-1465`. You are porting that method, and it carries two guards that are the entire point of this task. Losing either reintroduces a bug the team closed on 2026-07-12.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/members/portal-status-batch-read.test.ts`. It reuses the seeding helpers from `tests/integration/members/find-pending-invitations.test.ts` — **copy `seedPlan`, `seedMemberWithContact`, `seedInvitation` and the `MATRIX` constant from that file verbatim** (they are file-local there, not shared), with one addition: `seedMemberWithContact` needs an `isPrimary` option and a "second contact" helper.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-portal-batch-plan';
const DAY = 86_400_000;

// MATRIX + seedPlan + seedMemberWithContact + seedInvitation: copy from
// find-pending-invitations.test.ts, changing PLAN_ID to the constant above.
// Add `isPrimary` to seedMemberWithContact's options (defaulting to true) and
// pass it through to the contacts insert.

/** Add a SECOND (non-primary) contact to an existing member. */
async function addSecondaryContact(
  tenant: TestTenant,
  memberId: string,
  linkedUserId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Secondary',
      lastName: 'Contact',
      email: `sec-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId,
      removedAt: null,
    });
  });
}

describe('findPendingInvitationsForPrimaryContacts', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    otherTenant = await createTestTenant('test');
    await seedPlan(tenant.ctx.slug, adminUser.userId);
    await seedPlan(otherTenant.ctx.slug, adminUser.userId);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await otherTenant.cleanup().catch(() => {});
  });

  it('returns an empty array for an empty id list', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns the live invitation for an invited primary contact', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]?.memberId).toBe(memberId);
    expect(res.value[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('EXCLUDES an already-active user holding a stale unconsumed row (anti-join)', async () => {
    // reissueInvitation mints a new row without invalidating the old one, so a
    // user who ACTIVATED keeps an unconsumed+expired row forever. Without the
    // anti-join this member is badged invite_expired permanently and never
    // leaves the needs-invite chip.
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
      consumedAt: null, // the stale row
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 3 * DAY),
      expiresAt: new Date(Date.now() + 4 * DAY),
      consumedAt: new Date(Date.now() - 2 * DAY), // they activated
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns exactly one row — the FRESHEST invitation — when several are unconsumed', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
    });
    const liveExpiry = new Date(Date.now() + 5 * DAY);
    await seedInvitation(invitee.userId, adminUser.userId, {
      expiresAt: liveExpiry,
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    // The LIVE one wins — otherwise the row derives to invite_expired and
    // contradicts the SQL filter, which excludes members holding a live invite.
    expect(res.value[0]?.expiresAt.getTime()).toBe(liveExpiry.getTime());
  });

  it('ignores a SECONDARY contact’s invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: null, // primary is NOT invited
    });
    await addSecondaryContact(tenant, memberId as string, invitee.userId);
    await seedInvitation(invitee.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns one row per member across a full 50-member page', async () => {
    // Guards against copying the single-member method's `.limit(50)`, which
    // would silently drop badges at exactly the directory page size.
    const ids: MemberId[] = [];
    for (let i = 0; i < 50; i++) {
      const invitee = await createActiveTestUser('member');
      const { memberId } = await seedMemberWithContact(tenant, {
        linkedUserId: invitee.userId,
      });
      await seedInvitation(invitee.userId, adminUser.userId);
      ids.push(memberId);
    }

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      ids,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(50);
  }, 120_000);

  it('does not leak another tenant’s invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(otherTenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId);

    // Query tenant A's repo with tenant B's member id.
    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('documents cross-tenant invitation visibility for a user linked in two tenants', async () => {
    // `invitations` is not tenant-scoped (no tenant column, no RLS), so a user
    // who is a contact in BOTH tenants carries the invitation state issued by
    // either one. This asserts CURRENT behaviour and pins it so a future change
    // is deliberate — see design doc §6 "cross-tenant state inference".
    const shared = await createActiveTestUser('member');
    const { memberId: aMember } = await seedMemberWithContact(tenant, {
      linkedUserId: shared.userId,
    });
    await seedMemberWithContact(otherTenant, { linkedUserId: shared.userId });
    // The invitation is issued in the OTHER tenant's flow.
    await seedInvitation(shared.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [aMember],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
  });

  it('rejects reading a non-granted invitations column under chamber_app', async () => {
    // The harness seeds via the OWNER-role `db` singleton, which reads
    // invitations.id freely; only runInTenant sets ROLE chamber_app. The
    // assertion MUST go through runInTenant or it proves nothing.
    await expect(
      runInTenant(tenant.ctx, async (tx) =>
        tx.select({ id: invitations.id }).from(invitations).limit(1),
      ),
    ).rejects.toThrow(/42501|permission denied/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test:integration tests/integration/members/portal-status-batch-read.test.ts
```

Expected: FAIL — `findPendingInvitationsForPrimaryContacts is not a function`.

- [ ] **Step 3: Add the port method**

In `member-repo.ts`, directly after `findPendingInvitationsForMember`:

```ts
  /**
   * Directory batch read (design doc 2026-07-23 §3.2) — for each supplied
   * member, the FRESHEST unconsumed invitation held by its PRIMARY contact.
   * A member with no such invitation is simply absent from the result.
   *
   * Same two guards as `findPendingInvitationsForMember`, and they are
   * load-bearing:
   *   1. never-redeemed anti-join — `reissueInvitation` mints a new row
   *      without invalidating the old one, so a user who activated keeps a
   *      stale unconsumed row forever. Without the anti-join that member is
   *      reported as still needing an invite, permanently.
   *   2. DISTINCT ON (member_id) ORDER BY expires_at DESC — one contact can
   *      hold several unconsumed invitations; without this the caller's Map
   *      is last-write-wins over an unordered result and invited vs
   *      invite_expired becomes non-deterministic.
   *
   * NO `LIMIT`: the single-member method caps at 50 contacts, which is safe
   * for one member but would silently truncate a 50-member page.
   *
   * Tenant scope: `contacts` is RLS-bound inside `runInTenant`; the auth
   * `invitations` table is cross-tenant by design, so the join through
   * `contacts` is what enforces the boundary. Only `user_id`, `consumed_at`
   * and `expires_at` may be referenced (migration 0017 column grants).
   *
   * Callers MUST pass a page-bounded id list (directory PAGE_SIZE = 50).
   */
  findPendingInvitationsForPrimaryContacts(
    ctx: TenantContext,
    memberIds: readonly MemberId[],
  ): Promise<
    Result<
      ReadonlyArray<{
        readonly memberId: MemberId;
        readonly expiresAt: Date;
      }>,
      RepoError
    >
  >;
```

- [ ] **Step 4: Implement the adapter**

In `drizzle-member-repo.ts`, immediately after `findPendingInvitationsForMember` (all imports used below — `alias`, `notExists`, `isNotNull`, `desc`, `inArray`, `eq`, `and`, `isNull`, `sql` — are already imported in this file):

```ts
  async findPendingInvitationsForPrimaryContacts(ctx, memberIds) {
    if (memberIds.length === 0) return ok([]);
    try {
      const rows = await runInTenant(ctx, async (tx) => {
        // Second reference to `invitations` for the active-user anti-join,
        // aliased so the correlated user_id refs resolve unambiguously.
        const consumedInv = alias(invitations, 'consumed_inv');
        return tx
          .selectDistinctOn([contacts.memberId], {
            memberId: contacts.memberId,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .innerJoin(contacts, eq(contacts.linkedUserId, invitations.userId))
          .where(
            and(
              inArray(contacts.memberId, [...memberIds]),
              eq(contacts.isPrimary, true),
              isNull(contacts.removedAt),
              // An expired-but-unconsumed invite MUST surface (it is the
              // re-invite signal), so there is deliberately no expires_at
              // filter here.
              isNull(invitations.consumedAt),
              // Never-redeemed anti-join — see the port doc, guard 1.
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(consumedInv)
                  .where(
                    and(
                      eq(consumedInv.userId, invitations.userId),
                      isNotNull(consumedInv.consumedAt),
                    ),
                  ),
              ),
            ),
          )
          // DISTINCT ON (member_id) requires member_id to lead ORDER BY;
          // expires_at DESC then keeps the freshest unconsumed invite.
          .orderBy(contacts.memberId, desc(invitations.expiresAt));
      });
      return ok(
        rows.map((r) => ({
          memberId: r.memberId as MemberId,
          expiresAt: r.expiresAt,
        })),
      );
    } catch (e) {
      return err(unexpected(e));
    }
  },
```

- [ ] **Step 5: Run the integration test until green**

```bash
pnpm test:integration tests/integration/members/portal-status-batch-read.test.ts
pnpm typecheck
```

Expected: all cases PASS. If the anti-join case fails, you dropped `notExists` — re-read guard 1.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/application/ports/member-repo.ts \
        src/modules/members/infrastructure/db/drizzle-member-repo.ts \
        tests/integration/members/portal-status-batch-read.test.ts
git commit -m "feat(members): batched pending-invitation read for primary contacts"
```

---

### Task 5: Use case — `loadMembersPortalStatus`

**Files:**
- Create: `src/modules/members/application/use-cases/load-members-portal-status.ts`
- Modify: `src/modules/members/index.ts`
- Test: `tests/unit/members/application/load-members-portal-status.test.ts`

**Interfaces:**
- Consumes: `derivePortalState`, `PortalState` (Task 3); `findPendingInvitationsForPrimaryContacts` (Task 4).
- Produces:
  ```ts
  loadMembersPortalStatus(
    deps: { readonly tenant: TenantContext; readonly memberRepo: MemberRepo },
    input: {
      readonly members: readonly { readonly memberId: string; readonly linkedUserId: string | null }[];
      readonly now: Date;
    },
  ): Promise<Result<ReadonlyMap<string, PortalState>, never>>
  ```

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/members/application/load-members-portal-status.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadMembersPortalStatus } from '@/modules/members/application/use-cases/load-members-portal-status';
import { ok } from '@/lib/result';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const ctx = { slug: 'swecham' } as never;
const M1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const M2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const U1 = 'cccccccc-3333-4333-8333-333333333333';

function repoWith(rows: Array<{ memberId: string; expiresAt: Date }>) {
  return {
    findPendingInvitationsForPrimaryContacts: vi.fn().mockResolvedValue(ok(rows)),
  } as never;
}

describe('loadMembersPortalStatus', () => {
  it('returns an empty map and makes NO repo call for an empty list', async () => {
    const memberRepo = repoWith([]);
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      { members: [], now: NOW },
    );
    expect(res.ok && res.value.size).toBe(0);
    expect(
      (memberRepo as unknown as { findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn> })
        .findPendingInvitationsForPrimaryContacts,
    ).not.toHaveBeenCalled();
  });

  it('makes NO repo call when every member is unlinked, and maps them all to not_invited', async () => {
    const memberRepo = repoWith([]);
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      { members: [{ memberId: M1, linkedUserId: null }], now: NOW },
    );
    expect(res.ok && res.value.get(M1)).toBe('not_invited');
    expect(
      (memberRepo as unknown as { findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn> })
        .findPendingInvitationsForPrimaryContacts,
    ).not.toHaveBeenCalled();
  });

  it('maps a linked member with no pending invitation to active', async () => {
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo: repoWith([]) },
      { members: [{ memberId: M1, linkedUserId: U1 }], now: NOW },
    );
    expect(res.ok && res.value.get(M1)).toBe('active');
  });

  it('maps live and expired invitations to invited / invite_expired', async () => {
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo: repoWith([
        { memberId: M1, expiresAt: new Date('2026-07-30T00:00:00.000Z') },
        { memberId: M2, expiresAt: new Date('2026-07-01T00:00:00.000Z') },
      ]) },
      {
        members: [
          { memberId: M1, linkedUserId: U1 },
          { memberId: M2, linkedUserId: U1 },
        ],
        now: NOW,
      },
    );
    expect(res.ok && res.value.get(M1)).toBe('invited');
    expect(res.ok && res.value.get(M2)).toBe('invite_expired');
  });

  it('only queries for members that actually have a linked user', async () => {
    const memberRepo = repoWith([]);
    await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      {
        members: [
          { memberId: M1, linkedUserId: U1 },
          { memberId: M2, linkedUserId: null },
        ],
        now: NOW,
      },
    );
    const spy = (memberRepo as unknown as {
      findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn>;
    }).findPendingInvitationsForPrimaryContacts;
    expect(spy).toHaveBeenCalledWith(ctx, [M1]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test tests/unit/members/application/load-members-portal-status.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/modules/members/application/use-cases/load-members-portal-status.ts`:

```ts
/**
 * Members-directory batch read — portal state per member (design doc
 * 2026-07-23 §3.3). Mirrors `loadMembersMembershipStatus` (renewals), which
 * the same page already uses for the Lapsed/Suspended badges.
 *
 * ONE query per page, never per row. Two short-circuits avoid the round-trip
 * entirely: an empty page, and a page on which nobody is linked to a user.
 *
 * `now` is supplied by the CALLER and never read from a clock here, so the
 * badge and the needs-invite SQL filter judge expiry against the same instant
 * (design D8).
 *
 * A member absent from the returned map has NO primary contact. Absence never
 * means "the read failed" — the caller owns the degrade path and represents
 * failure as 'unknown', so a DB hiccup can never be rendered as "not invited".
 *
 * `Result<…, never>`: there is no domain error, only a thrown repo call, which
 * the caller catches.
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { derivePortalState, type PortalState } from '../../domain/portal-state';
import type { MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';

export interface LoadMembersPortalStatusDeps {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
}

export interface LoadMembersPortalStatusInput {
  /**
   * The current directory page's members. CONTRACT: page-bounded (≤ a few
   * hundred) — this is per-page badge enrichment, not a bulk lookup.
   */
  readonly members: readonly {
    readonly memberId: string;
    readonly linkedUserId: string | null;
  }[];
  readonly now: Date;
}

export async function loadMembersPortalStatus(
  deps: LoadMembersPortalStatusDeps,
  input: LoadMembersPortalStatusInput,
): Promise<Result<ReadonlyMap<string, PortalState>, never>> {
  const result = new Map<string, PortalState>();
  const linked = input.members.filter((m) => m.linkedUserId !== null);

  for (const m of input.members) {
    if (m.linkedUserId === null) result.set(m.memberId, 'not_invited');
  }
  if (linked.length === 0) return ok(result);

  const pending = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
    deps.tenant,
    linked.map((m) => m.memberId as MemberId),
  );
  const byMember = new Map<string, Date>();
  if (pending.ok) {
    for (const row of pending.value) byMember.set(row.memberId, row.expiresAt);
  }

  for (const m of linked) {
    const expiresAt = byMember.get(m.memberId);
    result.set(
      m.memberId,
      derivePortalState({
        linkedUserId: m.linkedUserId,
        pendingInvitation: expiresAt ? { expiresAt } : null,
        now: input.now,
      }),
    );
  }
  return ok(result);
}
```

- [ ] **Step 4: Export through the barrel**

In `src/modules/members/index.ts`, add to the existing export blocks (match the file's grouping style):

```ts
  loadMembersPortalStatus,
```
and the type exports:
```ts
  type PortalState,
```

This is mandatory: `page.tsx` and `members-table.tsx` both live outside the module, and ESLint `no-restricted-imports` blocks deep imports. `pnpm typecheck` does NOT catch it — only `pnpm lint` does.

- [ ] **Step 5: Run tests + lint**

```bash
pnpm test tests/unit/members/application/load-members-portal-status.test.ts
pnpm lint
pnpm typecheck
```

Expected: 5 passing, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/application/use-cases/load-members-portal-status.ts \
        src/modules/members/index.ts \
        tests/unit/members/application/load-members-portal-status.test.ts
git commit -m "feat(members): loadMembersPortalStatus directory batch read"
```

---

### Task 6: i18n keys + page wiring

**Files:**
- Modify: `src/i18n/messages/en.json`, `th.json`, `sv.json`
- Modify: `src/app/(staff)/admin/members/page.tsx`
- Modify: `src/components/members/members-table.tsx` (row type only)

**Interfaces:**
- Consumes: `loadMembersPortalStatus`, `PortalState` (Task 5).
- Produces: `MembersTableRow.portal_state: PortalState | 'unknown' | null`.

**Copy rule (design §3.5):** labels must be SHORT. `Badge` is `h-5 … overflow-hidden whitespace-nowrap shrink-0` (`badge.tsx:8`) — a badge never wraps and never shrinks, and the Contact column has ~151px of usable width. The detail page's Swedish `"Inbjudan har gått ut"` alone is ~150px, so reusing detail-page copy would recreate the overflow Phase A just fixed. Short visible label + `sr-only` full sentence, exactly like `membershipLapsed` / `membershipLapsedSr` in the same table.

- [ ] **Step 1: Add the i18n keys**

In `en.json` under `admin.members.directory`, beside `membershipLapsed`:

```json
      "portal": {
        "linked": "Portal",
        "linkedSr": "Portal account active",
        "invited": "Invited",
        "invitedSr": "Portal invitation sent, awaiting acceptance",
        "expired": "Expired",
        "expiredSr": "Portal invitation expired — needs re-sending",
        "notInvited": "Not invited",
        "notInvitedSr": "No portal invitation sent yet"
      },
```

`th.json`:

```json
      "portal": {
        "linked": "พอร์ทัล",
        "linkedSr": "ใช้งานบัญชีพอร์ทัลแล้ว",
        "invited": "เชิญแล้ว",
        "invitedSr": "ส่งคำเชิญพอร์ทัลแล้ว รอผู้รับตอบรับ",
        "expired": "หมดอายุ",
        "expiredSr": "คำเชิญพอร์ทัลหมดอายุ ต้องส่งใหม่",
        "notInvited": "ยังไม่เชิญ",
        "notInvitedSr": "ยังไม่ได้ส่งคำเชิญพอร์ทัล"
      },
```

`sv.json`:

```json
      "portal": {
        "linked": "Portal",
        "linkedSr": "Portalkontot är aktivt",
        "invited": "Inbjuden",
        "invitedSr": "Portalinbjudan skickad, väntar på svar",
        "expired": "Utgången",
        "expiredSr": "Portalinbjudan har gått ut — behöver skickas om",
        "notInvited": "Ej inbjuden",
        "notInvitedSr": "Ingen portalinbjudan har skickats"
      },
```

Run `pnpm check:i18n` — expected: clean.

- [ ] **Step 2: Extend the row type**

In `members-table.tsx`, add to `MembersTableRow` after `membership_suspended`:

```ts
  /**
   * Portal state of the PRIMARY contact (design doc 2026-07-23 §3.5).
   * `null`  = the member has no primary contact (nothing to render).
   * 'unknown' = the batch read failed; renders nothing, but is deliberately
   * distinct from 'not_invited' so a DB hiccup is never displayed as
   * "this member still needs inviting".
   */
  readonly portal_state: PortalState | 'unknown' | null;
```

with `import type { PortalState } from '@/modules/members';` at the top (type-only import — erased at compile time, so no server graph reaches the client bundle; same pattern as the existing `EngagementBand` import).

- [ ] **Step 3: Wire the page**

In `page.tsx`:

Add the import:
```ts
import {
  directorySearchWithCount,
  formatMemberNumber,
  loadMembersPortalStatus,
  MEMBER_STATUSES,
  resolveMemberNumberPrefix,
  type PortalState,
} from '@/modules/members';
```

Add the degrade wrapper next to `loadMembersMembershipStatusSafe`. It returns
`null` on failure — **not** an empty Map — so the row mapper can distinguish
"the read failed" from "this member has no primary contact":

```ts
/**
 * Best-effort portal-status enrichment. A failure must NEVER take down the
 * directory — but it must also never look like an answer: on failure every
 * member degrades to 'unknown' (renders nothing), never to 'not_invited',
 * which would claim they still need inviting.
 */
async function loadMembersPortalStatusSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberRepo: ReturnType<typeof buildMembersDeps>['memberRepo'],
  membersOnPage: readonly {
    readonly memberId: string;
    readonly linkedUserId: string | null;
  }[],
  now: Date,
): Promise<ReadonlyMap<string, PortalState> | null> {
  try {
    const res = await loadMembersPortalStatus(
      { tenant, memberRepo },
      { members: membersOnPage, now },
    );
    return res.ok ? res.value : null;
  } catch (e) {
    logger.warn(
      {
        tenantId: tenant.slug,
        errKind: errKind(e),
        memberIdsCount: membersOnPage.length,
      },
      '[members-portal] loadMembersPortalStatus threw — portal badges suppressed',
    );
    return null;
  }
}
```

Add one shared `now` above the second `Promise.all` (design D8):

```ts
  // D8 — ONE instant for every expiry decision on this render.
  const now = new Date();
```

Extend the existing second `Promise.all` at `:320`:

```ts
  const memberIds = result.value.items.map((row) => row.member.memberId);
  const [memberPrefix, membershipStatus, portalStatus] = await Promise.all([
    resolveMemberNumberPrefix(tenant, deps.memberSettings),
    loadMembersMembershipStatusSafe(tenant, memberIds),
    loadMembersPortalStatusSafe(
      tenant,
      deps.memberRepo,
      result.value.items.map((row) => ({
        memberId: row.member.memberId,
        linkedUserId: row.primaryContact?.linkedUserId ?? null,
      })),
      now,
    ),
  ]);
```

In the row mapper, add:

```ts
    portal_state:
      row.primaryContact === null
        ? null
        : portalStatus === null
          ? 'unknown'
          : (portalStatus.get(row.member.memberId) ?? 'unknown'),
```

- [ ] **Step 4: Typecheck and run the page-boundary tests**

```bash
pnpm typecheck
pnpm test tests/unit/members
```

Expected: PASS. The table will not render badges yet — that is Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages src/app/\(staff\)/admin/members/page.tsx src/components/members/members-table.tsx
git commit -m "feat(members): thread portal state into the directory page rows"
```

---

### Task 7: Render the badge

**Files:**
- Modify: `src/components/members/members-table.tsx` (Contact cell ~:572)
- Modify: `src/components/members/members-table-skeleton.tsx`
- Test: `tests/unit/members/portal-badge.test.tsx` (new; follow the conventions of an existing `.test.tsx` in `tests/unit/members/`)

**Interfaces:**
- Consumes: `MembersTableRow.portal_state` (Task 6), the `admin.members.directory.portal.*` keys (Task 6).

- [ ] **Step 1: Write the failing component test**

Create `tests/unit/members/portal-badge.test.tsx`. Copy the `NextIntlClientProvider` wrapper and `render` setup from an existing `.test.tsx` in `tests/unit/members/` (e.g. `bundle-change-warning-dialog.test.tsx`) — it must use the real `src/i18n/messages/en.json`, not a stub, so a missing key fails the test.

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  MembersTable,
  type MembersTableRow,
} from '@/components/members/members-table';

function row(overrides: Partial<MembersTableRow>): MembersTableRow {
  return {
    member_id: 'm-default',
    member_number_display: 'SCCM-0001',
    company_name: 'Test Co',
    country: 'TH',
    plan_id: 'plan-a',
    plan_year: 2026,
    plan_display_name: 'Corporate Gold',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    engagement: null,
    last_activity_at: null,
    portal_state: null,
    primary_contact: {
      contact_id: 'c-default',
      first_name: 'Anna',
      last_name: 'Berg',
      email: 'anna@example.com',
      invite_bounced: false,
    },
    ...overrides,
  };
}

function renderTable(rows: MembersTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={rows} nextCursor={null} />
    </NextIntlClientProvider>,
  );
}

describe('portal status badge', () => {
  it('renders the portal label for each state', () => {
    renderTable([
      row({ member_id: 'm1', portal_state: 'active' }),
      row({ member_id: 'm2', portal_state: 'invited' }),
      row({ member_id: 'm3', portal_state: 'invite_expired' }),
      row({ member_id: 'm4', portal_state: 'not_invited' }),
    ]);
    expect(screen.getByText('Portal')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Not invited')).toBeInTheDocument();
  });

  it('renders no portal badge for unknown state', () => {
    renderTable([row({ member_id: 'm5', portal_state: 'unknown' })]);
    expect(screen.queryByText('Portal')).not.toBeInTheDocument();
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });

  it('renders no portal badge when the member has no primary contact', () => {
    renderTable([row({ member_id: 'm6', portal_state: null, primary_contact: null })]);
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });

  it('suppresses the invite-bounced badge when the invitation also expired', () => {
    renderTable([
      row({
        member_id: 'm7',
        portal_state: 'invite_expired',
        primary_contact: {
          contact_id: 'c7',
          first_name: 'Bounced',
          last_name: 'Expired',
          email: 'b@example.com',
          invite_bounced: true,
        },
      }),
    ]);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    // Two red MailWarning badges for one root cause is the a11y double-badge
    // finding the detail page already fixed ([memberId]/page.tsx:415-417).
    expect(
      screen.queryByText(messages.admin.members.detail.inviteBounced.badge),
    ).not.toBeInTheDocument();
  });

  it('suppresses the invite-bounced badge once the contact is active', () => {
    renderTable([
      row({
        member_id: 'm8',
        portal_state: 'active',
        primary_contact: {
          contact_id: 'c8',
          first_name: 'Bounced',
          last_name: 'ThenActive',
          email: 'c@example.com',
          invite_bounced: true,
        },
      }),
    ]);
    expect(
      screen.queryByText(messages.admin.members.detail.inviteBounced.badge),
    ).not.toBeInTheDocument();
  });

  it('renders no portal badge on an archived row', () => {
    renderTable([
      row({ member_id: 'm9', status: 'archived', portal_state: 'not_invited' }),
    ]);
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });
});
```

Assert on **text**, never on class names, `variant` values, or icon component names. If `MembersTable` needs a `useSearchParams`/router mock in this environment, copy that mock from whichever existing test already renders it.

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test tests/unit/members/portal-badge.test.tsx
```

Expected: FAIL — no such text rendered.

- [ ] **Step 3: Implement the badge**

Add above `MembersTable` in `members-table.tsx`:

```tsx
/**
 * Portal-state badge for the Contact cell (design doc 2026-07-23 §3.5).
 *
 * Short visible label + sr-only sentence — `Badge` is overflow-hidden,
 * nowrap and shrink-0, so a long label cannot wrap and would paint over the
 * next column. Every state pairs an icon and text with its colour, so nothing
 * is encoded by colour alone (WCAG 1.4.1).
 *
 * `active` uses `secondary`, not `default`: the solid primary token would make
 * the most common and least actionable state the loudest thing on a 50-row
 * page, and it is the same token as the detail page's "Primary" contact badge.
 */
function PortalBadge({ state }: { state: MembersTableRow['portal_state'] }) {
  const t = useTranslations('admin.members.directory');
  if (state === null || state === 'unknown') return null;
  if (state === 'active') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckIcon aria-hidden="true" className="size-3" />
        <span aria-hidden="true">{t('portal.linked')}</span>
        <span className="sr-only">{t('portal.linkedSr')}</span>
      </Badge>
    );
  }
  if (state === 'not_invited') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <span aria-hidden="true">{t('portal.notInvited')}</span>
        <span className="sr-only">{t('portal.notInvitedSr')}</span>
      </Badge>
    );
  }
  const expired = state === 'invite_expired';
  return (
    <Badge
      variant="outline"
      className={
        expired
          ? 'gap-1 border-destructive/40 text-destructive'
          : 'gap-1 border-warning/40 text-warning'
      }
    >
      <MailWarning aria-hidden="true" className="size-3" />
      <span aria-hidden="true">{t(expired ? 'portal.expired' : 'portal.invited')}</span>
      <span className="sr-only">{t(expired ? 'portal.expiredSr' : 'portal.invitedSr')}</span>
    </Badge>
  );
}
```

Add `CheckIcon` and `MailWarning` to the existing `lucide-react` import.

Then restructure the Contact cell body (`:579-605`) so the name and the badge row stack:

```tsx
        return (
          <span className="flex flex-col gap-1">
            <span className="flex items-start gap-1.5">
              <span
                className="min-w-0 max-w-[18ch] break-words whitespace-normal"
                title={fullName}
              >
                {fullName}
              </span>
            </span>
            {/* flex-wrap is required: Badge is shrink-0, so without it the
                badge row overflows the 175px column instead of wrapping. */}
            <span className="flex flex-wrap items-center gap-1">
              <PortalBadge state={info.row.original.portal_state} />
              {/* Bounce badge suppressed when the invitation ALSO expired or
                  the contact is already active — one root cause, one recovery
                  (mirrors admin/members/[memberId]/page.tsx:415-417). */}
              {c.invite_bounced &&
              info.row.original.portal_state !== 'invite_expired' &&
              info.row.original.portal_state !== 'active' ? (
                <Badge
                  variant="outline"
                  className="shrink-0 gap-1 border-destructive/40 text-destructive"
                >
                  <TriangleAlert aria-hidden="true" className="size-3" />
                  <span aria-hidden="true">{tContact('inviteBounced.badge')}</span>
                  <span className="sr-only">{tContact('inviteBounced.badgeAria')}</span>
                </Badge>
              ) : null}
            </span>
          </span>
        );
```

Suppress portal badges on archived rows the same way the Lapsed badge is suppressed (`:635`): pass `null` when `info.row.original.status === 'archived'`.

- [ ] **Step 4: Update the skeleton**

In `members-table-skeleton.tsx`, the row cells are single `Skeleton` blocks. Give each body row a second shorter line so the shimmer height matches the now-two-line Contact cell:

```tsx
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className="flex flex-col gap-1">
              <Skeleton className="h-5 w-full" />
              {/* 057 — the real Contact cell now stacks a badge under the
                  name, so the shimmer needs the same height or every row
                  jumps when data lands (CLS, ux-standards § 2.1). */}
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
```

- [ ] **Step 5: Extend the overflow spec to Swedish and Thai**

The badge labels are longest in `sv` and `th`, and `Badge` cannot wrap — so those
locales are where a too-long label shows up first. Add to
`tests/e2e/members-table-overflow.spec.ts`, extracting the assertion body from
Task 1 into a shared helper first:

```ts
for (const locale of ['en', 'sv', 'th'] as const) {
  test(`content stays inside its column in ${locale} @i18n`, async ({ page }) => {
    const seed = await seedLongContentMember();
    test.skip(seed === null, 'seed unavailable (no DATABASE_URL)');

    await signInAsAdmin(page);
    await page.goto(
      `/${locale}/admin/members?q=${encodeURIComponent(seed!.companyName)}`,
    );
    await expectNoCellBleed(page, seed!.companyName, [3, 4, 5]);
  });
}
```

Check how the repo's existing `@i18n` specs switch locale (path prefix vs cookie)
and follow that; note column 4 (Contact) is now included because it carries the
badge row.

- [ ] **Step 6: Run tests + a11y**

```bash
pnpm test tests/unit/members/portal-badge.test.tsx
pnpm test:e2e tests/e2e/members-table-overflow.spec.ts --workers=1
pnpm test:e2e tests/e2e/members-a11y.spec.ts --workers=1
pnpm typecheck && pnpm lint && pnpm check:i18n
```

Expected: all PASS. The overflow spec must stay green — the badge row is the most likely thing to break it, and the Swedish case is the most likely of those.

- [ ] **Step 7: Commit**

```bash
git add src/components/members/members-table.tsx \
        src/components/members/members-table-skeleton.tsx \
        tests/unit/members/portal-badge.test.tsx \
        tests/e2e/members-table-overflow.spec.ts
git commit -m "feat(members): show portal status badge on the directory rows"
```

---

# PHASE C — Needs-invite chip

Depends on Phase B (shares the row type and the copy namespace).

### Task 8: Extract the shared directory WHERE builder

**Files:**
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (`buildDirectoryConds` ~:198, `searchDirectory` ~:885, `searchDirectoryWithCount` ~:966)

**Interfaces:**
- Produces: `buildDirectoryWhere(filter: DirectoryFilter | DirectoryOffsetFilter): SQL` — the full directory predicate (erased-tombstone exclusion + status OR-set + `q` + scalar conds).

**Why:** `buildDirectoryConds` covers only the scalar filters; `isNull(members.erasedAt)`, the status OR-set and `directoryQFilter(q)` are hand-assembled separately in both callers. Task 9 adds a **third** caller (the chip count). Omitting `isNull(erasedAt)` there would make the chip count GDPR-erased tombstones. This is a pure refactor — behaviour must not change.

- [ ] **Step 1: Add the extracted builder**

Below `buildDirectoryConds`:

```ts
/**
 * The complete directory WHERE clause, shared by every caller that must agree
 * on "which members are in the directory": the cursor search, the offset
 * search + its COUNT, and the needs-invite chip count. Previously the erased
 * exclusion, status OR-set and q-filter were hand-assembled per caller; a
 * third caller made that a drift risk with a GDPR-shaped failure mode (a
 * count that includes erased tombstones).
 */
function buildDirectoryWhere(
  filter: DirectoryFilter | DirectoryOffsetFilter,
): SQL {
  const statuses = filter.status ?? ['active', 'inactive'];
  return and(
    // COMP-1 H4 — erasure keeps `status` and stamps only `erased_at`, so the
    // status OR-set does NOT hide an erased row.
    isNull(members.erasedAt),
    or(...statuses.map((s) => eq(members.status, s)))!,
    ...(filter.q ? [directoryQFilter(filter.q)] : []),
    ...buildDirectoryConds(filter),
  )!;
}
```

- [ ] **Step 2: Route `searchDirectoryWithCount` through it**

Replace `:962-974` (`const statuses = …` through the `whereClause` assignment) with:

```ts
      const result = await runInTenant(ctx, async (tx) => {
        const whereClause = buildDirectoryWhere(filter);
```

Delete the now-unused local `statuses` and `conds` in that method.

- [ ] **Step 3: Route `searchDirectory` through it**

In `searchDirectory`, the cursor predicates are pushed onto `conds` **after** `buildDirectoryConds`, so keep them separate:

```ts
      const whereClause = and(buildDirectoryWhere(filter), ...cursorConds)!;
```

where `cursorConds` is the array that currently receives only the cursor `sql\`…\`` predicates. Move the cursor pushes off `conds` and onto a fresh `const cursorConds: SQL[] = []`, and delete the `conds` variable.

Remove the now-obsolete "byte-identical WHERE composition" note in the comment at `:186-189`.

- [ ] **Step 4: Prove behaviour is unchanged**

```bash
pnpm test:integration tests/integration/members/directory-search.test.ts
pnpm test:integration tests/integration/members/directory-search-with-count.test.ts
pnpm test:integration tests/integration/members/directory-risk-band-filter.test.ts
pnpm typecheck
```

Expected: all PASS with no test edits. If any fails, the refactor changed behaviour — revert and redo.

- [ ] **Step 5: Commit**

```bash
git add src/modules/members/infrastructure/db/drizzle-member-repo.ts
git commit -m "refactor(members): extract shared buildDirectoryWhere for directory queries"
```

---

### Task 9: needs-invite predicate + count repo method

**Files:**
- Modify: `src/modules/members/application/ports/member-repo.ts` — both filter types + the count method
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts`
- Test: `tests/integration/members/portal-needs-invite-filter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // on BOTH DirectoryFilter and DirectoryOffsetFilter:
  readonly portalNeedsInvite?: { readonly now: Date };

  // on MemberRepo:
  countMembersNeedingPortalInvite(
    ctx: TenantContext,
    filter: DirectoryOffsetFilter,
  ): Promise<Result<number, RepoError>>;
  ```

**Critical:** `DirectoryFilter` and `DirectoryOffsetFilter` are **two independent declarations** — the second does not extend the first, and the page only ever uses the offset path. Adding the field to one of them leaves the chip a silent no-op with **no TypeScript error** (the field is optional and a cast spans the boundary in `directory-search.ts`). Add it to both.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/members/portal-needs-invite-filter.test.ts`. Same imports and copied helpers as Task 4's test (`seedPlan`, `seedMemberWithContact`, `seedInvitation`, `addSecondaryContact`), with `PLAN_ID = 'test-needs-invite-plan'` and a `companyName` option added to `seedMemberWithContact` so the `q`-filter case is controllable.

```ts
const NOW = new Date();
const DAY = 86_400_000;

/** The filter every case starts from — mirrors what the page builds. */
function baseFilter(overrides: Record<string, unknown> = {}) {
  return {
    status: ['active', 'inactive'] as const,
    portalNeedsInvite: { now: NOW },
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

/** Ids returned by the filtered search, for set-wise assertions. */
async function searchIds(tenant: TestTenant, filter: ReturnType<typeof baseFilter>) {
  const deps = buildMembersDeps(tenant.ctx);
  const res = await deps.memberRepo.searchDirectoryWithCount(tenant.ctx, filter as never);
  expect(res.ok).toBe(true);
  if (!res.ok) return [];
  return res.value.items.map((i) => i.member.memberId as string);
}

describe('needs-invite directory filter', () => {
  let tenant: TestTenant;
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    await seedPlan(tenant.ctx.slug, adminUser.userId);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('matches a member whose primary contact was never invited', async () => {
    const { memberId } = await seedMemberWithContact(tenant, { linkedUserId: null });
    expect(await searchIds(tenant, baseFilter())).toContain(memberId as string);
  });

  it('matches a member whose only unconsumed invitation has expired', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).toContain(memberId as string);
  });

  it('does NOT match a member holding a live invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match a member re-invited after an expiry (live + expired rows)', async () => {
    // A bare `EXISTS (expires_at <= now)` gets this wrong: the member holds an
    // expired row AND a live one. The badge says `invited`, so the filter must
    // agree — this is what the second NOT EXISTS clause is for.
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match an active user holding a stale unconsumed row', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitee.userId,
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
    });
    await seedInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 4 * DAY),
      consumedAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match on a SECONDARY contact’s state', async () => {
    const invitee = await createActiveTestUser('member');
    const activeUser = await createActiveTestUser('member');
    // Primary is fully active (consumed invite) → member does not need an invite.
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: activeUser.userId,
    });
    await seedInvitation(activeUser.userId, adminUser.userId, {
      consumedAt: new Date(Date.now() - DAY),
    });
    // Secondary contact was never invited — must NOT drag the member in.
    await addSecondaryContact(tenant, memberId as string, invitee.userId);
    await seedInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match a member with no primary contact', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `NoContactCo ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        registrationDate: new Date().toISOString().slice(0, 10),
        registrationFeePaid: false,
        status: 'active',
        archivedAt: null,
      });
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId);
  });

  it('excludes archived members even when status=archived is requested', async () => {
    const { memberId } = await seedMemberWithContact(tenant, { linkedUserId: null });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, memberId as string));
    });
    const ids = await searchIds(
      tenant,
      baseFilter({ status: ['active', 'inactive', 'archived'] }),
    );
    // The bulk action skips archived members unconditionally, so counting them
    // would promise work that cannot be done.
    expect(ids).not.toContain(memberId as string);
  });

  it('excludes GDPR-erased members', async () => {
    const { memberId } = await seedMemberWithContact(tenant, { linkedUserId: null });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, memberId as string));
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('count equals the filtered row count under a compound filter', async () => {
    // This is the test that catches the third-WHERE drift: the count method
    // assembles its own clause, so an omitted erased/archived/q predicate shows
    // up here as count ≠ rows.
    const marker = `CompoundCo-${randomUUID().slice(0, 8)}`;
    const matching: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { memberId } = await seedMemberWithContact(tenant, {
        linkedUserId: null,
        companyName: `${marker} ${i}`,
      });
      matching.push(memberId as string);
    }
    // Decoys carrying the same marker: one archived, one erased.
    const { memberId: archived } = await seedMemberWithContact(tenant, {
      linkedUserId: null,
      companyName: `${marker} archived`,
    });
    const { memberId: erased } = await seedMemberWithContact(tenant, {
      linkedUserId: null,
      companyName: `${marker} erased`,
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, archived as string));
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, erased as string));
    });
    // A decoy that does NOT match `q` at all.
    await seedMemberWithContact(tenant, { linkedUserId: null });

    const filter = baseFilter({ q: marker });
    const deps = buildMembersDeps(tenant.ctx);
    const [count, page] = await Promise.all([
      deps.memberRepo.countMembersNeedingPortalInvite(tenant.ctx, filter as never),
      deps.memberRepo.searchDirectoryWithCount(tenant.ctx, filter as never),
    ]);
    expect(count.ok).toBe(true);
    expect(page.ok).toBe(true);
    if (!count.ok || !page.ok) return;
    expect(count.value).toBe(2);
    expect(page.value.total).toBe(2);
    expect(page.value.items.map((i) => i.member.memberId as string).sort()).toEqual(
      [...matching].sort(),
    );
  }, 60_000);
});
```

Add `eq` to the drizzle-orm import and `randomUUID` from `node:crypto`.

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test:integration tests/integration/members/portal-needs-invite-filter.test.ts
```

Expected: FAIL — `countMembersNeedingPortalInvite is not a function`.

- [ ] **Step 3: Extend both filter types**

In `member-repo.ts`, add the identical field to `DirectoryFilter` and `DirectoryOffsetFilter`:

```ts
  /**
   * Needs-invite chip (design doc 2026-07-23 §3.7, D5/D6). When present,
   * restricts the result to members whose PRIMARY contact either was never
   * invited or holds only expired unconsumed invitations.
   *
   * Modelled as an object carrying `now` rather than a boolean plus a separate
   * optional timestamp so the compiler enforces D8: the badge and this filter
   * must judge expiry against the same instant.
   *
   * MUST be declared on BOTH filter types — they are independent declarations
   * and the admin page uses only the offset one.
   */
  readonly portalNeedsInvite?: { readonly now: Date };
```

And the repo method, beside `searchDirectoryWithCount`:

```ts
  /**
   * COUNT(*) of members matching `filter` AND needing a portal invite.
   * Backs the directory's needs-invite chip. `limit`/`offset`/`sort` on the
   * filter are ignored. `portalNeedsInvite` is forced on internally, so the
   * count is always scoped to the same filters the visible list uses (D7).
   */
  countMembersNeedingPortalInvite(
    ctx: TenantContext,
    filter: DirectoryOffsetFilter,
  ): Promise<Result<number, RepoError>>;
```

- [ ] **Step 4: Implement the predicate**

In `drizzle-member-repo.ts`, below `buildDirectoryWhere`:

```ts
/**
 * "Primary contact needs a portal invite" — never invited, or holding only
 * expired unconsumed invitations (design doc §3.7).
 *
 * Raw `sql` template with every column table-qualified. Do NOT rebuild this
 * with the query builder unless every table is `alias()`-ed: unqualified
 * columns in a builder subquery resolve against the inner FROM and collapse
 * the WHERE to always-true (see directoryPlanNameSubquery, git 8e71812).
 *
 * Only `user_id` / `consumed_at` / `expires_at` are referenced — the columns
 * `chamber_app` may read (migration 0017). Referencing `id` raises 42501.
 */
function portalNeedsInviteFilter(now: Date): SQL {
  const nowIso = now.toISOString();
  return sql`
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.tenant_id = ${members.tenantId}
         AND c.member_id = ${members.memberId}
         AND c.is_primary = true
         AND c.removed_at IS NULL
         AND (
               c.linked_user_id IS NULL
            OR (
                  EXISTS (SELECT 1 FROM invitations i
                           WHERE i.user_id = c.linked_user_id
                             AND i.consumed_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM invitations i2
                               WHERE i2.user_id = c.linked_user_id
                                 AND i2.consumed_at IS NULL
                                 AND i2.expires_at > ${nowIso}::timestamptz)
              AND NOT EXISTS (SELECT 1 FROM invitations ci
                               WHERE ci.user_id = c.linked_user_id
                                 AND ci.consumed_at IS NOT NULL)
            )
         )
    )
    AND ${members.status} <> 'archived'
  `;
}
```

Then add it to `buildDirectoryWhere`:

```ts
    ...(filter.portalNeedsInvite
      ? [portalNeedsInviteFilter(filter.portalNeedsInvite.now)]
      : []),
```

and implement the count beside `searchDirectoryWithCount`:

```ts
  async countMembersNeedingPortalInvite(ctx, filter) {
    try {
      const n = await runInTenant(ctx, async (tx) => {
        const whereClause = buildDirectoryWhere({
          ...filter,
          portalNeedsInvite: filter.portalNeedsInvite ?? { now: new Date() },
        });
        const rows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(members)
          .where(whereClause);
        return rows[0]?.n ?? 0;
      });
      return ok(n);
    } catch (e) {
      return err(unexpected(e));
    }
  },
```

Note the three `NOT EXISTS` clauses are each load-bearing: the second is what makes the SQL agree with the batch read's freshest-wins ordering (a member re-invited after an expiry must NOT appear), the third is the never-redeemed anti-join.

- [ ] **Step 5: Run the integration test until green**

```bash
pnpm test:integration tests/integration/members/portal-needs-invite-filter.test.ts
pnpm test:integration tests/integration/members/directory-search-with-count.test.ts
pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/application/ports/member-repo.ts \
        src/modules/members/infrastructure/db/drizzle-member-repo.ts \
        tests/integration/members/portal-needs-invite-filter.test.ts
git commit -m "feat(members): needs-invite directory predicate and count"
```

---

### Task 10: Count use case + page wiring

**Files:**
- Create: `src/modules/members/application/use-cases/count-members-needing-portal-invite.ts`
- Modify: `src/modules/members/index.ts`
- Modify: `src/app/(staff)/admin/members/page.tsx`

**Interfaces:**
- Produces:
  ```ts
  countMembersNeedingPortalInvite(
    deps: { readonly tenant: TenantContext; readonly memberRepo: MemberRepo },
    filter: DirectoryOffsetFilter,
  ): Promise<Result<number, never>>   // null-on-failure is the page's concern
  ```

- [ ] **Step 1: Write the use case**

```ts
/**
 * Chip count for the members directory (design doc §3.7). A thin pass-through
 * that exists so the presentation layer never touches a repo directly
 * (Principle III) and so the "same filter as the list" contract (D7) lives in
 * one place: callers hand in the SAME DirectoryOffsetFilter they gave the
 * search, and this forces `portalNeedsInvite` on.
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { DirectoryOffsetFilter, MemberRepo } from '../ports/member-repo';

export async function countMembersNeedingPortalInvite(
  deps: { readonly tenant: TenantContext; readonly memberRepo: MemberRepo },
  filter: DirectoryOffsetFilter & { readonly portalNeedsInvite: { readonly now: Date } },
): Promise<Result<number, never>> {
  const res = await deps.memberRepo.countMembersNeedingPortalInvite(
    deps.tenant,
    filter,
  );
  return ok(res.ok ? res.value : 0);
}
```

Export it from `src/modules/members/index.ts`.

- [ ] **Step 2: Wire it into the FIRST `Promise.all`**

In `page.tsx`, the count must join the **first** round (`:256`), not the second. Two early returns sit between them (`:293` search failed, `:302` zero rows) and the zero-rows branch is exactly where the chip must still render.

Hoist `const now = new Date();` above the first `Promise.all`, build the filter object once, and reuse it:

```ts
  const directoryFilter = {
    ...(query.q?.trim() ? { q: query.q.trim() } : {}),
    ...(query.plan_id && query.plan_id !== 'all' ? { planId: query.plan_id } : {}),
    ...(riskBand ? { riskBand } : {}),
    ...(sort ? { sort, ...(order ? { order } : {}) } : {}),
    status: [...statuses],
    limit: PAGE_SIZE,
    offset,
  };

  const [result, plansResult, portalInviteCount] = await Promise.all([
    directorySearchWithCount(
      { tenant, memberRepo: deps.memberRepo },
      { ...directoryFilter, ...(portalNeedsInvite ? { portalNeedsInvite: { now } } : {}) },
    ),
    listPlans(/* unchanged */),
    countMembersNeedingPortalInviteSafe(tenant, deps.memberRepo, {
      ...directoryFilter,
      portalNeedsInvite: { now },
    }),
  ]);
```

with the degrade wrapper beside the other two:

```ts
/**
 * Best-effort chip count. Returns `null` — NOT 0 — on failure: an absent chip
 * means "everyone has been invited" (D5), so rendering 0 after a failed read
 * would tell the operator the work is done while 12 members are still waiting.
 * The chip renders a disabled "unavailable" state for null.
 */
async function countMembersNeedingPortalInviteSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberRepo: ReturnType<typeof buildMembersDeps>['memberRepo'],
  filter: Parameters<typeof countMembersNeedingPortalInvite>[1],
): Promise<number | null> {
  try {
    const res = await countMembersNeedingPortalInvite(
      { tenant, memberRepo },
      filter,
    );
    return res.ok ? res.value : null;
  } catch (e) {
    logger.warn(
      { tenantId: tenant.slug, errKind: errKind(e) },
      '[members-portal] chip count threw — chip shows unavailable',
    );
    return null;
  }
}
```

- [ ] **Step 3: Parse `?portal=` and fix `hasFilters`**

Add to `SearchParams`:

```ts
  /** Needs-invite chip (design doc §3.6). Only 'needs_invite' is honoured. */
  readonly portal?: string;
```

Add the allow-list beside `parseDirectorySort`:

```ts
/**
 * Allow-list for the needs-invite chip param. An unrecognised value is
 * ignored AND must not count as an active filter — otherwise `?portal=xyz`
 * would render the "no members match these filters" state on a full directory.
 */
export function parsePortalFilter(raw: string | undefined): boolean {
  return raw === 'needs_invite';
}
```

Then:

```ts
  const portalNeedsInvite = parsePortalFilter(query.portal);

  const hasFilters =
    (query.q !== undefined && query.q.trim().length > 0) ||
    (query.status !== undefined && query.status !== 'all') ||
    (query.plan_id !== undefined && query.plan_id !== 'all') ||
    query.show_archived === '1' ||
    riskBand !== undefined ||
    // Without this, filtering to zero rows renders MembersZeroState — the
    // "no members yet, add your first member" onboarding screen — to a tenant
    // with 131 members.
    portalNeedsInvite;
```

- [ ] **Step 4: Pass the count in all three return branches + add the empty state**

Every `<DirectoryFilters plans={planOptions} />` becomes:

```tsx
<DirectoryFilters plans={planOptions} portalInviteCount={portalInviteCount} />
```

and the zero-rows branch gains a preceding case:

```tsx
  if (result.value.items.length === 0) {
    return (
      <>
        <DirectoryFilters plans={planOptions} portalInviteCount={portalInviteCount} />
        {portalNeedsInvite ? (
          <MembersAllInvitedEmptyState />
        ) : hasFilters ? (
          <MembersFilteredEmptyState />
        ) : (
          <MembersZeroState />
        )}
      </>
    );
  }
```

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck && pnpm lint
```

Expected: fails only on the not-yet-existing `portalInviteCount` prop and `MembersAllInvitedEmptyState` — Task 11 adds both. Complete Task 11 before committing, or stub them first.

- [ ] **Step 6: Commit (after Task 11 compiles)**

```bash
git add src/modules/members/application/use-cases/count-members-needing-portal-invite.ts \
        src/modules/members/index.ts src/app/\(staff\)/admin/members/page.tsx
git commit -m "feat(members): wire needs-invite count into the directory page"
```

---

### Task 11: The chip + empty state + live region

**Files:**
- Modify: `src/components/members/directory-filters.tsx`
- Modify: `src/components/members/empty-states.tsx`
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Test: `tests/unit/members/needs-invite-chip.test.tsx`

- [ ] **Step 1: Add i18n keys**

Under `admin.members.directory` (EN shown; mirror into th/sv):

```json
      "portalChip": {
        "label": "Needs portal invite",
        "aria": "Needs portal invite, {count} members",
        "unavailable": "Portal status unavailable"
      },
```

Under `admin.members.emptyStates`:

```json
      "allInvited": {
        "title": "Everyone has been invited",
        "description": "Every member matching these filters already has a portal invitation.",
        "cta": "Show all members"
      },
```

- [ ] **Step 2: Write the failing component test**

`tests/unit/members/needs-invite-chip.test.tsx`:

```tsx
it('exposes a toggle with the count in its accessible name', () => {
  renderFilters({ portalInviteCount: 12 });
  const chip = screen.getByRole('button', { name: /needs portal invite, 12 members/i });
  expect(chip).toHaveAttribute('aria-pressed', 'false');
});

it('is not rendered when the count is zero and the filter is off', () => {
  renderFilters({ portalInviteCount: 0 });
  expect(screen.queryByRole('button', { name: /needs portal invite/i })).toBeNull();
});

it('stays rendered at zero while the filter is active', () => {
  renderFilters({ portalInviteCount: 0, searchParams: 'portal=needs_invite' });
  const chip = screen.getByRole('button', { name: /needs portal invite/i });
  expect(chip).toHaveAttribute('aria-pressed', 'true');
});

it('renders an unavailable state for a null count instead of zero', () => {
  renderFilters({ portalInviteCount: null });
  expect(screen.getByRole('button', { name: /portal status unavailable/i })).toBeDisabled();
});

it('shows the Clear button when the chip is the only active filter', () => {
  renderFilters({ portalInviteCount: 3, searchParams: 'portal=needs_invite' });
  expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
});
```

- [ ] **Step 3: Implement the chip**

In `directory-filters.tsx`:

```tsx
type Props = {
  readonly plans?: readonly PlanOption[];
  /**
   * Members matching the current filters that still need a portal invite.
   * `null` = the count could not be read; the chip renders disabled rather
   * than claiming zero (an absent chip means "no work left").
   */
  readonly portalInviteCount?: number | null;
};
```

Inside the component:

```tsx
  const portalActive = searchParams.get('portal') === 'needs_invite';
  // The chip must survive its own click: turning the filter off at count 0
  // would otherwise unmount the button that was just pressed, dropping focus
  // to <body> — a failure axe never catches.
  const [chipWasVisible, setChipWasVisible] = useState(
    portalActive || (portalInviteCount ?? 0) > 0,
  );
  const showChip =
    portalActive ||
    portalInviteCount === null ||
    (portalInviteCount ?? 0) > 0 ||
    chipWasVisible;
  if (!showChip && chipWasVisible) setChipWasVisible(false);
```

and the control, placed after the risk `Select`:

```tsx
      {showChip && (
        <Button
          type="button"
          variant={portalActive ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={portalActive}
          disabled={portalInviteCount === null}
          // Always toggle through pushUrl — it strips `cursor`/`page` and uses
          // scroll:false. Setting ?portal= directly from page 3 would land on
          // page 3 of a one-page result: an empty table with no explanation.
          onClick={() => pushUrl({ portal: portalActive ? null : 'needs_invite' })}
          aria-label={
            portalInviteCount === null
              ? t('portalChip.unavailable')
              : t('portalChip.aria', { count: portalInviteCount ?? 0 })
          }
          className="whitespace-nowrap"
        >
          <MailWarningIcon className="size-4" aria-hidden />
          <span aria-hidden="true">
            {t('portalChip.label')}
            {portalInviteCount !== null ? ` · ${portalInviteCount}` : ''}
          </span>
        </Button>
      )}
```

Update both filter-state helpers:

```tsx
  const hasAnyFilter =
    Boolean(currentQ) ||
    currentStatus !== 'all' ||
    currentPlan !== 'all' ||
    currentRisk !== 'all' ||
    // Without this the Clear button never renders when the chip is the only
    // active filter — and clearAll() below becomes unreachable.
    portalActive;

  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchValue('');
    pushUrl({ q: null, status: null, plan_id: null, risk_band: null, portal: null });
  };
```

- [ ] **Step 4: Add the empty state + live region**

In `empty-states.tsx`, add (anatomy copied from its three siblings):

```tsx
export function MembersAllInvitedEmptyState() {
  const t = useTranslations('admin.members.emptyStates.allInvited');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-10 text-center"
      role="status"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-muted" aria-hidden>
        <MailCheckIcon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-h3 text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          // Clear ONLY the chip — router.replace(pathname) (what the filtered
          // empty state does) would also throw away the user's Plan filter.
          const params = new URLSearchParams(searchParams.toString());
          params.delete('portal');
          params.delete('page');
          params.delete('cursor');
          const qs = params.toString();
          router.replace(qs ? `${pathname}?${qs}` : pathname);
        }}
      >
        <XIcon className="size-4" />
        {t('cta')}
      </Button>
    </div>
  );
}
```

Add `MailCheckIcon` to the lucide import and `useSearchParams` to the next/navigation import.

In `members-table.tsx`, add a result-count live region beside the existing selection one so screen-reader users hear the table change when any filter (including the chip) is applied:

```tsx
      <div className="sr-only" role="status">
        {t('resultsCount', { count: rows.length })}
      </div>
```

(`resultsCount` already exists in the directory namespace — check its placeholder shape before use.)

- [ ] **Step 5: Run everything for this phase**

```bash
pnpm test tests/unit/members/needs-invite-chip.test.tsx
pnpm test:e2e tests/e2e/members-a11y.spec.ts --workers=1
pnpm typecheck && pnpm lint && pnpm check:i18n
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/members/directory-filters.tsx src/components/members/empty-states.tsx \
        src/components/members/members-table.tsx src/i18n/messages tests/unit/members/needs-invite-chip.test.tsx \
        src/app/\(staff\)/admin/members/page.tsx
git commit -m "feat(members): needs-invite chip with filter-scoped count"
```

---

### Task 12: E2E round-trip for the chip

**Files:**
- Create: `tests/e2e/members-portal-chip.spec.ts`

**Why E2E and not jsdom:** the bug this guards (Clear not stripping `portal`, the chip vanishing at zero) is URL and server-page behaviour. A component test never exercises `?portal=` round-tripping.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { signInAsAdmin } from './helpers/admin-session';

test.describe('members directory — needs-invite chip', () => {
  test('filters, survives a zero count, and Clear strips the param', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');

    const chip = page.getByRole('button', { name: /needs portal invite/i });
    test.skip(!(await chip.isVisible()), 'no members need an invite in this environment');

    await chip.click();
    await expect(page).toHaveURL(/portal=needs_invite/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // The chip must still be present while the filter is on, even at zero.
    await expect(chip).toBeVisible();

    await page.getByRole('button', { name: /clear/i }).click();
    await expect(page).not.toHaveURL(/portal=/);
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e tests/e2e/members-portal-chip.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/members-portal-chip.spec.ts
git commit -m "test(members): e2e round-trip for the needs-invite chip"
```

---

# PHASE D — Bulk re-send

Depends on Phase C only conceptually (the chip is what surfaces these members). Can be implemented independently.

### Task 13: Bulk invite falls through to re-send

**Files:**
- Modify: `src/modules/members/application/use-cases/bulk-send-portal-invite.ts`
- Test: `tests/integration/members/bulk-send-portal-invite-resend.test.ts`

**Interfaces:**
- Consumes: `resendBouncedInvite(deps, input)` — already exported; error shape
  `{ code: 'not_eligible', reason: 'no_linked_user' | 'already_active' } | { code: 'not_found' } | { code: 'server_error' }`.
- Produces: `BulkSendPortalInviteOutput.resent: ReadonlyArray<{ memberId: string; contactId: string }>` and `counts.resent: number`.

**Why:** the chip counts `invite_expired` members, but `invitePortal` returns `already_linked` for them (their `linked_user_id` is set), so today all of them land in `skipped` with no route forward. `resendBouncedInvite` handles exactly this case — its Cluster 3 change dropped the bounce-flag requirement so an expired-unaccepted invite is re-sendable.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/members/bulk-send-portal-invite-resend.test.ts`, modelled on `tests/integration/members/bulk-send-portal-invite.test.ts` (read it first for the exact `deps`/`meta` shape it builds — reuse that verbatim, adding the four new deps). Seeding helpers are the same copies as Task 4.

**Important:** a re-sendable user must be `status = 'pending'`, not active — `createActiveTestUser` produces an ACTIVE user, which `resendBouncedInvite` rejects with `not_eligible/already_active`. Use whatever pending-user helper `bulk-send-portal-invite.test.ts` already uses (grep it for `'pending'`); if none exists, insert the user row directly with `status: 'pending'` via the owner-role `db` client, mirroring `seedInvitation`.

```ts
const DAY = 86_400_000;

function meta() {
  return {
    actorUserId: adminUser.userId,
    requestId: `req-${randomUUID().slice(0, 8)}`,
    sourceIp: '127.0.0.1',
  };
}

function deps(tenant: TestTenant) {
  const d = buildMembersDeps(tenant.ctx);
  return {
    tenant: d.tenant,
    memberRepo: d.memberRepo,
    contactRepo: d.contactRepo,
    createUser: d.createUser,
    deleteInvitedUser: d.deleteInvitedUser,
    // New in Phase D — all already provided by buildMembersDeps.
    reissueInvitation: d.reissueInvitation,
    userEmails: d.userEmails,
    audit: d.audit,
    clock: d.clock,
  };
}

describe('bulkSendPortalInvite — expired-invitation re-send', () => {
  it('re-sends instead of skipping when the invitation expired', async () => {
    const pendingUser = await seedPendingUser();
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: pendingUser.userId,
    });
    await seedInvitation(pendingUser.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.resent).toBe(1);
    expect(res.value.counts.skipped).toBe(0);
    expect(res.value.counts.invited).toBe(0);
    expect(res.value.resent[0]?.memberId).toBe(memberId as string);
  });

  it('still skips a member whose portal user is already active', async () => {
    const activeUser = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: activeUser.userId,
    });
    await seedInvitation(activeUser.userId, adminUser.userId, {
      consumedAt: new Date(Date.now() - DAY),
    });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.resent).toBe(0);
    expect(res.value.skipped[0]?.reason).toBe('already_linked');
  });

  it('still invites a never-invited member through the normal path', async () => {
    // Regression: the fall-through must not disturb the happy path.
    const { memberId } = await seedMemberWithContact(tenant, { linkedUserId: null });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.invited).toBe(1);
    expect(res.value.counts.resent).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test:integration tests/integration/members/bulk-send-portal-invite-resend.test.ts
```

Expected: FAIL — `counts.resent` undefined.

- [ ] **Step 3: Extend the output type and deps**

```ts
export type BulkSendPortalInviteOutput = {
  readonly invited: ReadonlyArray<{ … }>;   // unchanged
  /**
   * Members whose primary contact already had a pending user with a dead
   * (expired) invitation: a FRESH token was minted via resendBouncedInvite.
   * Separate from `invited` because no user was created — the API response
   * gains a field and removes none, so existing consumers keep working.
   */
  readonly resent: ReadonlyArray<{ readonly memberId: string; readonly contactId: string }>;
  readonly skipped: …;
  readonly failed: …;
  readonly counts: {
    readonly invited: number;
    readonly resent: number;
    readonly skipped: number;
    readonly failed: number;
  };
};
```

Deps gain what `resendBouncedInvite` needs (all already provided by `buildMembersDeps`):

```ts
  readonly reissueInvitation: ReissueInvitationPort;
  readonly userEmails: UserEmailPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
```

- [ ] **Step 4: Replace the `already_linked` arm**

```ts
        case 'already_linked': {
          // The contact is linked, but that covers two very different states:
          // an ACTIVE portal user (nothing to do) and a PENDING user whose
          // invitation expired unaccepted (needs a fresh token). The chip
          // counts the latter, so skipping them all would promise work the
          // bulk action refuses to do.
          //
          // resendBouncedInvite distinguishes them for us: it returns
          // not_eligible/already_active when the user has activated.
          const resend = await resendBouncedInvite(
            {
              tenant: deps.tenant,
              contactRepo: deps.contactRepo,
              userEmails: deps.userEmails,
              reissueInvitation: deps.reissueInvitation,
              audit: deps.audit,
              clock: deps.clock,
            },
            {
              contactId: primary.contactId,
              memberId: rawId,
              actorUserId: meta.actorUserId,
              requestId: meta.requestId,
              ...(meta.locale !== undefined ? { locale: meta.locale } : {}),
            },
          );
          if (resend.ok) {
            resent.push({ memberId: rawId, contactId: primary.contactId as string });
            break;
          }
          if (resend.error.code === 'server_error') {
            logger.error(
              { requestId: meta.requestId, memberId: rawId },
              'bulk-invite: re-send failed',
            );
            failed.push({ memberId: rawId, code: 'server_error' });
            break;
          }
          // not_found / not_eligible (already_active | no_linked_user) →
          // the pre-existing behaviour.
          skipped.push({ memberId: rawId, reason: 'already_linked' });
          break;
        }
```

Declare `const resent: Array<{ memberId: string; contactId: string }> = [];` beside the other buckets and include it in the returned `counts`.

- [ ] **Step 5: Run tests**

```bash
pnpm test:integration tests/integration/members/bulk-send-portal-invite-resend.test.ts
pnpm test:integration tests/integration/members/bulk-send-portal-invite.test.ts
pnpm typecheck
```

Expected: both PASS — the pre-existing suite must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/application/use-cases/bulk-send-portal-invite.ts \
        tests/integration/members/bulk-send-portal-invite-resend.test.ts
git commit -m "feat(members): bulk invite re-sends to members whose invitation expired"
```

---

### Task 14: Route + result copy

**Files:**
- Modify: `src/app/api/members/bulk/route.ts:186-235`
- Modify: the bulk result toast component + `src/i18n/messages/{en,th,sv}.json`

- [ ] **Step 1: Pass the new deps and echo the new bucket**

```ts
      {
        tenant: deps.tenant,
        memberRepo: deps.memberRepo,
        contactRepo: deps.contactRepo,
        createUser: deps.createUser,
        deleteInvitedUser: deps.deleteInvitedUser,
        reissueInvitation: deps.reissueInvitation,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: deps.clock,
      },
```

and in the response body:

```ts
        resent: inviteResult.value.resent.map((r) => ({
          member_id: r.memberId,
          contact_id: r.contactId,
        })),
```

- [ ] **Step 2: Update the result toast**

`src/app/(staff)/admin/members/_components/bulk-action-bar.tsx:87-102` builds the
breakdown. Add the new bucket **and** include it in the success condition —
otherwise a run that only re-sent invitations shows a neutral "nothing happened"
toast despite having queued real emails:

```tsx
            const c = body.counts ?? { invited: 0, resent: 0, skipped: 0, failed: 0 };
            const parts = [t('inviteQueued', { invited: c.invited })];
            // Re-sent = a fresh token minted for a member whose previous
            // invitation expired. Named separately so the admin can tell it
            // apart from a first-time invite.
            if (c.resent > 0) parts.push(t('inviteResent', { resent: c.resent }));
            if (c.skipped > 0) parts.push(t('inviteSkipped', { skipped: c.skipped }));
            if (c.failed > 0) parts.push(t('inviteFailed', { failed: c.failed }));
            const message = parts.join(' · ');
            if (c.failed > 0) toast.error(message);
            else if (c.invited > 0 || c.resent > 0) toast.success(message);
            else toast.info(message);
```

Add the key beside `inviteSkipped` in all three message files:

```json
      "inviteResent": "{resent, plural, one {# re-sent} other {# re-sent}}",
```

TH: `"{resent, plural, other {ส่งซ้ำ #}}"` · SV: `"{resent, plural, one {# omskickad} other {# omskickade}}"`.

- [ ] **Step 3: Verify end to end**

```bash
pnpm typecheck && pnpm lint && pnpm check:i18n
pnpm test:e2e tests/e2e/members-a11y.spec.ts --workers=1
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/members/bulk/route.ts src/components/members src/i18n/messages
git commit -m "feat(members): surface re-sent count in the bulk invite result"
```

---

## Final gate before opening the PR

```bash
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm check:fixme
pnpm test
pnpm test:integration tests/integration/members/portal-status-batch-read.test.ts
pnpm test:integration tests/integration/members/portal-needs-invite-filter.test.ts
pnpm test:integration tests/integration/members/bulk-send-portal-invite-resend.test.ts
pnpm test:integration tests/integration/members/directory-search-with-count.test.ts
pnpm test:e2e tests/e2e/members-table-overflow.spec.ts --workers=1
pnpm test:e2e tests/e2e/members-portal-chip.spec.ts --workers=1
pnpm test:e2e tests/e2e/members-a11y.spec.ts --workers=1
```

Then capture an `EXPLAIN` for the chip count against the dev branch and note the p95 in the PR description: the count runs on **every** directory load (it decides whether the chip renders), so it is a permanent hot-path addition, not pay-per-click.

PR review requirements: this touches invitations and PII surfaces, so it needs **≥2 reviewers**, and any UI change also gets an `enterprise-ux-designer` pass.
