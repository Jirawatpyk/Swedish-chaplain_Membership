# RBAC Permission System — Design

**Date**: 2026-08-10
**Status**: Approved by maintainer (brainstorming session); pending Spec Kit intake
**Supersedes**: the fixed three-role matrix in `src/modules/auth/domain/policies.ts` (F1 Q4)

## 1. Goal

Replace the hardcoded three-role RBAC (`admin` / `manager` / `member`) with a
**DB-driven permission system**: five system roles plus tenant-scoped custom
roles, a permission catalogue defined in code, per-role permission sets stored
in Postgres, and two new Super Admin surfaces (`/admin/users`, `/admin/roles`).

Business drivers (TSCC, first tenant):

- The organisation needs a **Super Admin** (top tenant role) separate from
  day-to-day **Admin** staff.
- A **Marketing** staff role must operate E-Blast and events without access to
  money, member mutation, or compliance surfaces.
- Staff/role management must move from scripts to a UI.
- Navigation must reflect what the signed-in role can actually do.

## 2. Decisions locked during brainstorming

| # | Decision |
|---|----------|
| D1 | Super Admin is **tenant-level** (not the F13 platform console; F13 remains a separate future feature and must NOT reuse the `super_admin` role key — reserve e.g. `platform_admin`). |
| D2 | Marketing = broadcasts full RW (compose, approve, send), events full RW, members **read-only**, insights **engagement only** (no finance figures). |
| D3 | Super-Admin-exclusive capabilities (removed from `admin`): user + role management, tenant settings (invoice/payment/fee config/tenant flags), GDPR/PDPA erasure, audit log read. `admin` keeps all day-to-day money operations **including refund / void / credit note**. |
| D4 | `manager` loses audit-log read (least privilege; recoverable via custom role). Otherwise unchanged (read-only). |
| D5 | Architecture = **DB-driven permission sets + role editor UI** (approach B, phase 2 depth) — chosen over code-only bundles. |
| D6 | System roles `admin`, `manager`, `marketing` are **directly editable** by Super Admin, with a **Reset to default** action. `super_admin` and `member` are immutable. No system role can be deleted or key-renamed. |
| D7 | Existing `admin` accounts are **promoted to `super_admin`** at migration (capability-preserving; demote later via UI). |
| D8 | Scope split into 5 PRs (see § 9); feature flows through the Spec Kit gates. |

## 3. Roles

| Role key | Portal | is_system | Editable | Summary |
|---|---|---|---|---|
| `super_admin` | staff | yes | **no** (code bypass) | Everything, including users, roles, tenant settings, erasure, audit. |
| `admin` | staff | yes | yes | Day-to-day operations: members CRUD, invoicing, payments, refunds, voids, credit notes, renewals, broadcasts, events, full insights. **No** user/role management, tenant settings, erasure, audit. |
| `manager` | staff | yes | yes | Read-only on business surfaces. No audit read. Self-service writes only. |
| `marketing` | staff | yes | yes | `broadcast:*`, `events:*`, `members:read`, `contacts:read`, `insights:engagement`, staff dashboard read. Nothing else. |
| `member` | member | yes | **no** | Self-service (unchanged from F1/F3/F7: own profile, own contacts, own broadcasts, member portal). |
| *custom* | staff | no | yes | Created by Super Admin; any grantable permission set. |

`super_admin` is enforced as a **code-level bypass** (`is_system && key ===
'super_admin'` → `hasPermission` returns true), never via `role_permissions`
rows. This prevents self-lockout when new permissions ship without a seed
update.

## 4. Permission model

### 4.1 Catalogue lives in code (Domain)

`src/modules/auth/domain/permission-catalogue.ts` is the single source of
truth: permission key, module group, and flags. The DB stores only
**assignments** (role → permission). A `check:permission-parity` gate keeps
`role_permissions.permission_key` ⊆ catalogue keys.

Key naming: `<resource>:<action>` aligned with the existing
`Resource`/`Action` unions — e.g. `members:read`, `members:write`,
`members:bulk`, `invoice:write`, `refund:write`, `broadcast:write`,
`events:write`, `insights:engagement`, `insights:finance`, `plan:write`,
`plan:clone`.

