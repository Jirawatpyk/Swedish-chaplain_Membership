# Data Model — 016 RBAC Permissions

No new tables. No column drops. Changes: two enum widenings, one new audit event value,
one trigger rewrite (twice: transitional → strict), one data-only promotion migration,
plus pure in-code Domain data (catalogue + bundles). Design authority: design doc § 4–§ 5.

## 1. Domain entities (in code — `src/modules/auth/domain/permissions/`)

### Role (extended)

```ts
// role.ts — ROLES tuple widens; order stable for pgEnum parity
type Role = 'super_admin' | 'admin' | 'manager' | 'marketing' | 'member';
```

- Single-valued per user (1 user = 1 role) — unchanged invariant.
- Stored on `users.role` AND `invitations.intended_role` (shared pgEnum — one
  Migration A widens both).
- `STAFF_ROLES` gains `super_admin` + `marketing`; `PORTAL_FOR_ROLE` maps both to `staff`.
- `platform_admin` is RESERVED (never defined here) for the future F13 console (D1).

### PermissionKey + catalogue entry

```ts
// permission-catalogue.ts (pure data)
type PermissionKey = `${string}.${string}`;        // DOT separator — never the legacy colon
interface CatalogueEntry {
  key: PermissionKey;
  superAdminOnly?: true;                            // refused by evaluator for any other role
  sensitive?: 'money' | 'pii';                      // drives review checklist on bundle diffs
}
```

- The 40-key pinned catalogue = design § 4.1 table (verbatim — `/speckit.tasks` may ADD
  keys discovered by the route inventory, never rename or repurpose existing ones).
- Pinned legacy folds (shim disambiguation): credit-note READS → `invoicing.read`;
  draft-invoice DELETE → `invoicing.write`; receipt-PDF DOWNLOAD → `invoicing.read`
  (NOT `invoicing.receipt` = mark-paid/mint-§105 action).

### RoleBundle

```ts
// role-bundles.ts (pure data)
const ROLE_BUNDLES: Record<Role, ReadonlySet<PermissionKey>>;
```

Invariants (each a Domain test):
- No bundle contains a `superAdminOnly` key (FR-003).
- `member` bundle is EMPTY (member portal authz is untouched by this feature).
- Every staff bundle ⊇ {`dashboard.view`} ∪ ≥1 widget permission (landing invariant, § 8).
- Bundles exactly reproduce the § 4.1 matrix (table-driven parity test).

### PermissionSet (derived, never persisted)

```ts
getPermissionSet(role: Role): ReadonlySet<PermissionKey>   // synchronous, no DB read (D15);
                                                            // feeds nav/palette filtering
hasPermission(role: Role, key: PermissionKey,
              opts: { rbacV2: boolean }): boolean           // pure; flag = explicit param
// CANONICAL signature is ROLE-FIRST (matches contracts/permission-evaluator.md §1):
// E1 super_admin bypass and E4 D16 totalisation both require the ROLE — a bare set
// cannot express either. Design §6.1's `getPermissionSet → hasPermission(set, key)`
// pipeline sketch is conceptual flow, not the API signature.
```

