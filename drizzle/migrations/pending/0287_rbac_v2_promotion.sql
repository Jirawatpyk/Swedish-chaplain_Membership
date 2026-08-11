-- 016-rbac-permissions Migration C (T047) — human-admin → super_admin promotion.
--
-- ┌─ THIS FILE IS DELIBERATELY NOT AT THE TOP LEVEL OF drizzle/migrations/ ─┐
-- │ It is the OPERATOR-GATED promotion (D7). Staged here in `pending/` so   │
-- │ it can be rehearsed on dev (tests/integration/auth/migration-c-*.test)  │
-- │ WITHOUT tripping the run-migrations D7 gate, which greps the TOP LEVEL  │
-- │ of drizzle/migrations/ for `*rbac_v2_promotion*.sql` and exits 1 on any │
-- │ ordinary deploy (FEATURE_RBAC_V2 !== 'true'), including this branch's   │
-- │ own Vercel preview build. `readdirSync(MIGRATIONS_DIR)` is              │
-- │ non-recursive + `.sql`-filtered, so a subdirectory is invisible to the  │
-- │ gate, the enum pre-pass, AND the drizzle migrator (which applies by     │
-- │ journal tag). See docs/runbooks/rbac-v2-cutover.md §5.                  │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- OPERATOR STEP (T052 — only AFTER the flag flip + verification walk passes):
--   1. `git mv drizzle/migrations/pending/0287_rbac_v2_promotion.sql \
--            drizzle/migrations/0287_rbac_v2_promotion.sql`
--      on its OWN migration-only PR branch (NEVER merged to main before now).
--   2. Add a journal entry in drizzle/migrations/meta/_journal.json with a
--      `when` STRICTLY GREATER than every `when` on the MERGE-DAY main (other
--      features may land migrations between authoring and merge — a `when` ≤
--      the global applied max makes db:migrate a SILENT no-op, the 0281-era
--      class). At authoring time the global max is 1798541400000 (0286); use
--      1798541500000 unless a later migration has landed by merge day, in
--      which case bump past it.
--   3. Merge → the prod deploy applies it via vercel-build. The D7 gate now
--      allows it because FEATURE_RBAC_V2='true' is set. Deploying with the flag
--      unset exits 1 by design.
--
-- ONE FILE = ATOMIC under the runner's whole-batch transaction. Do NOT write
-- literal BEGIN/COMMIT (design §5): a COMMIT would split these UPDATEs from the
-- __drizzle_migrations bookkeeping row, and a crash between them would leave the
-- promotion applied but unrecorded (re-run would double-apply — here idempotent,
-- but the class is the hazard).
--
-- Promote every HUMAN admin (active OR disabled). The three system-actor rows
-- (Stripe webhook f5001, Resend webhook f5002, auto-invoice cron f5003 — the
-- canonical list is SYSTEM_ACTORS in scripts/seed-system-actors.ts; enumerate
-- EVERY entry here at write time) are excluded by id so webhook/cron writes keep
-- their role='admin'/status='disabled' identity. The D18 pre-minted super_admin
-- is out of scope by the role='admin' predicate — never touched.
UPDATE users
   SET role = 'super_admin'
 WHERE role = 'admin'
   AND id NOT IN (
     '00000000-0000-0000-0000-0000000f5001',  -- system-stripe-webhook
     '00000000-0000-0000-0000-0000000f5002',  -- system-resend-webhook
     '00000000-0000-0000-0000-0000000f5003'   -- system-auto-invoice-cron
   );

-- Promote OPEN admin invitations in lockstep with their user rows so
-- redeem-invite's tamper check (user.role === invitation.intendedRole) stays
-- coherent after the cutover (tests/contract/rbac/invitation-promotion.test.ts).
-- EXPIRED invitations are safe to skip: redeem rejects on expiry BEFORE the role
-- comparison, and reissue re-derives intended_role from the promoted user row.
UPDATE invitations
   SET intended_role = 'super_admin'
 WHERE intended_role = 'admin'
   AND consumed_at IS NULL
   AND expires_at > now();