### 4.2 Permission flags

- `superAdminOnly` — cannot be granted to ANY other role (UI and API refuse).
  Applies to: `users:manage`, `roles:manage`, `audit:read`, `erasure:*`,
  `tenant_settings:*` (invoice settings, payment settings, fee config, tenant
  flags). This both encodes D3 and closes privilege escalation (no role can
  grant itself more rights).
- `sensitive: 'money' | 'pii'` — role editor shows a warning badge and a
  confirmation dialog when granting (e.g. `refund:write`, `invoice:write`,
  `members:write`, `members:bulk`).

### 4.3 Insights split

`insights:read` splits into `insights:engagement` (benefit usage, engagement,
timeline) and `insights:finance` (revenue KPIs, AR aging, collection). The F9
dashboard renders sections per permission. Marketing gets engagement only.

## 5. Data model (3 new tables + 2 column migrations)

```
permissions            -- global catalogue mirror (NOT tenant-scoped)
  key TEXT PK, module TEXT, super_admin_only BOOL, sensitive TEXT NULL
  -- seeded from code; read-only at runtime

roles                  -- tenant-scoped, RLS + FORCE
  id UUID PK, tenant_id, key TEXT, name JSONB (i18n), portal ('staff'|'member'),
  is_system BOOL, permissions_updated_at, created_at, ...
  UNIQUE (tenant_id, key)

role_permissions       -- tenant-scoped via roles FK, RLS + FORCE
  role_id UUID FK → roles, permission_key TEXT FK → permissions
  PK (role_id, permission_key)

users.role_id          -- new FK → roles(id); backfilled from role enum
invitations.intended_role_id -- same treatment
```

Expand-contract (Vercel runs migrations at build while the old deployment
still serves traffic):

1. **Expand migration(s)**: create tables + RLS policies, seed catalogue +
   5 system roles per tenant + default `role_permissions`, add nullable
   `users.role_id` / `invitations.intended_role_id`, backfill
   (`admin` → **`super_admin`** per D7; others map 1:1).
2. New code reads `role_id` with a temporary enum fallback.
3. **Contract migration** (PR 5): make `role_id` NOT NULL, drop the `role`
   pgEnum columns.

All repo access to tenant-scoped tables threads `tx` from `runInTenant`
(never the global `db` singleton — F7.1a incident class). Migrations are
hand-written SQL registered in `meta/_journal.json` (0019+ convention);
`when` timestamps must not collide.

## 6. Enforcement

### 6.1 Request path

```
request → session lookup (existing single query)
        → JOIN roles + role_permissions in that same query
        → PermissionSet on request context
        → hasPermission(set, key) in Domain
```

- **No cache layer initially.** The join adds no extra roundtrip and the
  tables are tiny; edits in the role editor take effect on the next request
  with no session invalidation. Add caching later only if p95 budgets demand
  it (Perf principle: measure first).
- `canAccess(role, resource, action)` is reimplemented on top of the
  permission set; call sites migrate from role checks to permission checks.
  After PR 2 **no call site reads the role enum directly** — enforced by an
  architecture test (`tests/unit/architecture/`).
- `rbac-guard.ts` maps route → required permission and keeps emitting audit
  events on denial (existing `role_violation_blocked` taxonomy; the
  `manager_denied_write` event stays for backward compatibility of the audit
  trail).
- UI: server components receive the PermissionSet and conditionally render;
  nav config declares `requiredPermission` per item (see § 8).

### 6.2 Safety invariants (Domain-enforced, each with tests)

1. `super_admin` + `member` permission sets immutable; system roles cannot be
   deleted or key-renamed.
2. `superAdminOnly` permissions are ungrantable to any non-`super_admin` role
   (API-level refusal, not just UI).
3. **Last-super-admin protection**: cannot demote, disable, or delete the last
   active `super_admin` in a tenant.
4. Cannot delete a role with assigned users.
5. Custom roles are always `portal = 'staff'`; the `member` role is not
   assignable from the staff users page.
