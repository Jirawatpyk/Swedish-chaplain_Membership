# Runbook — RBAC v2 Cutover (016-rbac-permissions)

**Status:** authored in PR 2 (T040); executed at T052 (operator-gated). Owner: solo maintainer.

Chamber-OS moves from 3 roles (`admin` / `manager` / `member`) to 5 (`super_admin` / `admin` / `manager` / `marketing` / `member`) behind the `FEATURE_RBAC_V2` env flag. The cutover is a **strictly ordered** sequence: pre-mint the first super_admin → flip the flag → verify → merge/deploy Migration C (promotion) → verify again. Running any step out of order is either a lockout risk (SC-003/SC-006) or blocked by the D7 gate in `scripts/run-migrations.ts`.

The two legs, in one line each:

- **Flag OFF (today):** every surface evaluates its frozen *legacy shim row* — byte-identical to pre-016 behaviour (SC-002). `super_admin` degrades to `admin` semantics (D16); `marketing` is denied everywhere.
- **Flag ON:** every surface evaluates its declared `PermissionKey` against `ROLE_BUNDLES`. The D4 narrowings apply (users/audit/settings.invoicing/erasure become super-admin surfaces).

## 1. Preconditions (before the cutover window)

- [ ] PR 2 merged and deployed to production (flag absent/`false` — behaviour unchanged).
- [ ] PR 3 merged (users-page retrofit) — the cutover has no UI to manage roles without it.
- [ ] Migration B (0286 — `permission_denied` enum + transitional UNION trigger) is applied in prod. Verify:

  ```sql
  -- The FUNCTION has existed since migration 0003 — checking its NAME proves
  -- nothing. Check the 0286 body: the population must be the admin ∪
  -- super_admin union.
  select 1 from pg_proc
   where proname = 'users_last_admin_guard' and prosrc like '%super_admin%';
  select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'audit_event_type' and e.enumlabel = 'permission_denied';
  ```

  Both must return exactly one row.

- [ ] Migration C is **staged, not shipped**: the SQL lives at `drizzle/migrations/pending/0287_rbac_v2_promotion.sql` on `main` and has **NO entry in `meta/_journal.json`**. Verify both:

  ```bash
  ls drizzle/migrations/pending/0287_rbac_v2_promotion.sql        # exists
  ls drizzle/migrations/*rbac_v2_promotion*.sql 2>/dev/null       # must be EMPTY
  grep -c rbac_v2_promotion drizzle/migrations/meta/_journal.json # must be 0
  ```

  `run-migrations.ts` reads the migrations root NON-recursively, so a file in `pending/` is invisible to the migrator, to the enum pre-pass, and to the D7 gate — that is what lets every ordinary deploy of this feature run while the promotion waits. Applying it is § 5, and it is a deliberate two-part operator action (`git mv` + **add** a journal entry), never an automatic consequence of merging anything.
- [ ] The D7 gate is armed for BOTH shapes. It derives the promotion set from the journal as well as the file listing, so a journal entry that points at the `pending/` path (`tag: "pending/0287_rbac_v2_promotion"` — drizzle resolves `${folder}/${tag}.sql` with no path sanitisation) is refused too, and it also refuses a `when` that is ≤ the applied max. Covered by `tests/unit/scripts/rbac-promotion-gate.test.ts`.
- [ ] `docs/observability.md` denial-baseline alert reviewed; you know where `rbac_permission_denied_total{role, permission}` is graphed.
- [ ] A second person (or a second session) is available for the verification walk — the window should not exceed ~1 h.

## 2. Step 1 — pre-mint the first super_admin (D18)

On production (Vercel env vars already validated):

```bash
BOOTSTRAP_ADMIN_EMAIL=<principal email> pnpm db:seed-admin
```

- The seed mints a **`super_admin`** row (T038) and **refuses IFF a super_admin already exists** — plain admins do not block it, so this is safe to run while the current admins keep working.
- If the principal already has an admin account and should BE the super_admin, skip the seed: Migration C will promote them. Pre-mint a fresh account only when you want a dedicated break-glass identity.
- Record the minted user id in the cutover log (section 9).

**Why pre-mint before the flip:** the moment the flag is ON, `users.manage` is super-admin-only. If zero super_admins exist, nobody can invite or promote — permanent lockout. The pre-mint (or the D18-promoted principal) is the guarantee.

## 3. Step 2 — flip the flag

