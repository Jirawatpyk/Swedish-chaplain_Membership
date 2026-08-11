# RBAC Permission System — Design (v2, revision 3)

**Date**: 2026-08-10 (v1 → 154-finding review → v2 → 24-finding verification →
rev 2 → 48-finding round-3 review → this revision)
**Status**: Pending maintainer approval → Spec Kit intake
**Supersedes**: v1 (git `952b7f174`), v2 rev 1–2 (git history). Review artefacts
live in `2026-08-10-rbac-design-review-findings.md` (all three rounds).
Round 3 confirmed the Phase-1 architecture is sound; every surviving finding
was a specification-precision issue, folded in here. § 15 lists the four
maintainer-visible decisions this fold took (marked ⚑ — veto before intake).

## 1. Goal

Extend RBAC from three hardcoded roles to **five system roles** backed by a
**permission catalogue and per-role bundles defined in code** (Domain layer),
convert the codebase's role-string authorization checks into positive
permission checks, harden the staff surfaces that currently fail open, and make
navigation permission-aware.

Business drivers (TSCC, first tenant) — all satisfied by Phase 1:

- A **Super Admin** (top tenant role) separate from day-to-day **Admin** staff.
- A **Marketing** role operating E-Blast + events without access to money,
  member mutation, or compliance surfaces.
- Staff/role assignment via UI (the existing `/admin/users` page, retrofitted).
- Navigation reflecting what the signed-in role can actually do.

## 2. Decisions