6. Role/permission mutations run inside `runInTenant`; guard checks precede
   the first write (refusal-after-write commits — known footgun).

## 7. New surfaces

### `/admin/users` — requires `users:manage`

- Staff directory: name, email, role badge, status, last sign-in.
- Invite staff (role picker → extends F1 invitation flow with
  `intended_role_id`), change role, disable/enable.
- Every action audited: reuse the existing F1 invitation + `role_changed`
  event types; no new event types needed on this page.

### `/admin/roles` — requires `roles:manage`

- Role list: 5 system + custom, with assigned-user counts.
- Editor: permission checkboxes grouped by module (Members / Invoicing /
  Payments / Broadcasts / Events / Insights / Plans / Settings), sensitive
  badges + confirm dialogs, **Reset to default** for system roles.
- Create custom role; delete (blocked while users assigned).
- New audit event types (added in all 4 places: domain const, pgEnum, 2 test
  counts): `role_created`, `role_updated`, `role_deleted`,
  `role_permissions_reset`.

Both pages: EN/TH/SV i18n, WCAG 2.1 AA, `docs/ux-standards.md` § 15 checklist,
shimmer skeletons, `enterprise-ux-designer` review pass.

## 8. Role-aware navigation

- Sidebar (`src/config/` nav) + command palette registry: every entry declares
  a required permission; filtering happens server-side from the real
  PermissionSet. No hardcoded role names in nav code.
- Marketing sees: Dashboard (engagement), Members (read), Broadcasts, Events.
- Admin no longer sees: Users, Roles, Settings, Audit, Erasure log.

## 9. Delivery plan — 5 PRs through Spec Kit

| PR | Content | Prod effect |
|---|---|---|
| 1 | Tables + RLS + seed + backfill + Domain permission engine + catalogue | Dark (nothing reads it) |
| 2 | Enforcement cutover: session join, policies/rbac-guard/call-site migration | Behaviour-identical (admins are now super_admins) |
| 3 | `/admin/users` | New page |
| 4 | `/admin/roles` editor | New page |
| 5 | Permission-driven nav + command palette + insights split + enum drop (contract migration) | Marketing role usable end-to-end |

Each PR: TDD (red → green), integration tests on live Neon `dev` branch,
**mandatory cross-tenant probe test** on the new tables (Constitution
Principle I), ≥2-reviewer security review (RBAC surface) with the
solo-maintainer substitute where applicable.

## 10. Testing

- **Domain 100% line**: permission evaluator, all § 6.2 invariants,
  catalogue integrity (no duplicate keys, flags well-formed).
- **Contract**: users API + roles API, every endpoint × role matrix.
- **Integration (live Neon)**: RLS cross-tenant probes on `roles` /
  `role_permissions`, backfill correctness (enum → role_id, admin →
  super_admin), escalation-guard round-trips, last-super-admin guard.
- **E2E (Playwright + axe)**: per-role nav visibility; marketing → 403 on
  `/admin/invoices`; admin → 403 on `/admin/users`; role edit takes effect
  without re-login; a11y + i18n sweeps.
- **Architecture guards**: no direct role-enum reads post-PR-2;
  `check:permission-parity` gate.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Security regression during live launch | 5-PR staging, PR 2 is behaviour-identical by construction; full role-matrix contract suite before cutover |
| Misconfigured system role locks out money ops | Reset-to-default; sensitive-permission confirm dialogs; audit trail on every role edit |
| Privilege escalation via role editor | `superAdminOnly` flag enforced at API layer; invariant tests |
| Tenant lockout | Last-super-admin guard; `super_admin` code bypass |
| Migration on live prod | Expand-contract; backfill is capability-preserving (D7); enum dropped only in PR 5 |
| Name collision with future F13 | `super_admin` documented as tenant-scoped; platform role reserved as `platform_admin` |

## 12. Out of scope

- F13 platform Super-Admin console (cross-tenant, impersonation).
- Per-user permission overrides (roles only).
- Multiple roles per user (1 user = 1 role invariant stands).
- Permission-set caching (add only if p95 budgets demand).
