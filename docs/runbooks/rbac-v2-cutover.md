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
  select routine_name from information_schema.routines
   where routine_name = 'users_last_admin_guard';
  select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'audit_event_type' and e.enumlabel = 'permission_denied';
  ```

- [ ] The Migration C PR exists on its **own migration-only branch** and is **NOT merged** (D7). Its file name carries the `rbac_v2_promotion` tag the D7 gate greps for.
- [ ] `docs/observability.md` denial-baseline alert reviewed; you know where `rbac.permission_denied_total{role, permission}` is graphed.
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

**Expected-denial baseline** = exactly the pairs implied by `INTENTIONAL_NARROWINGS` in `tests/helpers/rbac-observed-baseline.ts` (admin/manager on users, audit, settings.invoicing, erasure surfaces, settings.renewal_schedules for manager, plus member probes).

**ABORT CRITERION:** any (role, permission, route) denial pair **not** in that baseline — especially any `admin` or `manager` denial on a money surface (`invoicing.*`, `refunds.*`, `renewals.*` reads) — means the matrix is wrong in production. Do not diagnose live: **roll back** (section 6, window A) and reproduce on dev.

## 5. Step 4 — Migration C (promotion)

Only after section 4 passes:

1. **Re-validate C's journal `when` AT MERGE TIME** — other features may have landed migrations between authoring and merge; a `when` ≤ the global applied max makes `db:migrate` a **silent no-op** ("✓ applied" while applying nothing — the 0281-era class). Rule: `when` must be strictly greater than every `when` in `drizzle/migrations/meta/_journal.json` on the MERGE-DAY main.
2. Merge the Migration C PR to `main` → the production deploy applies it via `vercel-build`. The D7 gate in `run-migrations.ts` allows it because `FEATURE_RBAC_V2=true` is now set. (Deploying C with the flag unset exits 1 by design.)
3. Post-C assertions (run in the prod SQL console):

   ```sql
   -- (a) zero human plain-admins remain (all promoted)
   select count(*) from users where role = 'admin'
     and id not in (select id from users where email like 'system+%');
   -- (b) all three system actors untouched
   select email, role from users where email like 'system+%';
   -- (c) open invitations promoted coherently
   select count(*) from invitations i join users u on u.id = i.user_id
    where u.role = 'super_admin' and i.consumed_at is null and i.role <> 'super_admin';
   ```

   Expected: (a) `0`, (b) system actors keep their original roles, (c) `0`.
4. Verify the trigger still refuses last-administrator removal (information_schema check from section 1 + a dry-run demote of the sole super_admin in a rolled-back transaction if you want belt-and-braces — `tests/integration/auth/last-admin-guard-transitional.test.ts` is the dev-side rehearsal).

## 6. Rollback — per window

| Window | State | Rollback | Notes |
|--------|-------|----------|-------|
| **A. after flag flip, before Migration C** | flag ON, roles unchanged | set `FEATURE_RBAC_V2=false` + redeploy (~2 min) | TRUE rollback — byte-identical legacy behaviour returns. |
| **B. after Migration C** | admins are now super_admins | flag OFF = **degraded-safe**: promoted super_admins evaluate as admin (D16), nobody is locked out, but D4 narrowing is gone. To fully revert, demote promoted rows (`update users set role='admin' where role='super_admin' and id <> '<pre-mint id>'`) — the trigger permits it while ≥1 administrator remains. | **Promotion floor on `vercel promote`:** never promote a pre-C deployment while post-C data exists — old code does not know `super_admin` exists in row data it may write back. Roll FORWARD (flag OFF on current code) instead. |
| **C. after PR 4 (flag default ON)** | marketing assignable, nav declarative | emergency env `FEATURE_RBAC_V2=false` overrides the code default | **Marketing-availability note:** on the OFF leg `marketing` is DENIED on every staff surface (D16 — deliberately never mapped to manager, SEC-R3-03). Any marketing staff lose access for the duration. Accepted cost; tell them first. |
| **D. after PR 5 (legacy leg deleted)** | single-leg evaluator | no flag rollback exists — revert = `vercel promote` to a pre-PR-5 deployment (subject to the promotion floor above) | PR 5 merges only after ≥1 clean window with no unexpected denial pairs. |

Last-resort freeze at any point: `READ_ONLY_MODE=true` + redeploy (503 on all state-changing `/api/**`, sign-in + reads stay alive — quickstart § 7.3).

## 7. Interrupted-cutover recovery (CHK085)

The sequence is interruptible between any two steps; each state is safe to HOLD:

| Interrupted after | System state | Resume | Or abort |
|---|---|---|---|
| pre-mint only | 1 super_admin exists, flag OFF | continue at section 3 any time — the pre-minted SA degrades to admin semantics (D16), harmless | disable the pre-minted account (`/admin/users`) |
| flag flip, walk incomplete | ON leg live, un-verified | finish the section 4 walk — do not leave it half-verified overnight | flag OFF (window A) |
| walk failed / aborted | flag OFF again | fix on dev, restart at section 3 | — |
| Migration C merged but deploy failed | promotion partially visible? **No** — C runs inside one deploy migration transaction; a failed deploy applied nothing. Re-deploy. | re-run deploy; D7 gate re-checks the flag | flag stays ON; no data changed |
| Migration C applied, assertions fail | promotion data live | do NOT flag-OFF reflexively (window B is still safe); diagnose with section 5.3 queries; system actors/coherence issues are data-fix SQL, not rollbacks | window B demotion path |

If the operator session dies mid-window: the cutover log (section 9) is the source of truth for which step completed; every step above is idempotent or hold-safe.

## 8. Bundle-change procedure (post-cutover, steady state)

Permission bundles are **code** (`src/modules/auth/domain/permissions/role-bundles.ts`). To change what a role can do:

1. Edit `ROLE_BUNDLES` + update the § 4.1 catalogue table in the design doc.
2. The pinned fixture `tests/helpers/rbac-pinned-matrix.ts` + `role-bundles.test.ts` fail — update them IN THE SAME PR (that is the review artefact).
3. If a surface's key changes, update its row in `tests/helpers/rbac-observed-baseline.ts` (`key` column only — `cells` are the flag-OFF pin and never change) + `INTENTIONAL_NARROWINGS` if the change narrows.
4. Security review is mandatory (auth surface). Ship as a normal PR — no migration, no flag.
5. Post-deploy: watch `rbac.permission_denied_total` for the affected role for one business day.

Never edit bundles via data or env — Phase 1 has no DB-driven bundles by design (§ 13 re-open triggers documented in the design doc).

## 9. Cutover log template

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

- **PR-4 (flag default → `true`):** before merging, verify the prod env var is either **unset** or `'true'` — a leftover `'false'` silently defeats the code default flip (T066).
- **PR-5 (cleanup):** after the soak window, delete the `FEATURE_RBAC_V2` env var entirely (T071) — a stale value on a future redeploy would be read by nothing, but leaving dead env vars around is how the next incident starts.