| # | Decision |
|---|----------|
| D1 | Super Admin is **tenant-level**. F13's platform console must NOT reuse the `super_admin` key (reserve `platform_admin`). Phase-1 caveat: `users.role` is a global column, so role assignment is tenant-level only by virtue of single-tenant deployment; a second tenant REQUIRES the F10 `user_tenants` work before or with Phase 2. |
| D2 | Marketing = broadcasts full RW — compose, approve, send; **self-approval is permitted by design** (⚑ recorded: no submitter≠approver invariant exists today either, but for marketing this removes the only human review before a ≤5,000-recipient blast). Events RW **excluding** attendee-PII erasure (D10) **and excluding registration relink** (⚑ new `events.relink`, admin + super_admin — relink moves member linkage + benefit quota that F6 event-fee invoices resolve buyers from). Members/contacts read-only without sensitive PII (D11); `directory.export` **stays with manager and admin** (⚑ behaviour-preserving — manager can export today). Insights engagement only. |
| D3 | Super-Admin-exclusive (removed from `admin`): staff user + role assignment (`users.manage`), invoice/tax settings, GDPR/PDPA erasure (member erasure, event-attendee erasure, erasure log), audit-log read. `admin` keeps day-to-day money operations, the operational settings pages (§ 7.3), and **member-portal-account administration** (⚑ `users.member_accounts`, § 7.1 — disable/revoke on member accounts is account housekeeping, not role assignment). |
| D4 | **Permanent capability narrowings at flag-ON**, enumerated exhaustively (round 3 falsified rev 2's "only one" claim): (a) `manager` loses audit-log read, the `/admin/users` and `/admin/audit` pages (open to all staff today), and the settings pages it can open today (§ 7.3 matrix); (b) nothing else changes for any existing account class — plain `admin` exists again only after post-Migration-C demotions. The transient SA-only-orphan problem is eliminated by the D18 pre-mint step. |
| D5 | Architecture = Phase 1: catalogue + bundles as pure data in `src/modules/auth/domain/`. No new tables, no role editor. Bundle/role changes = code change + deploy. |
| D6 | No role editor UI (v1 design parked for Phase 2). |
| D7 | Existing human `admin` accounts are promoted to `super_admin` by **Migration C**, a promotion that must never ride an ordinary feature deploy. Enforcement is technical, not conventional (round-3 SEC-R3-01): (1) Migration C's `.sql` + `_journal.json` entry **must not exist on `main`** until promotion time — it merges in its own migration-only PR whose deploy performs the promotion; (2) `run-migrations.ts` gains a **pre-migrate assertion in PR 2**: if the pending batch contains the promotion migration (identified by filename tag) and `FEATURE_RBAC_V2` is not `'true'` in the build env, exit 1 before `migrate()` — a premature merge fails the build loudly instead of locking staff out; (3) the § 11 runbook names a **promotion floor**: after C, never `vercel promote` to any deployment older than PR 2. |
| D8 | Evaluator cutover behind `FEATURE_RBAC_V2` (env, default false) with the staged lifecycle of § 6.2. |
| D9 | Denial convention: pages `notFound()` (404), API routes 403 — with the **F6 route-local override reproduced from the real guard, per role** (round-3 corrected): for `/api/admin/events/**` AND `/api/admin/integrations/eventcreate/**`, `adminOnlyWriterGuard` returns **403 + RFC 7807 + audit to manager, 404 to member / unknown role / no session**. These routes keep their existing `role_violation_blocked` F6 audit taxonomy unchanged (alongside, not replaced by, `permission_denied`). § 10 matrix rows for these families are captured from observed guard behaviour; the stale `archive/route.ts` header comment is fixed in PR 2. |
| D10 | F6 attendee-erasure + F3 member-erasure endpoints carry explicit `superAdminOnly` erasure permissions. |
| D11 | Date-of-birth (and any literal `role === 'admin'` minimisation gate) moves to `members.pii_sensitive` (super_admin + admin). |
| D12 | Denials audited for every role via `permission_denied`. Payload pinned (§ 6.1); emit is fail-open (denial response always served even if the emit fails). |
| D13 | DB last-admin trigger rewritten, never dropped: transitional UNION population (`role IN ('admin','super_admin')`) until PR 5's strict super-admin-only version. Strict invariant at the app layer from PR 2 via `countActiveSuperAdmins()` — with **three** callers: `change-role.ts`, `disable-user.ts`, **and `erase-user.ts`** (round-3 SEC-R3-02: erase has no pre-flight today and erasure is irreversible; without it, erasing the last super_admin while a plain admin exists passes BOTH layers deterministically). |
| D14 | The role pgEnum stays. No `role_id`, no new tables, no column drop. |
| D15 | Session shape unchanged; PermissionSet derived synchronously from role. |
| D16 | Legacy-leg totalisation (PR 1): `super_admin` evaluates with **admin semantics**; `marketing` is **DENIED on all staff surfaces** (no-match → 404/403) rather than mapped to manager (round-3 SEC-R3-03: a manager mapping would GRANT marketing the money-read surface during any emergency flag-OFF after PR 4 — losing marketing availability during an emergency is the acceptable cost; the runbook notes it). |
| D17 | `marketing` becomes assignable only in PR 4, with the surfaces it needs. |
| D18 | **(NEW — round-3 CC-3 resolution)** Immediately before the flag-ON verification, the operator **pre-mints the first `super_admin`** (updated `seed-bootstrap-admin`, which refuses when a super_admin already exists). This closes the SA-orphan window (between flag-ON and Migration C no account would otherwise hold any superAdminOnly key), gives verification a real allow-path persona, and revises § 5's invariant to: *no row holds the new enum values until the operator mints the verification super_admin (runbook step, immediately before flag-ON)*. |

## 3. Roles

| Role key | Portal | Summary |
|---|---|---|
| `super_admin` | staff | Everything (evaluator bypass). |
| `admin` | staff | Day-to-day ops incl. money, operational settings, member-account housekeeping (`users.member_accounts`). No staff user/role assignment, invoice/tax settings, erasure, audit read. |
| `manager` | staff | Read-only on business surfaces; loses the D4 enumerated surfaces. Self-service writes only. |
| `marketing` | staff | Exactly the ✓ keys in § 4.1. |
| `member` | member | Self-service, unchanged. |

Role display names: 5 × EN/TH/SV keys.

## 4. Permission model

### 4.1 Catalogue + bundles in code (Domain)

`permission-catalogue.ts` (keys + flags) + `role-bundles.ts`
(`ROLE_BUNDLES: Record<Role, ReadonlySet<PermissionKey>>`). Key naming:
`<module>.<action>`, DOT separator (distinct from the legacy colon `Resource`
union, which coexists during migration).

**Committed minimum catalogue** (pinned; `/speckit.plan` may ADD keys from the
route inventory, never rename or repurpose). SA = `superAdminOnly`.

| Key | Flags | super_admin | admin | manager | marketing |
|---|---|---|---|---|---|
| `dashboard.view` | | ✓ | ✓ | ✓ | ✓ |
| `members.read` | | ✓ | ✓ | ✓ | ✓ |
| `members.write` | pii | ✓ | ✓ | | |
| `members.bulk` | pii | ✓ | ✓ | | |
| `members.pii_sensitive` | pii | ✓ | ✓ | | |
| `members.erasure` | SA, pii | ✓ | | | |
| `members.erasure_log_read` | SA, pii | ✓ | | | |
| `contacts.read` | | ✓ | ✓ | ✓ | ✓ |
| `contacts.write` | pii | ✓ | ✓ | | |
| `directory.export` | pii | ✓ | ✓ | ✓ | |
| `plans.read` | | ✓ | ✓ | ✓ | |
| `plans.write` | money | ✓ | ✓ | | |
| `plans.clone` | money | ✓ | ✓ | | |
| `invoicing.read` | | ✓ | ✓ | ✓ | |
| `invoicing.write` | money | ✓ | ✓ | | |
| `invoicing.issue` | money | ✓ | ✓ | | |
| `invoicing.void` | money | ✓ | ✓ | | |
| `invoicing.receipt` | money | ✓ | ✓ | | |
| `credit_notes.write` | money | ✓ | ✓ | | |
| `refunds.write` | money | ✓ | ✓ | | |
| `payments.read` | | ✓ | ✓ | ✓ | |
| `renewals.read` | | ✓ | ✓ | ✓ | |
| `renewals.write` | money | ✓ | ✓ | | |
| `broadcasts.read` | | ✓ | ✓ | ✓ | ✓ |
| `broadcasts.write` | | ✓ | ✓ | | ✓ |
| `broadcasts.send` | | ✓ | ✓ | | ✓ |
| `events.read` | | ✓ | ✓ | ✓ | ✓ |
| `events.write` | | ✓ | ✓ | | ✓ |
| `events.relink` | money | ✓ | ✓ | | |
| `events.erasure` | SA, pii | ✓ | | | |
| `insights.engagement` | | ✓ | ✓ | ✓ | ✓ |
| `insights.finance` | money | ✓ | ✓ | ✓ | |
| `insights.activity_unredacted` | pii | ✓ | ✓ | | |
| `users.manage` | SA | ✓ | | | |
| `users.member_accounts` | pii | ✓ | ✓ | | |
| `audit.read` | SA | ✓ | | | |
| `settings.invoicing` | SA, money | ✓ | | | |
| `settings.renewal_schedules` | | ✓ | ✓ | | |
| `settings.broadcasts` | | ✓ | ✓ | | |
| `settings.integrations` | | ✓ | ✓ | | |

Granularity principle: one key per irreversible document/money action —
`invoicing.issue` (reserves a §87 gap-free number) is therefore split from
`invoicing.write` (draft ops) even though both are admin ✓ today, so Phase 2
never has to re-touch call sites to split them.

**Pinned legacy folds** (round-3 MS-5 — ambiguity killers for the shim):
credit-note READS → `invoicing.read` · draft-invoice DELETE →
`invoicing.write` · receipt-PDF DOWNLOAD → `invoicing.read` (NOT
`invoicing.receipt`, which is the mark-paid/mint-§105 action).

### 4.2 Enforcement flags

- `superAdminOnly` — refused by the evaluator itself for any other role; a
  Domain test asserts no bundle contains one.
- `sensitive: 'money' | 'pii'` — drives the `/speckit.review` checklist on
  bundle diffs. `plans.write`/`plans.clone` carry `money` because plan prices
  are the source amounts of every §86/4 membership bill.

### 4.3 Insights + audit-content splits

- `insights.engagement` vs `insights.finance`: PR 4 splits the F9 snapshot
  loader into separately cacheable parts; widget→permission map; the grid
  collapses gracefully.
- **Activity feed** redaction re-keys from literal `'manager'` to
  `insights.activity_unredacted` — **ON leg only**.
- **Audit viewer**: ON leg — redaction keyed to the permission decision
  (`audit.read` holder ⇒ unredacted projection; anything else redacted);
  `AuditViewerRole` is NOT widened to string; contract test: super_admin
  viewing `refund_initiated` receives the full payload incl. `reason`.
  **OFF (legacy) leg keeps today's projection exactly** (admin → full,
  manager → redacted; post-C super_admin →D16→ admin → full) — round-3 R3-3;
  § 6.3 invariant 5 ("never a role literal") is scoped to the ON leg / PR-5
  end state. Characterization rows assert the OFF-leg projection both ways.

