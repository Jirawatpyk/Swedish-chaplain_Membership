# RBAC Permission System — Design (v2, revision 2)

**Date**: 2026-08-10 (v1 → 154-finding adversarial review → v2 → 24-finding
verification round → this revision)
**Status**: Pending maintainer approval → Spec Kit intake
**Supersedes**: v1 (git `952b7f174`, DB-driven store + role editor — descoped) and
v2 rev 1 (git history). Review artefacts:
`2026-08-10-rbac-design-review-findings.md` (v1 review, 154 findings) + § 15 note
on the v2 verification round (24 findings, all folded in here).

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
| D1 | Super Admin is **tenant-level**. F13's platform console must NOT reuse the `super_admin` key (reserve `platform_admin`). Phase-1 caveat: `users.role` is a **global** column (users has no `tenant_id`), so role assignment is tenant-level only by virtue of single-tenant deployment; onboarding a second tenant REQUIRES the documented F10 `user_tenants` (per-tenant role) work before or with Phase 2. |
| D2 | Marketing = broadcasts full RW (compose, approve, send), events RW **excluding attendee-PII erasure** (D10), members/contacts **read-only without sensitive PII or exports** (D11), insights **engagement only**. |
| D3 | Super-Admin-exclusive (removed from `admin`): user + role assignment, invoice/tax settings (`/admin/settings/invoicing`), GDPR/PDPA erasure (member erasure, event-attendee erasure, erasure log), audit-log read. `admin` keeps day-to-day money operations (refund / void / credit note) and the operational settings pages (§ 7.3). |
| D4 | `manager` loses audit-log read and access to `/admin/users` + `/admin/audit` (both open to all staff today). **Timing**: these gates land in the PR-2 sweep and take effect at flag-ON — PR 3 does not re-gate them (verification G3). This is the only capability narrowing affecting a real production account class. |
| D5 | Architecture = Phase 1: catalogue + bundles as pure data in `src/modules/auth/domain/`. No new tables, no role editor. Changing a bundle or adding a role = code change + deploy. |
| D6 | No role editor UI. v1's editor design is parked for Phase 2. |
| D7 | **(REVISED — verification Critical G1)** Existing `admin` accounts are promoted to `super_admin` by a **separate migration-only deploy (Migration C)** executed only AFTER PR-2 code is serving in prod with `FEATURE_RBAC_V2` verified ON. The promotion must NOT ride the PR-2 deploy: during that build window the serving code is PR 1, whose ~175 inline role checks cannot evaluate `super_admin`, and the flag defaults OFF — promotion at that point locks every staff account out of the portal. Migration C also promotes **unconsumed admin invitations** (G2, § 5). |
| D8 | Evaluator cutover ships behind `FEATURE_RBAC_V2` (env, default false — repo ship-dark convention) with an explicitly staged lifecycle (§ 6.2): OFF-safe window → flag-ON verification → promotion → default flipped ON in code (PR 4) → legacy path deleted (PR 5). |
| D9 | Denial convention: pages `notFound()` (404), API routes 403 — EXCEPT the F6 `/api/admin/events/**` routes, which keep their documented 404 non-disclosure posture (route-local override, encoded as explicit expected-status rows in the § 10 matrix). |
| D10 | F6 event-attendee erasure and F3 member-erasure endpoints get explicit erasure permissions (`events.erasure`, `members.erasure`, both `superAdminOnly`) instead of riding generic write guards. |
| D11 | Date-of-birth (and any field gated today by a literal `role === 'admin'` minimisation check) moves to `members.pii_sensitive` (super_admin + admin). Marketing's directory read excludes it. |
| D12 | Denials audited for **every** role via new event type `permission_denied` (the manager-only `manager_denied_write` emit condition is superseded; the old type stays in the enum for historical rows). |
| D13 | The DB last-admin trigger is **rewritten, never dropped**. Transitional guard = the UNION population (`role IN ('admin','super_admin')`) so it is correct both before and after Migration C with no empty-set window; the strict super-admin-only guard lands in PR 5 once no plain-admin account can be the last holder. The strict invariant is enforced at the app layer (`countActiveSuperAdmins()`) from PR 2. |
| D14 | The role pgEnum **stays**. No `role_id`, no new tables, no column drop — v1's expand-contract outage class is descoped, and F10's `user_tenants` model stays unforeclosed. |
| D15 | Session shape unchanged (carries `role`). PermissionSet is derived synchronously from role via the code catalogue — no query, no carrier, no cache. |
| D16 | **(NEW — G1 belt-and-braces)** The legacy policy path is made **total over the widened Role type in PR 1**: `super_admin` evaluates with admin semantics, `marketing` with manager (read-only) semantics, at the single legacy entry point. Flag-OFF after promotion then degrades to today's admin behaviour instead of an empty permission set. |
| D17 | **(NEW — G6)** `marketing` becomes assignable only in **PR 4**, in the same PR as permission-aware nav + the insights split it depends on. PR 3's role picker offers super_admin/admin/manager; adding marketing later is a one-line change. No marketing account can exist before its surfaces are correct. |