1. Vercel → Project → Settings → Environment Variables → set `FEATURE_RBAC_V2=true` (Production).
2. Redeploy (env change requires a deploy; use "Redeploy" on the current build).
3. Note the deployment URL + timestamp in the cutover log. This deployment is the **rollback target boundary** — see section 6.

## 4. Step 3 — verification walk (abort gate)

Run immediately after the flip, signed in as each persona:

| # | Persona | Check | Expect |
|---|---------|-------|--------|
| 1 | super_admin | `/admin/users` loads; invite dialog opens | allow |
| 2 | super_admin | `/admin/audit` unredacted; command palette non-empty | allow |
| 3 | plain admin | `/admin/users`, `/admin/audit`, `/admin/settings/invoicing`, `/admin/compliance/erasure-log` | **404 each** (expected D4 denials) |
| 4 | plain admin | invoice issue, member edit, refund record | allow (money ops untouched) |
| 5 | manager | `/admin/invoices` read, `/admin/renewals` read | allow |
| 6 | manager | any mutation (e.g. mark-paid) | 403 as before |
| 7 | any member | portal sign-in + portal pages | unchanged |

Then check the denial trail:

```sql
select summary, count(*) from audit_log
 where event_type = 'permission_denied'
   and timestamp > now() - interval '30 minutes'
 group by summary order by count(*) desc;
```