## 5. Data changes (additive only — no column is ever dropped)

```
Migration A (PR 1):
  ALTER TYPE "public"."role" ADD VALUE IF NOT EXISTS 'super_admin';
  ALTER TYPE "public"."role" ADD VALUE IF NOT EXISTS 'marketing';
  -- IF NOT EXISTS form is REQUIRED: the runner's autocommit enum pre-pass
  -- (scripts/run-migrations.ts:94-137) re-executes enum DDL from ALL files;
  -- bare ADD VALUE would fail the deploy on re-run (round-3 R3-M1).
  -- Ships with: the roleEnum tuple widening in
  -- src/modules/auth/infrastructure/db/schema.ts (tuple and DB enum must
  -- never diverge) and REQUIRED_ENUM_VALUES extended with
  -- role: ['super_admin','marketing'] in scripts/lib/enum-migration-guard.ts
  -- (the runner's Phase-3 fail-loud assertion — primary automated guard
  -- against the silent-no-op class; runbook check is the manual backstop).

Migration B (PR 2):
  ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'permission_denied';
  -- + REQUIRED_ENUM_VALUES gains 'permission_denied'.
  CREATE OR REPLACE FUNCTION users_last_admin_guard():
  -- transitional UNION guard (D13). MUST-KEEP contract, three items:
  --   1. ERRCODE 23514
  --   2. the literal 'last-admin-protection' message substring
  --      (isLastAdminTriggerError at src/lib/db-errors.ts matches BOTH;
  --      consumers: change-role.ts, disable-user.ts, erase-user.ts)
  --   3. the 0004 return-row logic: RETURN OLD when TG_OP='DELETE',
  --      RETURN NEW otherwise (regression here silently swallows deletes).

Migration C (its own migration-only PR + deploy — D7 mechanism):
  -- One file = atomic under the runner's whole-batch transaction.
  -- Do NOT write literal BEGIN/COMMIT (a COMMIT would split the UPDATEs
  -- from the __drizzle_migrations bookkeeping).
  UPDATE users       SET role='super_admin'
    WHERE role='admin' AND id NOT IN (<ALL system-actor ids — canonical
      list = SYSTEM_ACTORS in scripts/seed-system-actors.ts; THREE today:
      Stripe webhook f5001, Resend webhook f5002, auto-invoice cron f5003 —
      enumerate every entry at write time>);
  UPDATE invitations SET intended_role='super_admin'
    WHERE intended_role='admin' AND consumed_at IS NULL AND expires_at > now();
  -- Promoting users AND open invitations together keeps redeem-invite's
  -- tamper check (user.role = invitation.intendedRole) coherent. Expired
  -- invitations are safe to skip: reissue re-derives intendedRole from the
  -- user row. The D18 pre-minted super_admin row is untouched by predicate.

PR 5 (cleanup): CREATE OR REPLACE users_last_admin_guard() — strict
  super-admin-only population.
```