## 3. Roles

| Role key | Portal | Summary |
|---|---|---|
| `super_admin` | staff | Everything (evaluator bypass — a catalogue gap can never lock out the top role). |
| `admin` | staff | Day-to-day ops: members CRUD, invoicing, payments, refunds, voids, credit notes, renewals, broadcasts, events, full insights, operational settings (§ 7.3). No user/role assignment, invoice/tax settings, erasure, audit read. |
| `manager` | staff | Read-only on business surfaces, minus audit read and the users page (D4). Self-service writes only. |
| `marketing` | staff | Exactly the keys marked ✓ in the § 4.1 table: broadcasts (all three keys), events read/write, members.read, contacts.read, insights.engagement, dashboard.view. |
| `member` | member | Self-service, unchanged from F1/F3/F7. |

Role display names: 5 × EN/TH/SV keys (no per-permission labels — no editor UI).

## 4. Permission model

### 4.1 Catalogue + bundles in code (Domain)

Two pure-data modules in `src/modules/auth/domain/`:
`permission-catalogue.ts` (keys + flags) and `role-bundles.ts`
(`ROLE_BUNDLES: Record<Role, ReadonlySet<PermissionKey>>`; super_admin
bypasses; member's bundle encodes the existing self-service matrix).

**Key naming**: `<module>.<action>` with a DOT separator — deliberately
distinct from the existing colon-namespaced `Resource` union
(`members:bulk`, `auth:self`), which coexists during migration.

**Committed minimum catalogue** (verification G11 — the table below is the
pinned baseline; `/speckit.plan` may ADD keys from the route inventory,
never rename or repurpose these). SA-only = `superAdminOnly`.

| Key | Flags | super_admin | admin | manager | marketing |
|---|---|---|---|---|---|
| `dashboard.view` | | ✓ | ✓ | ✓ | ✓ |
| `members.read` | | ✓ | ✓ | ✓ | ✓ |
| `members.write` | pii | ✓ | ✓ | | |
| `members.bulk` | pii | ✓ | ✓ | | |
| `members.pii_sensitive` | pii | ✓ | ✓ | | |
| `members.erasure` | SA-only, pii | ✓ | | | |
| `members.erasure_log_read` | SA-only, pii | ✓ | | | |
| `contacts.read` | | ✓ | ✓ | ✓ | ✓ |
| `contacts.write` | pii | ✓ | ✓ | | |
| `directory.export` | pii | ✓ | ✓ | | |
| `plans.read` | | ✓ | ✓ | ✓ | |
| `plans.write` / `plans.clone` | | ✓ | ✓ | | |
| `invoicing.read` | | ✓ | ✓ | ✓ | |
| `invoicing.write` | money | ✓ | ✓ | | |
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
| `events.erasure` | SA-only, pii | ✓ | | | |
| `insights.engagement` | | ✓ | ✓ | ✓ | ✓ |
| `insights.finance` | money | ✓ | ✓ | ✓ | |
| `insights.activity_unredacted` | pii | ✓ | ✓ | | |
| `users.manage` | SA-only | ✓ | | | |
| `audit.read` | SA-only | ✓ | | | |
| `settings.invoicing` | SA-only, money | ✓ | | | |
| `settings.renewal_schedules` | | ✓ | ✓ | | |
| `settings.broadcasts` | | ✓ | ✓ | | |
| `settings.integrations` | | ✓ | ✓ | | |

Granularity principle (review `money-invoice-write-too-coarse`): **one key per
irreversible document/money action** — hence write/void/receipt as separate
invoicing keys.

### 4.2 Enforcement flags

- `superAdminOnly` — the **evaluator itself** refuses these keys for any role
  other than `super_admin`, regardless of bundle content; a Domain unit test
  additionally asserts no bundle contains one.
- `sensitive: 'money' | 'pii'` — drives the `/speckit.review` checklist when a
  bundle diff touches a flagged key; no runtime behaviour in Phase 1.

### 4.3 Insights + audit-content splits

- `insights.engagement` vs `insights.finance`: the F9 dashboard is one large
  server component over a single cached snapshot with finance and engagement
  interleaved, so the split is real work (PR 4): split the snapshot loader
  into separately cacheable finance/engagement parts; widget→permission map;
  a grid that collapses gracefully (no half-empty fixed layouts, no dead
  links).
- **Activity feed** redaction re-keys from the literal `'manager'` to
  `insights.activity_unredacted`.
- **Audit viewer** (verification `audit-viewer-redaction-inversion`): the
  `/admin/audit` redaction path types its viewer as
  `AuditViewerRole = 'admin' | 'manager'` and returns full content only for
  the literal `'admin'` — after D3+D7 the only viewer is `super_admin`, which
  a lazy coercion would land on the REDACTED branch (the sole audit-capable
  role seeing LESS than admin does today on the 10-year money-forensics
  surface). PR-2 scope: re-key viewer redaction to a permission decision
  (`audit.read` holder ⇒ unredacted projection; anything else defaults
  redacted); do NOT widen `AuditViewerRole` to string; contract test asserts
  a super_admin viewing `refund_initiated` receives the full payload
  including `reason`.

## 5. Data changes (additive only — no column is ever dropped)

```
Migration A (PR 1):  ALTER TYPE role ADD VALUE 'super_admin'; ADD VALUE 'marketing';
                     -- shared by users.role and invitations.intended_role.
                     -- No row holds the new values until Migration C.

Migration B (PR 2):  1) ALTER TYPE audit_event_type ADD VALUE 'permission_denied';
                     2) CREATE OR REPLACE FUNCTION users_last_admin_guard():
                        transitional UNION guard — refuses leaving zero active
                        users with role IN ('admin','super_admin') (D13).
                        MUST keep ERRCODE 23514 **and** the literal
                        'last-admin-protection' message substring — the
                        isLastAdminTriggerError() detector matches BOTH, and
                        three consumers depend on it (verification FC-4).

Migration C (own migration-only deploy, AFTER flag-ON verified in prod — D7):
                     BEGIN-atomic:
                     UPDATE users       SET role='super_admin'
                       WHERE role='admin'
                         AND id NOT IN (<the reserved system-actor ids>);
                     UPDATE invitations SET intended_role='super_admin'
                       WHERE intended_role='admin' AND <unconsumed/unexpired
                       predicate per the invitations schema>;
                     -- Promoting users AND their open invitations together keeps
                     -- redeem-invite's tamper check (user.role must equal
                     -- invitation.intendedRole) coherent — otherwise every
                     -- in-flight admin invitation becomes unredeemable (G2).
                     -- System actors are excluded by their fixed ids and keep
                     -- their current role.

PR 5 (cleanup):      CREATE OR REPLACE users_last_admin_guard() — strict
                     super-admin-only population (D13 final state).
```

Discipline notes:

- Hand-written SQL + `_journal.json`; each new `when` must **exceed the
  current global max** (the migrator compares against the latest applied
  timestamp, not per-file identity).
- Separate deploys A→B→C are required by the **old-code-serving sequencing**
  (D7): no deployment that can observe a `super_admin` row may predate the
  code that handles it. (Postgres's "new enum value unusable in the adding
  transaction" rule is independently satisfied by the migration runner's
  existing autocommit enum pre-pass — verification FC-7 — so the deploy split
  is about serving code, not about the enum rule.)
- Migration order B-before-C is load-bearing: C's promotion must run under
  the UNION guard. Journal ordering guarantees it; the runbook's post-migrate
  verification (§ 11) checks the trigger body before C is run.
- App-layer twin: `countActiveAdmins()` (callers: `change-role.ts`,
  `disable-user.ts`) becomes `countActiveSuperAdmins()` in PR 2, enforcing
  the strict invariant at the app layer from day one.
- `scripts/seed-bootstrap-admin.ts` + DR/system-actor seed scripts that
  reference role literals are updated in PR 2 (bootstrap creates/refuses on
  `super_admin`).

## 6. Enforcement

### 6.1 Evaluation path

```
requireSession(portal)          (unchanged)
  → getPermissionSet(role)      (pure Domain function)
  → hasPermission(set, key)     (super_admin bypass + superAdminOnly refusal)
```

No DB read, no cache, no request-context carrier (D15).

**Helpers** (verification G5 — pinned so two implementers build the same
thing): TWO thin wrappers over ONE evaluator —
`requirePagePermission(key)` → on denial: emit `permission_denied` audit →
`notFound()`; `requireApiPermission(key)` → on denial: emit → typed 403
result (mirroring the existing rbac-guard result shape). The
`FEATURE_RBAC_V2` branch lives **inside the evaluator only**; every call site
is rewritten once, unconditionally, to the new helpers. The legacy leg of the
evaluator maps each key through the **compatibility shim table** — an
explicit, reviewable table of rows `key → mappedLegacy(resource, action) |
legacySessionOnly` (where `legacySessionOnly` covers the 17 currently
ungated pages and every `superAdminOnly` key, preserving today's behaviour
while OFF). The `canAccess` façade delegates to the same flag-branched
evaluator. Per D16 the legacy leg first normalises `super_admin`→admin,
`marketing`→manager semantics.

**Call-site inventory** (verification FC-2/FC-6 — real numbers): ~175 raw
role-string comparisons across ~120 files, plus three coercion classes that
must each be swept: 4 escalate-to-admin ternaries
(`role === 'manager' ? 'manager' : 'admin'` — silently escalate any new role
to admin), 4 demote-direction ternaries (3 → manager, 1 → member), and ~12
`as 'admin' | 'manager'`-style casts (fail later at enum validation). The
PR-2 sweep checklist greps all three patterns; the shim table doubles as the
review artefact for the rewrite.

**Positive gates**: every `(staff)` page gets `requirePagePermission`
(17 pages today have no role gate beyond `requireSession('staff')`); API
routes migrate from `requireRole(resource, action)` to
`requireApiPermission(key)` via the shim table. Denial statuses per D9
(incl. the F6 404 override).

**Application layer**: deny-lists (`actorRole === 'member'`) and coercions
are rewritten to explicit permission decisions. This conversion is the core
security deliverable.

**Legitimate role reads remain** (identity, not authorization): portal
routing, sign-in, invitation issuance, seeds/scripts, audit `actor_role`
stamping. The architecture guard targets authorization reads outside this
explicit allowlist.

**Audit emitters** (verification FC-3): the sweep covers ALL emitters that
coerce/misattribute unknown roles (≥6 sites incl. the offline-settlement
emitter recording `'member'` and the tax-document emitter recording
`'admin'`) — not just those two. Audit payloads typing
`actor_role: 'admin' | 'manager'` (F9 `dashboard_viewed` et al.) widen to
the full staff-role union.

**Plans module** (verification FC-5): `src/modules/plans` consumes the
evaluator via a **deep import of the pure Domain module** (mirroring the
existing `import type { Role } from '@/modules/auth/domain/role'`
precedent), NOT auth's public barrel — the barrel pulls the argon2
infrastructure into client bundles, which is the exact build break
documented in `plans/domain/policies.ts`. Needs a matching carve-out in the
Principle III `no-restricted-imports` rule.

### 6.2 Flag lifecycle (verification G1/G4 — stated per window)

| Window | Flag OFF means | Flag ON means |
|---|---|---|
| PR 2 deployed → Migration C | Legacy behaviour, byte-identical (no row holds a new role; shim preserves today's outcomes incl. the 17 ungated pages) | New matrix for existing roles; D4 narrowing active; **prerequisite for running Migration C** |
| Migration C → PR 4 | Degraded-safe: promoted accounts evaluate with admin semantics via D16 normalisation (pre-D4 behaviour returns) | New matrix |
| PR 4 → PR 5 | Env override retained for emergency only — **code default flips to ON in PR 4** (this is what "retiring" the flag means; the env var is not deleted while the branch exists) | (default) |
| PR 5 | Legacy leg + shim + `canAccess` façade + env read deleted | — |

Rollback story: before Migration C, flag OFF is a true rollback. After C,
flag OFF is a safe degrade (D16), and account-level rollback = demotion via
`/admin/users`. Both procedures live in the runbook.

### 6.3 Safety invariants (each with tests)

1. Last-super-admin: app layer strict (`countActiveSuperAdmins()`) + DB
   transitional UNION trigger (D13) covering demote, disable, delete,
   erasure. Residual (documented): between C and PR 5 a race could demote
   the last super_admin while plain admins exist — recoverable via
   `seed-bootstrap-admin` (refuses only when a super_admin exists).
2. `superAdminOnly` refused by the evaluator + Domain test that no bundle
   contains one.
3. Every staff page positively gated — `check:staff-page-guard` static gate
   (fails any `(staff)/**/page.tsx` whose only guard is `requireSession`),
   wired into pre-push + CI.
4. Denials audited for all roles via `permission_denied` with the actor's
   REAL role.
5. Audit-viewer redaction keyed to permission, never to a role literal
   (§ 4.3).

## 7. Surfaces

### 7.1 `/admin/users` — RETROFIT (already live, open to all staff today)

The page ships today (staff directory, filters, invite dialog + role picker,
change-role, disable/enable, invitation resend/revoke, pagination) gated only
by `requireSession('staff')`. Work split:

- **PR 2** (part of the sweep): page + **every mutating API route on the
  users surface — six today, enumerated in the § 10 matrix** (verification
  FC-1: invite, resend, revoke, change-role, disable, enable) gated behind
  `users.manage`. Effective at flag-ON (D4).
- **PR 3**: role picker offers super_admin/admin/manager (marketing in PR 4,
  D17); **member-account lifecycle stays** (view, invite, resend, revoke,
  disable member portal accounts — the picker never offers member ↔ staff
  conversion); E2E seeds + suite remap; **dialog focus** (verification
  `dialog-final-focus-omitted`): every dialog on this page passes an explicit
  `finalFocus` targeting a node that survives the action (repo
  `useDialogFinalFocus` pattern), INCLUDING fixing the pre-existing omission
  in `user-list-table.tsx`; keyboard E2E asserts `document.activeElement !==
  body` after a row action (the axe sweep cannot catch this).
- Existing audit events unchanged; role changes keep `role_changed`.

### 7.2 `/admin/audit`

Also live and staff-wide today; gated behind `audit.read` in the **PR-2
sweep** (D4 timing), plus the § 4.3 viewer-redaction re-key.

### 7.3 Settings — split by page

| Page | Key | admin | super_admin |
|---|---|---|---|
| `/admin/settings/invoicing` | `settings.invoicing` (SA-only) | ✗ | ✓ |
| `/admin/settings/renewals/schedules` | `settings.renewal_schedules` | ✓ | ✓ |
| `/admin/settings/broadcasts` | `settings.broadcasts` | ✓ | ✓ |
| `/admin/settings/integrations/eventcreate` | `settings.integrations` | ✓ | ✓ |

The settings index lists only categories the actor can open.

### 7.4 No `/admin/roles` (Phase 2, § 13)

## 8. Navigation & landing

- Sidebar config + command-palette registry declare `requiredPermission` per
  item; server-side filtering from the derived set (PR 4). **PR 3 interim**
  (verification G6): the Users/Audit nav items get a targeted permission
  check in PR 3 so managers don't see dead links post-narrowing; the general
  mechanism replaces it in PR 4.
- Landing invariant: every staff bundle includes `dashboard.view` + ≥1
  widget permission (provable by a Domain test over the § 4.1 table), so
  `/admin` after sign-in is never empty or forbidden.
- Marketing sees: Dashboard (engagement), Members (read), Broadcasts,
  Events. Admin no longer sees: Users, Audit, Erasure log, Invoice settings.

## 9. Delivery plan

| Step | Content | Prod effect |
|---|---|---|
| PR 1 | Domain catalogue + bundles + evaluator (+tests), `Role` ×5, D16 legacy-leg totalisation, portal map, role i18n; Migration A; characterization suite (incl. legacy-path rows for super_admin/marketing) | Dark. No row holds new values; legacy path total over 5 roles |
| PR 2 | Evaluator cutover behind flag: helpers + shim table + call-site sweep (~175 sites, 3 coercion classes, deny-lists, plans deep-import, insights/audit-viewer redaction re-keys, DoB permission, erasure permissions, `permission_denied` + emitter sweep, actor_role widening); Migration B (audit enum + UNION trigger rewrite); `check:staff-page-guard`; bootstrap/DR scripts; runbook | Flag OFF: byte-identical legacy. Flag ON: new matrix; D4 narrowing |
| **Migration C** | Migration-only deploy: promotion (users + open invitations, system actors excluded) — **operator-gated, only after flag-ON verified in prod** | All human admins become super_admin (capability-preserving) |
| PR 3 | `/admin/users` retrofit completion: picker ×3 roles, member lifecycle, finalFocus fixes, E2E seeds (`E2E_SUPER_ADMIN_*`) + suite remap; targeted nav check for Users/Audit | super_admin assignable; managers stop seeing dead links |
| PR 4 | Permission-aware nav + palette; insights snapshot split + widget map; **marketing assignable** (D17) + `E2E_MARKETING_*` + marketing E2E; flag default flips ON in code; observability + docs (ROPA, observability.md, tenant-onboarding note) | Marketing usable end-to-end |
| PR 5 | Delete legacy leg + shim + `canAccess` façade + env read; strict super-admin-only trigger | Dead code removal; final trigger |

No irreversible step exists: ADD VALUE is additive, the promotion is
reversible by demotion, the flag guards the cutover. Every PR: TDD,
≥2-reviewer security review (solo-maintainer substitute),
`enterprise-ux-designer` pass on UI PRs, full gates incl. live-Neon
integration.

## 10. Testing

- **Characterization first** (harness pinned per verification G7): page rows
  are asserted via each page's declared required-permission (unit-level
  table) with `check:staff-page-guard`'s filesystem walk guaranteeing
  completeness; API rows run in the existing contract harness; enumeration =
  filesystem glob over `(staff)/**/page.tsx` + `src/app/api/**/route.ts`,
  failing on unknown routes; the suite is parameterised over the flag env
  and runs BOTH legs as a CI job added in PR 1. Input roles include
  super_admin and marketing on the legacy leg (D16 mapping asserted).
- **Table-driven role × endpoint matrix**: one data table (route, method,
  key, expected per role — incl. the F6 404-override rows) driving one
  parameterised contract test; the table doubles as the shim/migration
  review artefact. **Completeness is mechanical** (verification
  `api-route-matrix-no-completeness-guard`): a unit test fs-walks
  `src/app/api/**/route.ts`, parses exported handlers, and FAILS if any
  handler lacks a matrix row.
- **Domain 100% line**; evaluator + bundles on the security-critical
  **100%-branch** list in `vitest.config.ts`.
- **Integration (live Neon dev)**: Migration A+B+C rehearsal — trigger still
  blocks demote/disable/delete/erase of the last guarded account AND a plain
  `UPDATE users SET last_sign_in_at = now()` succeeds; `isLastAdminTriggerError`
  fires (ERRCODE + message substring, FC-4); promotion correctness: every
  pre-C human admin is post-C super_admin, system actors untouched, and **no
  (user, invitation) pair violates `user.role = invitation.intendedRole`**
  (G2); reversed-order B/C rehearsal asserts the abort (G9-class).
- **E2E**: seeds + env `E2E_SUPER_ADMIN_*` (PR 3), `E2E_MARKETING_*` (PR 4);
  admin-persona suites exercising user management remap to the super-admin
  session; a NEW plain-admin account asserts the narrowed matrix
  (marketing → 404 on `/admin/invoices`, invoice APIs → 403; manager → 404
  on `/admin/users` + `/admin/audit`); keyboard focus assertion (§ 7.1);
  a11y + i18n sweeps.
- **Stubs**: session shape unchanged (D15) so the ~188 role-literal fakes
  stay valid; suites asserting narrowed behaviour change deliberately. The
  `permission_denied` event registers in all ~6 places (domain const, pgEnum
  migration, 2 test counts, EN/TH/SV labels) — `check:audit-events` /
  `check:audit-counts` gate it.
- **Gates**: `check:staff-page-guard` (new), API-matrix exhaustiveness test
  (new), architecture guard on the authorization-read allowlist,
  `check:i18n`, existing pre-push suite.

## 11. Observability & operations

- Counter `rbac.permission_denied_total{role, permission}` (bounded: 5 × fixed
  catalogue) + structured log per denial; alert on denial-rate spike after
  flag-ON (the canary for a wrong mapping). Documented in
  `docs/observability.md`.
- Runbook `docs/runbooks/rbac-v2-cutover.md`: flag flip + verification
  procedure; **Migration C operator procedure** (pre-check: flag ON in prod,
  trigger body verified via `information_schema` per the silent-no-op
  hazard); per-window rollback (§ 6.2 table); bundle-change procedure (code
  diff + matrix diff); READ_ONLY_MODE note (bundle recovery is a deploy, not
  a UI write).
- `docs/runbooks/tenant-onboarding.md`: one line — roles/bundles are
  code-defined; no per-tenant seeding in Phase 1.

## 12. Compliance deliverables

- ROPA / privacy-doc update (new processing activity: staff role
  administration; marketing's read access to member data) — PR 4.
- Marketing minimisation: no `members.pii_sensitive`, no `directory.export`,
  redacted activity feed.
- Erasure endpoints carry `superAdminOnly` permissions (D10). The
  segregation-of-duties concentration (the only role that can erase is the
  only role that can read the audit of it) is ACCEPTED for Phase 1 as a
  documented residual: TSCC's super_admins are the organisation's
  principals; Phase 2 custom roles (e.g. read-only auditor) are the relief
  valve.

## 13. Phase 2 (deferred, design parked)

DB-driven store, `/admin/roles` editor, custom roles, per-tenant seeding,
parity gates — v1 (git history) + its review findings are the starting
point. **Trigger conditions**: a second paying tenant onboards (which FIRST
requires the F10 `user_tenants` per-tenant-role work, D1), OR bundle-change
requests exceed ~1/month for a quarter, OR a tenant contractually requires
self-service role management. Phase 1's keys, evaluator API, and call-site
conversions carry over — Phase 2 swaps the PermissionSet source and adds the
editor; it does not re-touch call sites.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cutover regression on live money | Flag-gated dual path; characterization on both legs incl. new-role rows; matrix as review artefact; denial-spike alert |
| Promotion under wrong conditions | Migration C is operator-gated with runbook pre-checks (flag ON verified, trigger body verified); D16 makes even a mistaken flag-OFF state degrade safely |
| Trigger/guard population mismatch | UNION transitional guard (D13) — correct in every window; strict guard only in PR 5; app layer strict from PR 2 |
| Lockout | Two-layer guard; evaluator bypass; bootstrap script refuses only when a super_admin exists |
| A page or API route missed by the sweep | `check:staff-page-guard` + API-matrix exhaustiveness test fail the build |
| Silent denial for new roles | `permission_denied` for all roles; per-role denial rows in the matrix |
| In-flight invitations bricked or silently downgraded | Migration C promotes open admin invitations atomically with users; integration assertion on the (user, invitation) coherence |
| Migration silently not applied | `when` > global max + runbook `information_schema` verification before Migration C |
| F13 name collision | `super_admin` documented tenant-scoped; `platform_admin` reserved |

## 15. Review-findings resolution map

v1's five critical root causes: (1) trigger-breaks-on-drop → no drop (D14);
surviving guard-population half → D13 UNION design. (2) contract-migration
window → no contract migration (D14). (3) session-path RLS bypass → no DB
read (D15). (4) staff pages fail open → § 6.1 positive gates + coercion
sweep + static gates, all landing before any account can hold a new role
(D7/D17 sequencing). (5) write-time-only superAdminOnly → evaluator-level
refusal (§ 4.2).

**v2 verification round** (3 agents, 24 findings — all folded in): Critical
G1 flag-OFF-promotion-lockout → D7 (Migration C decoupled + operator-gated)
+ D16 (legacy totalisation) + § 6.2 lifecycle table; G2 invitations → § 5
Migration C + § 10 assertion; G3 narrowing timing → D4/§ 7.1/§ 7.2 unified
on PR 2; G4 flag retirement → § 6.2 table (default flip in PR 4); G5 helper
ambiguity → § 6.1 pinned; G6 PR3→PR4 dependency → D17 + § 8 interim; G7
characterization harness → § 10 pinned; G8 audit-enum migration → Migration
B; G9 ordering → § 5 discipline note + § 10 rehearsal; G10 tenant-level
caveat → D1; G11 catalogue pinning → § 4.1 table; FC-1 six routes → § 7.1;
FC-2/FC-6 real counts → § 6.1; FC-3 emitter sweep → § 6.1; FC-4 error
detection contract → § 5; FC-5 plans deep-import → § 6.1; FC-7 enum-rule
mechanism → § 5; audit-viewer inversion → § 4.3; dialog focus → § 7.1; F6
404 posture → D9; API-matrix completeness → § 10.

## 16. Out of scope

- Phase 2 store/editor, custom roles, per-user overrides.
- Multiple roles per user (1 user = 1 role stands).
- F13 platform console.
- Any change to member-portal capabilities.
