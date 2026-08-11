# Quickstart — 016 RBAC Permissions (developer workflow)

## Prerequisites

Standard repo setup (`pnpm install`, `.env.local` → dev Neon branch, dev server on :3100
— the user runs it themselves). No new services, no new npm dependencies.

## Feature flag

```bash
# .env.local (dev only — prod flag is a Vercel env var, operator-managed)
FEATURE_RBAC_V2=true    # ON leg (new matrix). Omit/false = legacy leg (byte-identical shim)
```

- Read ONLY by `src/lib/rbac.ts`. Never read the env in components or Domain code —
  the evaluator takes the flag as a parameter.
- `tests/setup.ts` must NOT force-set it: the characterization CI job runs the suite
  twice, parameterised over the env.

## Working on the Domain layer (PR 1)

```bash
pnpm test tests/unit/auth/permissions/        # catalogue/bundle/evaluator — Domain 100%
pnpm vitest run tests/contract/rbac/          # bundle-parity + D16 + characterization rows
```

TDD order: bundle-parity + superadmin-only + D16 tests RED → implement catalogue/bundles/
evaluator → GREEN. The § 4.1 matrix in the design doc is the expected-value table.

## Migrations (dev Neon branch)

```bash
pnpm db:migrate            # applies to the DEV branch (never prod from here)
pnpm db:verify             # assert DDL landed (silent-no-op class: check enum values)
```

- Hand-written SQL + `_journal.json`; `when` > global max (+100000 ms on collision).
- Enum DDL: `ADD VALUE IF NOT EXISTS` ONLY (runner re-executes enum DDL every deploy).
- Migration C ships to `main` **staged, not applied**: the SQL sits at
  `drizzle/migrations/pending/0287_rbac_v2_promotion.sql` with NO journal entry, so the
  non-recursive migrations-root read makes it invisible to the migrator, the enum pre-pass
  and the D7 gate. Applying it is a two-part operator action at cutover (`git mv` into the
  root + **add** a journal entry with `when` > applied max) — runbook § 5 step 1. Dev-branch
  C is applied in coordination with PR-3 E2E persona changes (runbook).

## Integration rehearsals (live Neon dev — money-path law: real DB, no mocks)

```bash
pnpm test:integration tests/integration/auth/last-admin-guard.test.ts    # file PATH, never -- pattern
```

Rehearsals are transaction-wrapped with ROLLBACK; they reduce the guarded population
in-tx (never stub the count helpers) and read Migration B/C SQL from
`drizzle/migrations/`. Cover: refuse demote/disable/delete/ERASE of last guarded row;
plain UPDATE/DELETE pass (0004 return-row); `isLastAdminTriggerError` fires; promotion
correctness (3 system actors + D18 row untouched; invitation coherence); reversed-order
C-before-B aborts.

## E2E personas

```bash
# .env.local — staff sign in at /admin/sign-in, members at /portal/sign-in.
# Seeded by scripts/seed-e2e-user.ts (re-run it AFTER Migration C on dev — it
# mints E2E_SUPER_ADMIN_* and RESETS E2E_ADMIN_* back to a plain admin).
E2E_SUPER_ADMIN_*  # PR 3: used ONLY by rbac-super-admin-persona (users/audit/erasure/settings)
E2E_ADMIN_*        # PR 3: re-provisioned as a FRESH plain admin (Migration C promoted the old one)
E2E_MARKETING_*    # PR 4
E2E_RBAC_V2_ON=true  # opt IN the ON-leg persona suites (rbac-admin/super-admin-persona).
                     # Set ONLY when the dev server runs FEATURE_RBAC_V2=true AND
                     # Migration C is applied on dev; the suites skip otherwise so
                     # they can never assert the OFF-leg matrix by accident.
pnpm test:e2e --workers=1                     # ALWAYS --workers=1
pnpm test:e2e --grep "@a11y" -- --workers=1
pnpm test:e2e --grep "rbac-.*-persona" -- --workers=1   # the PR-3 US1 persona suites
```

## Gates for this feature (run before every push; typecheck LAST after final edit)

```bash
pnpm check:staff-page-guard      # NEW — every (staff) page declares a literal permission
pnpm vitest run tests/contract/rbac/   # matrix + exhaustiveness + characterization
pnpm check:audit-events && pnpm check:audit-counts   # permission_denied registered (~6 places)
pnpm check:i18n                  # 5 role names × EN/TH/SV
pnpm lint && pnpm typecheck      # full lint; typecheck is in NO other gate
```

## Operator cutover (prod — runbook `docs/runbooks/rbac-v2-cutover.md`)

1. PR 2 deployed, flag OFF (byte-identical).
2. **Pre-mint** first super_admin: `BOOTSTRAP_ADMIN_EMAIL=... pnpm db:seed-admin`
   (refuses iff a super_admin already exists — D18).
3. Flip `FEATURE_RBAC_V2=true` in Vercel env + redeploy; run the verification checklist
   (expected-denial baseline = PASS evidence; any unexpected pair = abort → flag OFF).
4. Ship Migration C on a migration-only branch: `git mv` it out of `pending/` into the
   migrations root + add its journal entry (`when` > applied max), then merge → the deploy
   promotes human admins + open invitations. (Doing that with the flag unset fails the
   build: the run-migrations D7 assertion, which checks the journal as well as the
   file listing.)
5. After C: rollback = flag OFF (degraded-safe, marketing DENIED) + demotion;
   `vercel promote` floor = the PR-2 deployment.
6. PR 4: verify prod env var is unset or `'true'` (leftover `'false'` defeats the
   default flip). PR 5: delete the env var.