Discipline notes: hand-written SQL + `_journal.json`; each `when` must exceed
the current global applied max; journal order guarantees A→B→C;
B-before-C is additionally self-protecting (running C under the old 0004
guard aborts on the promotion of the last admin — the § 10 reversed-order
rehearsal asserts exactly this abort). `countActiveAdmins()` becomes
`countActiveSuperAdmins()` with its **three** callers (D13) in PR 2.
`seed-bootstrap-admin.ts` + DR seed scripts update to `super_admin` in PR 2
(bootstrap refuses only when a super_admin exists — D18 relies on this).

## 6. Enforcement

### 6.1 Evaluation path

```
requireSession(portal)  →  getPermissionSet(role)  →  hasPermission(set, key)
```

**Purity pin** (round-3 R3-04): the evaluator — new leg, shim legacy leg, and
D16 normalisation — is a **pure Domain function taking the flag as an
explicit parameter**. The only `FEATURE_RBAC_V2` env reads live in the two
helpers and the `canAccess` façade (all in a named `src/lib` file). Client
call sites never read the flag or the env: they receive server-derived
permission booleans as props. `src/modules/plans` consumes the evaluator via
a deep import of the pure Domain module (never auth's public barrel — argon2
client-bundle hazard), threading the flag from its application/server
boundary; needs a Principle III `no-restricted-imports` carve-out.

**Helpers**: `requirePagePermission(key)` → emit `permission_denied` →
`notFound()`; `requireApiPermission(key)` → emit → typed 403 result. Flag
branch inside the evaluator only; call sites rewritten once, unconditionally.

**`permission_denied` payload pin** (round-3 SEC-R3-07):
`{actor_user_id, role (real), permission_key, route path WITHOUT query
string, request_id}` and nothing else; emit fail-open (D12).