**Expected-denial baseline** = exactly the pairs implied by `INTENTIONAL_NARROWINGS` in `tests/helpers/rbac-observed-baseline.ts`. **Open that file and read all 22 entries — do not work from a summary.** The ones most likely to be mistaken for an incident because they are irreversible-PII surfaces: `/admin/events/erasure`, `/admin/events/[eventId]/registrations/[registrationId]/erase` (both `events.erasure`, super-admin-only), and the `members.bulk`-gated data-export download (which manager never held — the change at cutover is that manager's `settings.renewal_schedules` writes and the super-admin-only erasure surfaces move out of reach). Also expect manager denials on `settings.renewal_schedules`.

> **NOT an expected-denial row:** `GET /api/members/[id]?include=date_of_birth` for manager. DoB is gated by a `canPerform` FIELD sub-gate that writes **no** `permission_denied` audit row (it silently omits the field), and manager is denied it on **both** legs and pre-016 alike — nothing changes for manager at the flip. Do not hunt this query's summary in the § 4 output; it can never appear, and a real manager PII regression there would NOT be pre-declared.

**ABORT CRITERION:** any (role, permission, route) denial pair **not** in that baseline — especially any `admin` or `manager` denial on a money surface (`invoicing.*`, `refunds.*`, `renewals.*` reads) — means the matrix is wrong in production. Do not diagnose live: **roll back** (section 6, window A) and reproduce on dev.

## 5. Step 4 — Migration C (promotion)

Only after section 4 passes:

1. **Ship the staged SQL on a migration-only branch.** Migration C is not a PR waiting to be merged — it is a staged file that must be MOVED into the migrations root and REGISTERED. On a fresh branch off the merge-day `main`:

   ```bash
   git switch -c 016-migration-c-promotion
   git mv drizzle/migrations/pending/0287_rbac_v2_promotion.sql \
          drizzle/migrations/0287_rbac_v2_promotion.sql
   ```

   Then renumber + journal it against the MERGE-DAY state, not the authoring state:

   - **Numeric prefix**: if another feature landed `0287_*` meanwhile, rename to `<globalMax+1>_rbac_v2_promotion.sql`. The `rbac_v2_promotion` tag is what the gate greps — keep it verbatim.
   - **Journal entry**: append to `drizzle/migrations/meta/_journal.json`, with `when` **strictly greater** than every `when` already there:

     ```json
     { "idx": <lastIdx + 1>, "version": "7", "when": <globalMax + 100000>, "tag": "0287_rbac_v2_promotion", "breakpoints": true }
     ```

     Drizzle compares strictly, so a `when` that is not GREATER than every other journal entry is SKIPPED while the runner still prints "✓ Migrations applied" (the 0281-era silent-no-op class) — and a value EQUAL to an already-applied one additionally reads as "already applied". The D7 gate refuses both, comparing against the other JOURNAL entries rather than the applied set, so a mistake here fails the deploy loudly. **`when` is the highest-risk keystroke of the whole cutover — recompute the max from merge-day `main` and check strict `>` by hand anyway.**
   - The tag MUST be the bare file name. A tag carrying the directory (`pending/0287_rbac_v2_promotion`) makes drizzle apply the file from its staged location, defeating the staging design. The gate refuses that shape **while the flag is off**; with the flag ON (i.e. during this very step) it is allowed through like any other promotion tag, so there is **no automated backstop here** — get the tag right yourself.

2. Merge that branch to `main` → the production deploy applies it via `vercel-build`. The D7 gate allows it because `FEATURE_RBAC_V2=true` is now set. (The same deploy with the flag unset exits 1 by design — that is the D7 guarantee.)

   **The preview + CI outcome depends on where the flag is scoped.** The D7 gate refuses wherever the promotion is pending and `FEATURE_RBAC_V2 !== 'true'`, which includes any environment that does not carry the flag:

   - **Vercel PREVIEW** — red if the env var is scoped to Production only; green if it is set for all environments (Vercel's default when you do not narrow the scope). On the 2026-08-11 SweCham cutover it was set for all environments and the preview passed, applying the promotion to that PR's disposable Neon branch. Either outcome is correct behaviour.
   - **CI `Integration smoke`** — this one is NOT optional to handle. `.github/actions/ci-neon-env` seeds `.env.local` from `.env.example`, which ships `FEATURE_RBAC_V2="false"`, and a disposable CI Neon branch never carries the production flag. Once the promotion is journaled on `main` the gate therefore refuses **every** CI migrate, permanently, on every future PR — and `Integration smoke` is a required check. The fix already landed: the `Apply migrations` step sets the flag for itself only (test steps keep their own env). If you are cutting over a NEW tenant and see that check go red, this is why.

   **Whatever goes red, do not relax the gate to make it green.** It is the only technical mechanism standing between a stray deploy and an un-flagged promotion (FR-008 / SC-006). Only the production deploy matters for this step.

   **Then confirm the promotion actually ran** — never trust the "✓ Migrations applied" line alone:

   ```sql
   select count(*) from drizzle.__drizzle_migrations where created_at = <C's when>;
   ```

   Expect `1`. A `0` here means drizzle skipped the file: stop, fix the `when`, redeploy. Run this BEFORE the assertions below, or (a) reads `0` for the wrong reason.
3. Post-C assertions (run in the prod SQL console):

   ```sql
   -- (a) zero human plain-admins remain (all promoted).
   --     System actors are seeded by scripts/seed-system-actors.ts as
   --     `system-<name>@chamber-os.internal` with role='admin', status='disabled'
   --     — they are NOT promoted by Migration C, so they must be excluded here
   --     or this count reads 3 and triggers a false ABORT.
   --     Key these on the RESERVED UUID NAMESPACE, exactly as the migration's
   --     own predicate does. Migration C excludes
   --     `id::text LIKE '00000000-0000-0000-0000-0000000%'`, NOT an email
   --     pattern — an email-keyed check would disagree with the migration the
   --     moment a system actor is seeded off-convention, and would then read
   --     anomalous in the middle of the cutover window.
   select count(*) from users
    where role = 'admin' and id::text not like '00000000-0000-0000-0000-0000000%';
   -- (b) system actors untouched (expect role='admin', status='disabled' for each).
   --     No fixed row count: the namespace is open-ended by design, so assert the
   --     SHAPE of every row rather than that there are exactly three.
   select id, email, role, status from users
    where id::text like '00000000-0000-0000-0000-0000000%';
   -- (c) open invitations promoted coherently.
   --     NOTE: the column is `intended_role`, not `role`.
   select count(*) from invitations i join users u on u.id = i.user_id
    where u.role = 'super_admin' and i.consumed_at is null
      and i.intended_role <> 'super_admin';
   ```

   Expected: (a) `0`, (b) every returned row still `admin` / `disabled` (three today — more is fine, they are system actors by namespace), (c) `0`.
4. Verify the trigger still refuses last-administrator removal (information_schema check from section 1 + a dry-run demote of the sole super_admin in a rolled-back transaction if you want belt-and-braces — `tests/integration/auth/last-admin-guard-transitional.test.ts` is the dev-side rehearsal).

## 6. Rollback — per window

| Window | State | Rollback | Notes |
|--------|-------|----------|-------|
| **A. after flag flip, before Migration C** | flag ON, roles unchanged | set `FEATURE_RBAC_V2=false` + redeploy (~2 min) | TRUE rollback for every ROLE-BASED outcome. Two shapes changed with the SWEEP, not the flag, and therefore do **not** revert: anonymous callers to `GET /api/admin/audit/export.csv` now get `401 {"error":"no-session"}` instead of a sign-in redirect, and 11 pages deny with 404 instead of 302. |
| **B. after Migration C** | admins are now super_admins | flag OFF = **degraded-safe**: promoted super_admins evaluate as admin (D16), nobody is locked out, but D4 narrowing is gone. To fully revert, demote promoted rows (`update users set role='admin' where role='super_admin' and id <> '<pre-mint id>'`) — the trigger permits it while ≥1 administrator remains. | **Promotion floor on `vercel promote`:** never promote a pre-C deployment while post-C data exists — old code does not know `super_admin` exists in row data it may write back. Roll FORWARD (flag OFF on current code) instead. |
| **C. after PR 4 (flag default ON)** | marketing assignable, nav declarative | emergency env `FEATURE_RBAC_V2=false` overrides the code default | **Marketing-availability note:** on the OFF leg `marketing` is DENIED on every staff surface (D16 — deliberately never mapped to manager, SEC-R3-03). Any marketing staff lose access for the duration. Accepted cost; tell them first. |
| **D. after PR 5 (legacy leg deleted)** | single-leg evaluator | no flag rollback exists — revert = `vercel promote` to a pre-PR-5 deployment (subject to the promotion floor above) | PR 5 merges only after ≥1 clean window with no unexpected denial pairs. |

Last-resort freeze at any point: `READ_ONLY_MODE=true` + redeploy (503 on all state-changing `/api/**`, sign-in + reads stay alive — quickstart § 7.3).

## 7. Interrupted-cutover recovery (CHK085)

The sequence is interruptible between any two steps; each state is safe to HOLD:

| Interrupted after | System state | Resume | Or abort |
|---|---|---|---|
| pre-mint only | 1 super_admin exists, flag OFF | continue at section 3 any time — the pre-minted SA degrades to admin semantics (D16), harmless | **DELETE** the pre-minted row (not disable). `scripts/seed-bootstrap-admin.ts` refuses whenever a super_admin row exists in ANY status, so a disabled row permanently blocks re-running the pre-mint. |
| flag flip, walk incomplete | ON leg live, un-verified | finish the section 4 walk — do not leave it half-verified overnight | flag OFF (window A) |
| walk failed / aborted | flag OFF again | fix on dev, restart at section 3 | — |
| Migration C merged but deploy failed — **BUILD** stage | `vercel-build` is `run-migrations.ts && next build`, so migrations run FIRST. A failure in `next build` means the promotion **already applied**. Check before assuming anything: `select count(*) from drizzle.__drizzle_migrations where created_at = <C's when>;` | if the promotion applied: you are in window B — fix the build and redeploy, do NOT re-run migrations expecting a clean slate (C is idempotent, but the state is already promoted) | flag stays ON; data MAY have changed |
| Migration C merged but deploy failed — **MIGRATE** stage | C itself is one file = atomic under the runner's whole-batch transaction, so a failure inside `run-migrations.ts` applied nothing of C. | re-run deploy; D7 gate re-checks the flag | flag stays ON; no data changed |
| Migration C applied, assertions fail | promotion data live | do NOT flag-OFF reflexively (window B is still safe); diagnose with section 5.3 queries; system actors/coherence issues are data-fix SQL, not rollbacks | window B demotion path |

If the operator session dies mid-window: the cutover log (section 9) is the source of truth for which step completed; every step above is idempotent or hold-safe.

## 8. Bundle-change procedure (post-cutover, steady state)

Permission bundles are **code** (`src/modules/auth/domain/permissions/role-bundles.ts`). To change what a role can do:

1. Edit `ROLE_BUNDLES` + update the § 4.1 catalogue table in the design doc.
2. The pinned fixture `tests/helpers/rbac-pinned-matrix.ts` + `role-bundles.test.ts` fail — update them IN THE SAME PR (that is the review artefact).
3. If a surface's key changes, update its row in `tests/helpers/rbac-observed-baseline.ts` (`key` column only — `cells` are the flag-OFF pin and never change) + `INTENTIONAL_NARROWINGS` if the change narrows.
4. Security review is mandatory (auth surface). Ship as a normal PR — no migration, no flag.
5. Post-deploy: watch `rbac_permission_denied_total` for the affected role for one business day.

Never edit bundles via data or env — Phase 1 has no DB-driven bundles by design (§ 13 re-open triggers documented in the design doc).

## 9. Cutover log

### SweCham / TSCC — executed 2026-08-11 ✅ COMPLETE

```text
RBAC v2 cutover — 2026-08-11 (Asia/Bangkok)
[x] PR #323 (feature, ships dark) merged: df3f25908 — CI 9/9, flag absent → zero behaviour change
[x] prod migrations verified applied: 0285 (role enum += super_admin, marketing),
    0286 (audit_event_type += permission_denied; users_last_admin_guard = UNION body)
[x] pre-mint: jirawat.pyk@gmail.com — user id beb20aff-2614-466d-9614-5193d82fa345
    (dedicated break-glass identity; the two live admins were left alone for Migration C)
[x] flag ON: FEATURE_RBAC_V2=true set in Vercel + redeploy
[x] verification walk: PASS
      plain admin (jirawat.p@eqho.com) → not-found on ALL FOUR D4 surfaces
        /admin/users · /admin/audit · /admin/settings/invoicing · /admin/compliance/erasure-log
      same account → /admin/invoices · /admin/members · /admin/renewals · /admin all render
      sweep signature confirmed live: anonymous GET /api/admin/audit/export.csv → 401 no-session
[x] denial-trail check: baseline-only? YES — exactly 4 permission_denied pairs, all four
    present in INTENTIONAL_NARROWINGS. Payload shape as pinned (role/permission/route,
    no query string, no PII). Zero unexpected pairs → no abort criterion met.
[x] Migration C `when` re-validated vs journal max: main max 1798541400000 → used 1798541500000
    (prefix 0287 re-checked free; D7 gate re-run against the real repo state:
     flag unset → REFUSE, 'false' → REFUSE, 'true' → PROCEED)
[x] Migration C merged: PR #324, commit 3319a03b1
[x] promotion PROVED applied (not inferred from the runner's success line):
      select count(*) from drizzle.__drizzle_migrations where created_at = 1798541500000  → 1
[x] post-C assertions: (a) human plain-admins = 0 ✓ · (b) 3 system actors still admin/disabled ✓
    · (c) incoherent open invitations = 0 ✓
[x] post-C live re-verification: jirawat.p@eqho.com signs in as role=super_admin and reaches
    all four previously-denied surfaces; money/member surfaces unaffected
[ ] PR-4 (later): prod env var verified unset-or-'true' before the default-ON deploy
[ ] PR-5 (later): FEATURE_RBAC_V2 env var DELETED from Vercel

Final population: super_admin/active = 3 (2 promoted + 1 pre-minted) · admin/disabled = 3
(system actors, excluded by the reserved-namespace predicate) · zero human plain-admins.

NOT DONE — carried forward, see § 10:
  - T051 dev-branch rehearsal was SKIPPED. The prod verification walk superseded its
    de-risking purpose, but the consequence stands: the T045/T046 persona E2E suites have
    never executed anywhere. They remain authored-but-unproven.
  - Five pre-existing E2E specs still sign in as `admin` and open D4-narrowed surfaces
    (admin-erasure-log, f9-audit, invoices/invoice-settings, admin-journey,
    breadcrumb-navigation). On the ON leg those assertions are false. If Migration C is ever
    applied to the dev branch, re-run scripts/seed-e2e-user.ts IMMEDIATELY — otherwise the
    promoted e2e-admin turns those suites GREEN while proving nothing.
```

### Template (for the next tenant)

```text
RBAC v2 cutover — <date>
[ ] pre-mint: user id = ____________  at ____:____
[ ] flag ON deploy: url = ____________  at ____:____
[ ] verification walk: PASS / ABORT (details: ____________)
[ ] denial-trail check: baseline-only? YES / NO
[ ] Migration C `when` re-validated vs journal max: ____________
[ ] Migration C merged: commit = ____________
[ ] post-C assertions (a)=0 / (b) system ok / (c)=0 : ____________
[ ] PR-4 (later): prod env var verified unset-or-'true' before default-ON deploy
[ ] PR-5 (later): FEATURE_RBAC_V2 env var DELETED from Vercel
```

## 10. PR-4 / PR-5 operator steps (for completeness)

- **PR-4 (flag default → `true`, T066):** the code default in `src/lib/env.ts` and the value in `.env.example` are now `true`, so a fresh checkout, a preview deploy and CI all match production instead of silently exercising the legacy leg.

  An environment's EXPLICIT value still wins over the default. That is deliberate — rollback stays one env var — but it means the flip is not complete anywhere that still says `'false'`. Before merging, verify prod is **unset** or `'true'`:

  ```bash
  vercel env ls production | grep FEATURE_RBAC_V2
  # expected: absent, or present with value "true"
  ```

  SweCham/TSCC state at PR-4 time: **present, `"true"`** — set by the operator during the 2026-08-11 cutover (§ 9), so the default flip changes nothing in prod and only aligns preview + CI + local.

  Preview deployments inherit the production env var unless overridden; if a preview environment carries its own `'false'`, it is testing the leg that PR 5 deletes. Verify that too — the branch cannot assert anything about Vercel project settings from inside the repo:

  ```bash
  vercel env ls preview | grep FEATURE_RBAC_V2
  # expected: absent (inherits production), or present with value "true"
  ```

  **Only two safe values: absent, or the lower-case string `true`.** Do NOT blank the variable. `zod`'s `.default()` fires only on `undefined`, so a declared-but-empty var is a present value that resolves to `false` and drops that environment onto the legacy leg — where `manager` regains `/admin/users` and `/admin/audit`, all four D4 narrowings come off, and `marketing` is locked out of `/admin/**` entirely. `'TRUE'` and `'1'` are equally wrong in the other direction: the app reads them as ON, but the migration gate compares raw text against `'true'` and will refuse the deploy.

- **D7 promotion-gate ordering fix (PR 4).** The gate's "strictly newer than every sibling" check was unconditional, so it began refusing as soon as ANY migration newer than `0287_rbac_v2_promotion` was journaled — on an already-applied promotion. Because `run-migrations.ts` runs as `vercel-build` and inside the required `Integration smoke` check, that would have frozen prod deploys, preview deploys and merges to `main` together, on whichever unrelated branch happened to add the next migration. It is now gated on `pending`; the `when`-COLLISION check stays unconditional, since a colliding value is exactly what `pending` cannot see. Regression cases: `tests/unit/scripts/rbac-promotion-gate.test.ts` ("the steady state").
- **Privacy record (T060):** the statutory processing record for staff role administration + the marketing member-read scope is `docs/compliance/processing-records.md` § *016 — Staff Role Administration + Marketing Read Scope*. It carries the DPIA answer (no DPIA required under Art. 35(3) / WP248; note the PDPA has no DPIA obligation at all) and the last-super-admin rationale in two cases. **The successor path is PROMOTION, not § 2.** `scripts/seed-bootstrap-admin.ts` refuses whenever a super_admin row exists in any status — which is true by definition when the guard fires — so the routes are: the outgoing super_admin promotes a successor from `/admin/users` before departing, or, if they are unavailable, the operator break-glass `UPDATE users SET role='super_admin'` in the Neon console, recorded in the DPO log. Where the guard blocks a MEMBER's erasure cascade the erasure is deferred, not refused, and the Art. 12 one-month clock runs from `member_erasure_requested`. Update that record if marketing ever gains a write path over member data.

- **Dev / preview databases after PR 4 (016 review, S-5).** Migration C now sits in the migrations ROOT and is journaled, and `.env.example` ships `FEATURE_RBAC_V2="true"` — which is what `.env.local` is seeded from. The D7 gate reads that variable RAW, so it no longer blocks: the next `pnpm db:migrate` against any database that has not applied C **will promote every human admin to `super_admin`**, with no operator step.

  That is correct for prod (already done) and harmless for a disposable CI branch, but on the shared `dev` branch it silently turns `e2e-admin@swecham.test` into a super_admin — and the admin-persona E2E suites then sign in as a super_admin and prove nothing about the D4 narrowing they exist to prove. `scripts/seed-e2e-user.ts` re-provisions that row as a plain `admin` precisely to undo it.

  So the order is fixed, and it is one breath, not two sessions:

  ```bash
  pnpm db:migrate                                              # may apply Migration C
  node --env-file=.env.local --import tsx scripts/seed-e2e-user.ts   # resets e2e-admin to 'admin'
  ```

  Skipping the second command leaves the persona suites green and meaningless.

- **PR-5 (cleanup):** after the soak window, delete the `FEATURE_RBAC_V2` env var entirely (T071) — a stale value on a future redeploy would be read by nothing, but leaving dead env vars around is how the next incident starts.