- `super_admin` → evaluator bypass (always allowed), EXCEPT nothing — bypass is total (D3
  scope is enforced by other roles' bundles, not by restricting SA).
- `superAdminOnly` keys → refused for every non-SA role regardless of bundle content.
- Flag OFF leg: shim per call-site class (contracts/permission-evaluator.md) with D16
  totalisation — `super_admin` ⇒ admin semantics; `marketing` ⇒ DENY.

## 2. Database changes

### Migration A (PR 1) — role enum widening

```sql
ALTER TYPE "public"."role" ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE "public"."role" ADD VALUE IF NOT EXISTS 'marketing';
```

- `IF NOT EXISTS` REQUIRED — the runner's autocommit enum pre-pass re-executes enum DDL
  from all files on every deploy.
- Same commit: roleEnum tuple in `src/modules/auth/infrastructure/db/schema.ts` widens;
  `REQUIRED_ENUM_VALUES.role += ['super_admin','marketing']` in
  `scripts/lib/enum-migration-guard.ts` (Phase-3 fail-loud assertion).
- Post-A invariant: **no row holds the new values** until the operator pre-mints the
  verification super_admin (D18 runbook step) — Migration C is the only other writer.

### Migration B (PR 2) — audit enum + transitional trigger

```sql
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'permission_denied';

CREATE OR REPLACE FUNCTION users_last_admin_guard() ... ;
-- transitional population: role IN ('admin','super_admin')
```

MUST-KEEP trigger contract (all three, regression-tested on live Neon):
1. ERRCODE `23514`;
2. literal `'last-admin-protection'` message substring
   (`isLastAdminTriggerError` matches BOTH; consumers: change-role, disable-user, erase-user);
3. 0004 return-row logic — `RETURN OLD` when `TG_OP='DELETE'`, `RETURN NEW` otherwise
   (regression silently swallows deletes).

Also PR 2 (application layer, not SQL): `countActiveAdmins()` → `countActiveSuperAdmins()`
with THREE callers — `change-role.ts`, `disable-user.ts`, and `erase-user.ts` (new
pre-flight; erase is irreversible and has no count check today).

### Migration C (own migration-only PR + deploy — D7)

```sql
-- ONE file = atomic under the runner's whole-batch transaction.
-- NO literal BEGIN/COMMIT (would split UPDATEs from __drizzle_migrations bookkeeping).
UPDATE users SET role = 'super_admin'
  WHERE role = 'admin'
    AND id NOT IN (/* every SYSTEM_ACTORS id, enumerated at write time —
                      canonical list scripts/seed-system-actors.ts;
                      THREE today: f5001 Stripe webhook, f5002 Resend webhook,
                      f5003 auto-invoice cron */);
UPDATE invitations SET intended_role = 'super_admin'
  WHERE intended_role = 'admin' AND consumed_at IS NULL AND expires_at > now();
```

- Users + open invitations promote atomically → redeem-invite's tamper check
  (`user.role = invitation.intendedRole`) stays coherent. Expired invitations skipped
  (reissue re-derives the role). The D18 pre-minted SA row is untouched by predicate.
- Technical gate (added to `run-migrations.ts` in PR 2): if the pending batch contains
  the promotion migration (filename tag) and `FEATURE_RBAC_V2 !== 'true'` in the build
  env → exit 1 BEFORE `migrate()`. Premature merge fails the build; no lockout.
- Ordering: journal guarantees A→B→C; C-before-B additionally self-aborts (old 0004
  guard refuses promoting the last admin — rehearsed as the reversed-order test).

### PR 5 — strict trigger

```sql
CREATE OR REPLACE FUNCTION users_last_admin_guard() ... ;
-- strict population: role = 'super_admin' only  (same three-part contract)
```

### Journal discipline (all three migrations)

Hand-written SQL + `drizzle/migrations/meta/_journal.json` entry; each `when` >
current global applied max (collision = silent no-op — verify DDL landed via
`information_schema`, bump +100000 ms on conflict).

## 3. New audit event

| Field | Value |
|---|---|
| enum value | `permission_denied` (audit_event_type — Migration B) |
| retention | 5 years (default class) |
| payload (pinned, nothing else) | `{actor_user_id, role, permission_key, route_path, request_id}` — `role` = actor's REAL role (no coercion); `route_path` WITHOUT query string |
| emit semantics | fail-open: the denial response is served even if the emit fails |
| registration | the ~6 `check:audit-events` / `check:audit-counts` places + domain const + pgEnum + 2 test counts (memory: 4-places rule) |

F6 route families ALSO keep emitting their existing `role_violation_blocked` taxonomy
(alongside, not replaced — D9).

## 4. State machines

### Flag lifecycle (§ 6.2)

```
PR2 deployed ──D18 pre-mint──► SA exists ──flag ON + verify──► ON ──Migration C──► promoted
    │  OFF = byte-identical legacy (shim)          │  ON = new matrix + D4 narrowing
    └──────────── rollback = flag OFF ─────────────┘
post-C:  flag OFF = degraded-safe (SA→admin semantics; marketing DENIED)   [D16]
PR 4:    code default ON (env.ts zod default true); env override = emergency lever
PR 5:    legacy leg + shim + façade + env read deleted; Vercel env var deleted
Promotion floor: after C, never `vercel promote` older than the PR-2 deployment.
```

### Role transitions (per-account)

```
admin ──Migration C (human rows only)──► super_admin
super_admin ──UI demote (change-role)──► admin | manager | marketing     [guarded: not the last SA]
any staff role ──change-role──► any staff role                            [marketing assignable from PR 4]
member ◄──── NEVER transitions to/from staff roles via change-role (existing invariant, unchanged)
Removal paths (demote/disable/delete/erase): refused for the last active super_admin
at BOTH layers (app pre-flight ×3 callers + DB trigger).
```

## 5. Validation rules

- `FEATURE_RBAC_V2`: zod boolean in `src/lib/env.ts` — default `false` (PR 2) →
  default `true` (PR 4) → key deleted (PR 5). Only `src/lib/rbac.ts` reads it.
- Role picker (PR 3): offers super_admin/admin/manager (+ marketing from PR 4);
  member never offered on the staff picker (target-role branch, § 7.1).
- Invitation issuance: `intended_role` constrained to assignable roles at issue time;
  redeem re-validates `user.role = invitation.intendedRole` (existing check, kept).