**Compatibility shim — corrected grammar** (round-3 Criticals R3-1/R3-01):
shim rows are **per call-site class, not per key** — one key may span several
rows. `legacySessionOnly` applies ONLY to the 17 genuinely ungated pages.
Every API route's row maps to its actual current guard:
`users.manage` → `mappedLegacy('auth:user','write')`; `members.erasure` →
`mappedLegacy('members','write')`; `settings.invoicing` spans THREE rows
(page → legacySessionOnly · GET → manager-readable today ·
PUT/logo → admin-only); the F6 families → a named `legacyF6Guard` row class
(D9 semantics). The `audit.read` PAGE row is legacySessionOnly (ungated
today); its viewer projection follows § 4.3. **Anti-circularity rule**:
legacy-leg expected cells in § 10 are captured from OBSERVED pre-PR-2
behaviour, never derived from the shim table. Flag-OFF characterization
must assert manager is still DENIED on all six users routes, both erasure
endpoints, the erasure log, and the invoice-settings mutations.

**Call-site inventory** — FOUR pattern classes (round-3 CC-1 adds the 4th):
~175 raw role-string comparisons across ~120 files; 4 escalate-to-admin
ternaries; 4 demote-direction ternaries; ~12 `as 'admin' | 'manager'` casts;
**exhaustive role if-chains with a default-deny/`return []` arm** (e.g.
`search-plans.ts` filterByRole and its client mirror in the command-palette
registry — these fall through to EMPTY for unknown roles, so a promoted
super_admin would get an empty palette). The PR-2 sweep greps all four.

**Third authorization surface — nav/palette data** (round-3 CC-1, Important):
role authorization also lives in nav DATA (`src/config/nav.ts` items carrying
literal `roles: ['admin']` arrays — erasure-log, broadcasts-settings,
eventcreate-integration — filtered by `filterNavConfig`'s raw
`roles.includes(role)`) and in the palette role filters. **All of these are
swept in PR 2** like every other call site (behaviour-preserving via the
flag-parameterised evaluator; the three `roles: ['admin']` arrays widen to
include `'super_admin'`), so a promoted operator never loses the erasure-log
nav entry or gets an empty palette. PR 4 then replaces the mechanism with
declarative `requiredPermission` entries. § 8's earlier "PR-3 interim nav
check" is superseded by this PR-2 sweep.

**Audit emitters**: full sweep of ALL emitters that coerce unknown roles
(≥6 sites); `actor_role` payload unions widen to the full staff-role union
(incl. the F6 audit-port `'member'|'manager'` enum).

**Legitimate role reads remain** (identity, not authorization): portal
routing, sign-in, invitation issuance, seeds/scripts, audit stamping. The
architecture guard targets authorization reads outside this allowlist.

### 6.2 Flag lifecycle

| Window | Flag OFF means | Flag ON means |
|---|---|---|
| PR 2 → D18 pre-mint | Byte-identical legacy (shim rows reproduce every observed current gate — incl. admin-only API routes staying admin-only) | New matrix; D4 narrowing; SA-only keys held by nobody YET (why D18 exists) |
| D18 pre-mint → Migration C | As above; the pre-minted super_admin evaluates via D16 as admin | New matrix; verification runs with a real SA persona |
| Migration C → PR 4 | Degraded-safe: promoted accounts evaluate with admin semantics (D16); **marketing accounts are DENIED staff surfaces** (D16) — runbook notes the availability cost | New matrix |
| PR 4 → PR 5 | Emergency env override only — code default flips ON in PR 4 (env.ts zod default true). Runbook: at PR-4 deploy verify the prod env var is unset or `'true'` (an explicit leftover `'false'` silently defeats the flip); emergency OFF with active marketing accounts removes their access for the duration | (default) |
| PR 5 | Legacy leg + shim + façade + env read deleted; **delete the Vercel env var** | — |

Rollback: before C, flag OFF is a true rollback. After C, flag OFF is a safe
degrade + account-level rollback = demotion. **Promotion floor** (D7): after
C, never `vercel promote` past the PR-2 deployment.

### 6.3 Safety invariants (each with tests)

1. Last-super-admin: app-layer strict guard with **three** callers
   (change-role, disable-user, erase-user) + DB transitional UNION trigger.
   Integration test: erasing the last super_admin while a plain admin exists
   is REFUSED. Residual: a concurrent-demote race on the app guard between C
   and PR 5 — recoverable via `seed-bootstrap-admin`.
