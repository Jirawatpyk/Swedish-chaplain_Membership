# Contract — Permission Evaluator, Helpers, and Compatibility Shim

Consumers: every `(staff)` page, every staff API route handler, nav/palette filtering,
`src/modules/plans` (via Domain deep import), audit emitters. Provider:
`src/modules/auth/domain/permissions/` (pure) + `src/lib/rbac.ts` (composition root).

## 1. Domain evaluator (pure — NO env/framework imports)

```ts
// src/modules/auth/domain/permissions/evaluator.ts
getPermissionSet(role: Role): ReadonlySet<PermissionKey>
hasPermission(
  role: Role,
  key: PermissionKey,
  opts: { rbacV2: boolean },        // flag is ALWAYS an explicit parameter (purity pin)
): boolean
```

Guarantees:

| # | Guarantee |
|---|---|
| E1 | `rbacV2: true` ∧ role = `super_admin` → `true` for every key (total bypass) |
| E2 | `rbacV2: true` ∧ key is `superAdminOnly` ∧ role ≠ `super_admin` → `false` — even if a bundle (bug) contains the key |
| E3 | `rbacV2: true` → result = `ROLE_BUNDLES[role].has(key)` (matrix parity, table-tested) |
| E4 | `rbacV2: false` → result = shim row for the CALL-SITE CLASS (see § 3), with D16 totalisation: `super_admin` evaluates as `admin`; `marketing` → `false` (DENY) |
| E5 | Deterministic + synchronous — no I/O, no DB, no Date/random |
| E6 | Unknown/future role value on either leg → `false` (never escalates, never throws) |

## 2. Composition-root helpers (`src/lib/rbac.ts` — the ONLY env-flag readers)

```ts
requirePagePermission(key: PermissionKey): Promise<void>
// session (staff portal) → hasPermission(role, key, {rbacV2: env}) →
//   deny: emit permission_denied (fail-open) → notFound()          [pages = 404]

requireApiPermission(key: PermissionKey): Promise<Result<Session, ApiDenial>>
// deny: emit permission_denied (fail-open) → typed 403 result       [APIs = 403]

canAccess(role, resource, action): boolean
// legacy façade over the evaluator — keeps old signature during migration; deleted PR 5
```

Denial audit payload (pinned — nothing else): `{actor_user_id, role (REAL role,
no coercion), permission_key, route_path (no query string), request_id}`.
Fail-open: the 404/403 is served even when the emit throws.

Call-site rules:
- Pages/handlers call the helper ONCE with a **literal** key argument
  (`check:staff-page-guard` parses literals only).
- Client components NEVER read the flag/env — they receive server-derived booleans as props.
- `src/modules/plans` deep-imports the Domain evaluator (never auth's barrel — argon2
  hazard) and threads the flag from its own server boundary. ESLint carve-out scoped to
  that exact specifier (Complexity Tracking #1).

## 3. Compatibility shim (flag-OFF leg — deleted in PR 5)

Rows are **per call-site class, not per key** (one key MAY span several rows):

| Row class | Applies to | Flag-OFF behaviour |
|---|---|---|
| `legacySessionOnly` | ONLY the 17 pages verified ungated today (incl. the `/admin/users` + `/admin/audit` PAGES) | any staff session passes |
| `mappedLegacy(resource, action)` | API routes with a real guard today | delegate to observed `canAccess` outcome — e.g. `users.manage` → `('auth:user','write')`; `members.erasure` → `('members','write')` |
| multi-row keys | `settings.invoicing` spans THREE: page → `legacySessionOnly` · GET → manager-readable · PUT/logo → admin-only | each row mirrors its own observed gate |
| `legacyF6Guard` | `/api/admin/events/**` + `/api/admin/integrations/eventcreate/**` | reproduce `adminOnlyWriterGuard` verbatim per role (manager 403+RFC 7807+audit; member/unknown 404) |

**Anti-circularity rule**: expected flag-OFF cells in the characterization suite are
captured from OBSERVED pre-PR-2 behaviour — never derived from this table. The suite
MUST assert manager remains DENIED on: all six users routes, both erasure endpoints,
the erasure log, and invoice-settings mutations.

## 4. Contract tests (tests/contract/rbac/)

| Test | Asserts |
|---|---|
| bundle-parity | ROLE_BUNDLES ≡ design § 4.1 matrix, table-driven |
| superadmin-only | E1 + E2 + Domain proof no bundle holds an SA key |
| d16-totalisation | flag OFF: super_admin ≡ admin rows; marketing all-DENY |
| unknown-role | E6 both legs; audit emitters record the literal unknown string |
| denial-audit | per role: denial → `permission_denied` with pinned payload; emit-throw still serves denial |
| facade-parity | `canAccess` façade ≡ legacy `policies.ts` for all (role, resource, action) triples while both exist |
| characterization | full (surface × role × leg) matrix — observed-behaviour cells; runs as the flag-parameterised CI job (flag NOT force-set in tests/setup.ts) |