2. `superAdminOnly` refused by the evaluator + Domain bundle test.
3. Every staff page positively gated — `check:staff-page-guard` (clone the
   `portal-guard-core` gate precedent; literal-only permission arguments so
   the gate can parse them; wiring edits: `.husky/pre-push` line +
   `quality-gates.yml` static step — both named PR-2 deliverables).
4. Denials audited for all roles with the actor's REAL role.
5. Audit-viewer redaction keyed to permission — ON leg / end state (§ 4.3).

## 7. Surfaces

### 7.1 `/admin/users` — RETROFIT (live today, open to all staff)

- **PR 2 sweep**: page + all six mutating API routes (invite, resend, revoke,
  change-role, disable, enable) gated. **Key split** (round-3 CC-2, ⚑):
  routes acting on a STAFF target require `users.manage` (SA-only); routes
  acting on a MEMBER target require `users.member_accounts` (admin +
  super_admin) — the guard already loads the target row, so it branches on
  the target's role, and the § 10 matrix carries per-target-role expectation
  rows for these routes. Without the split, a day-to-day admin could invite
  a member to the portal (via the members surface, `contacts.write`) but not
  revoke a mistaken invitation or disable that member's account.
- **PR 3**: role picker (super_admin/admin/manager; marketing in PR 4);
  member-account lifecycle preserved; every dialog passes explicit
  `finalFocus` (fix the pre-existing `user-list-table.tsx` omission);
  keyboard E2E asserts `document.activeElement !== body` after a row action.

### 7.2 `/admin/audit`

Gated behind `audit.read` in the PR-2 sweep; viewer projection per § 4.3.

### 7.3 Settings

| Page | Key | admin | super_admin | manager today → after |
|---|---|---|---|---|
| `/admin/settings/invoicing` | `settings.invoicing` (SA) | ✗ | ✓ | GET readable → denied (D4) |
| `/admin/settings/renewals/schedules` | `settings.renewal_schedules` | ✓ | ✓ | page open → denied (D4) |
| `/admin/settings/broadcasts` | `settings.broadcasts` | ✓ | ✓ | page open → denied (D4) |
| `/admin/settings/integrations/eventcreate` | `settings.integrations` | ✓ | ✓ | page open → denied (D4) |

Settings index lists only permitted categories.

### 7.4 No `/admin/roles` (Phase 2)

## 8. Navigation & landing

- PR 2: nav/palette role reads swept behaviour-preservingly (§ 6.1 third
  surface). PR 4: declarative `requiredPermission` per item, server-side
  filtering; insights split; marketing E2E.
- Landing invariant: every staff bundle includes `dashboard.view` + ≥1
  widget permission (Domain test over the § 4.1 table).
- § 10 asserts: post-C super_admin sees a non-empty palette and the
  erasure-log nav entry.

## 9. Delivery plan

| Step | Content | Prod effect |
|---|---|---|
| PR 1 | Domain catalogue + bundles + flag-parameterised evaluator + D16 totalisation; `Role` ×5 + `roleEnum` tuple; Migration A + REQUIRED_ENUM_VALUES; role i18n; evaluator-level characterization (both legs, D16 rows) + CI job skeleton parameterised over the flag env | Dark |
| PR 2 | Helpers + shim table (per call-site class) + 4-pattern sweep (~175 sites incl. nav/palette machinery + the three `roles:` arrays) + plans deep-import + redaction re-keys (ON leg) + DoB/erasure keys + `permission_denied` + emitter sweep + actor_role widening; Migration B; run-migrations promotion-gate assertion (D7); `check:staff-page-guard` + API-matrix exhaustiveness + full page/API characterization; bootstrap/DR scripts; runbook | Flag OFF: byte-identical. Flag ON: new matrix + D4 |
| D18 + **Migration C** | Operator session: pre-mint super_admin → flip ON → verify (checklist incl. expected-denial baseline) → merge/deploy the migration-only promotion PR | All human admins → super_admin |
| PR 3 | Users-page retrofit completion (picker ×3, member lifecycle, finalFocus); E2E personas: **re-provision `E2E_ADMIN_*` as a FRESH plain admin** (post-C the old one is promoted — without this, admin-persona suites silently become super_admin sessions that bypass the evaluator); `E2E_SUPER_ADMIN_*` used only by users/audit/erasure/settings suites; personas seeded via the global-setup seed idiom; runbook coordinates dev-branch Migration C with the E2E changes | super_admin assignable |
| PR 4 | Declarative nav/palette; insights snapshot split + widget map; marketing assignable + `E2E_MARKETING_*` + marketing E2E; flag default → ON; observability + docs (ROPA, observability.md, tenant-onboarding) | Marketing usable end-to-end |
| PR 5 | Delete legacy leg/shim/façade/env read + Vercel env var; strict trigger | Cleanup |

No irreversible step: ADD VALUE is additive, promotion reversible by
demotion, flag guards the cutover. Every PR: TDD, ≥2-reviewer security
review (solo substitute), `enterprise-ux-designer` on UI PRs, full gates.

## 10. Testing

- **Characterization** (split per round-3): PR 1 = evaluator-level rows,
  both legs, incl. super_admin/marketing D16 rows, as a flag-parameterised
  CI job (`FEATURE_RBAC_V2` must NOT be force-set in `tests/setup.ts`).
  PR 2 = full page/API matrix joins the job. Legacy-leg expected cells from
  OBSERVED behaviour (anti-circularity, § 6.1). OFF-leg rows include the
  audit-viewer projection (admin full / manager redacted) and manager-DENIED
  on the admin-only API routes (§ 6.1 list).
- **Role × endpoint matrix**: table-driven; per-target-role rows for the
  users routes (§ 7.1); per-role F6 rows from guard behaviour (D9); an
  **expected-class column** (`role-matrix | public | cron-bearer |
  webhook-signature | portal-member`) instead of an exempt list.
  **Exhaustiveness test**: fs-walk `src/app/api/**/route.ts`; parser
  recognises `export async function METHOD`, `export const METHOD = <ident>`
  (alias, e.g. `GET = POST`), `export const METHOD = <call>`; ignores known
  Next.js config exports; **fails on any unclassified export**. (Verified:
  no `'use server'` actions exist, so pages + API routes are the complete
  authorization surface.)
- **Coverage**: evaluator stays flag-free in `src/modules/auth/domain/`
  (inherits the existing 100% blanket); the flag-reading helpers live in a
  named `src/lib` file with an explicit file-level 100%-branch
  `vitest.config.ts` entry and must NOT join the coverage-exclude list.
- **Integration (live Neon dev — mechanism pinned)**: rehearsals run as
  transaction-wrapped SQL with ROLLBACK on the shared dev branch, reducing
  the guarded population in-tx (never by stubbing the count helpers), and
  read Migration B/C statements from the actual `drizzle/migrations` files.
  Cases: trigger refuses demote/disable/delete/ERASE of the last guarded
  account; plain `UPDATE users SET last_sign_in_at = now()` succeeds; plain
  DELETE of a non-last user succeeds (0004 return-row regression);
  `isLastAdminTriggerError` fires (ERRCODE + substring); promotion
  correctness: every pre-C human admin promoted, **all three system actors**
  untouched, D18 pre-minted row untouched, no (user, invitation) coherence
  violation; reversed-order C-before-B asserts the abort.
- **E2E — three persona assertion lists**: plain admin (PR-3 era): 404 on
  `/admin/users`, `/admin/audit`, `/admin/settings/invoicing`, erasure log;
  erasure APIs denied. Manager (PR-2 flag-ON): 404 on `/admin/users` +
  `/admin/audit`; settings pages denied. Marketing (PR 4): 404 on
  `/admin/invoices`; invoice APIs 403; engagement-only dashboard. Plus:
  post-C super_admin non-empty palette + erasure-log nav entry; keyboard
  focus assertion (§ 7.1); a11y + i18n sweeps.
- **Gates**: `check:staff-page-guard` (+ the two named wiring edits),
  API-matrix exhaustiveness, architecture guard (authorization reads outside
  the allowlist — the palette/nav role filters ARE in scope),
  `check:audit-events`/`counts` (~6 registration places for
  `permission_denied`), `check:i18n`.

## 11. Observability & operations

- `rbac.permission_denied_total{role, permission}` + structured denial log.
  **Expected-denial baseline** (round-3 CC-4): derive the expected-denial
  signature list mechanically from the § 4.1 diff (role×key pairs newly
  denied to existing account classes — e.g. manager×audit.read); the
  wrong-mapping alert keys on denials OUTSIDE that list (and on expected
  pairs exceeding a per-actor sanity bound); during flag-ON verification,
  expected-pair denials are PASS evidence, any unexpected pair is the abort
  signal. Same baseline extends when marketing activates (PR 4). Aggregate
  per-actor so one noisy account is distinguishable from a broad mis-map.
- Runbook `docs/runbooks/rbac-v2-cutover.md`: D18 pre-mint step → flag flip
  + verification checklist → Migration C merge/deploy procedure (with the
  D7 gate assertion + `information_schema` trigger-body check) → promotion
  floor → per-window rollback incl. the marketing-availability note → PR-4
  env-var verification → PR-5 env-var deletion → bundle-change procedure →
  READ_ONLY_MODE note.
- `docs/runbooks/tenant-onboarding.md`: roles/bundles code-defined; no
  per-tenant seeding in Phase 1.

## 12. Compliance deliverables

- ROPA / privacy-doc update (staff role administration; marketing's member
  read access) — PR 4.
- Marketing minimisation: no `members.pii_sensitive`, no `directory.export`,
  redacted activity feed, denied on legacy leg (D16).
- Erasure `superAdminOnly`; SoD concentration accepted as Phase-1 residual
  (Phase-2 custom roles are the relief valve).

## 13. Phase 2 (deferred, design parked)

DB-driven store, `/admin/roles` editor, custom roles — v1 + its findings are
the starting point. Triggers: second paying tenant (requires F10
`user_tenants` first), OR bundle-change requests > ~1/month for a quarter,
OR contractual self-service requirement. Phase 1's keys/evaluator/call-sites
carry over; Phase 2 swaps the PermissionSet source and adds the editor.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cutover regression on live money | Flag-gated dual path; observed-behaviour characterization on both legs; matrix as review artefact; expected-denial baseline alert |
| Promotion rides the wrong deploy | D7 technical gate: migration absent from `main` until its own PR + run-migrations assertion exits 1 if flag ≠ 'true'; promotion floor for `vercel promote` |
| Trigger/guard population mismatch | UNION transitional guard; strict app guard (3 callers) from PR 2; strict DB guard in PR 5 |
| Lockout | Two-layer guard incl. erase pre-flight; evaluator bypass; D18 pre-mint; bootstrap refuses only when a super_admin exists |
| Page/route missed by sweep | `check:staff-page-guard` + API exhaustiveness fail the build |
| Silent denial for new roles | `permission_denied` all roles; per-role matrix rows |
| Shim widens/narrows a gate | Per-call-site-class shim rows + observed-behaviour characterization (anti-circularity) |
| In-flight invitations bricked | Migration C promotes open admin invitations atomically; coherence assertion |
| Migration silently not applied | Phase-3 `REQUIRED_ENUM_VALUES` assertion (primary) + runbook `information_schema` check (backstop) |
| F13 name collision | `platform_admin` reserved |

## 15. Review provenance & decisions taken in the round-3 fold

Three rounds: v1 154 findings (architecture descope) → v2 verification 24
(sequencing/lockout fixes, D7/D16-18) → round 3 48 (specification precision;
architecture confirmed sound). All folded. Round-3 clean-checks recorded by
the reviewers: no flag window is fail-open; Migration C exposes no
mixed-role state; D16's super_admin half is not an escalation; §5 mechanics
verified against the runner (autocommit enum pre-pass, journal comparison,
trigger WHEN-less shape, invitation columns, `users_role_status_idx`
suffices — no new indexes needed).

**⚑ Maintainer-visible decisions this fold took (veto before intake):**

1. **`events.relink` split from `events.write`** (admin + SA only) —
   marketing cannot move registration↔member linkage / benefit quota
   (money documents resolve buyers from it). Veto = give marketing relink.
2. **`directory.export` stays with manager** (behaviour-preserving; it is a
   read-class operation manager performs today). Veto = narrow it.
3. **`users.member_accounts` split** (admin + SA) so day-to-day admins keep
   member portal-account housekeeping while staff management stays SA-only.
   Veto = accept split-brain (all six routes SA-only).
4. **Marketing legacy-leg = DENY** (D16): emergency flag-OFF removes
   marketing access instead of granting manager-scope money reads.
   Veto = manager mapping + documented money-read leak during emergencies.
5. (Recorded, not new) Marketing self-approval of broadcasts is permitted —
   inherent in the D2 choice; flag if a submitter≠approver invariant is
   wanted instead.

## 16. Out of scope

- Phase 2 store/editor, custom roles, per-user overrides.
- Multiple roles per user; F13 platform console; member-portal changes.
