# Contract — Staff Authorization Surfaces

The complete authorization surface = `(staff)` pages + `src/app/api/**` staff route
handlers + the nav/palette data layer (verified: no `'use server'` actions exist).
This contract defines what every surface MUST declare and how the matrix verifies it.

## 1. Pages (`src/app/(staff)/admin/**`)

- Every page calls `requirePagePermission('<literal key>')`; denial → `notFound()` 404.
- Mechanical coverage: `check:staff-page-guard` (clones the `portal-guard-core` gate
  precedent; literal-only arguments; wired into `.husky/pre-push` + the
  `quality-gates.yml` static step — both edits are named PR-2 deliverables).
- Redirect-only pages use the gate script's exemption mechanism (memory:
  check:layout precedent).

## 2. API routes (`src/app/api/**/route.ts`)

Every handler export is classified by exactly one expected-class:

| Class | Meaning | Denial |
|---|---|---|
| `role-matrix` | staff surface — calls `requireApiPermission(key)` | typed 403 + `permission_denied` |
| `public` | unauthenticated by design (sign-in, invite redeem, …) | n/a |
| `cron-bearer` | Vercel Cron, Bearer `CRON_SECRET` | 401 |
| `webhook-signature` | Stripe/Resend signature-verified | 401 |
| `portal-member` | member self-service (untouched by this feature) | existing semantics |

- **Exhaustiveness test**: fs-walks `src/app/api/**/route.ts`; parser recognises
  `export async function METHOD`, `export const METHOD = <ident>` (alias, e.g.
  `GET = POST`), `export const METHOD = <call>`; ignores known Next.js config exports;
  **fails on any unclassified export**. No exempt list — every route carries a class.
- **F6 override rows** (D9): `/api/admin/events/**` + `/api/admin/integrations/
  eventcreate/**` keep `adminOnlyWriterGuard` semantics verbatim — manager 403 +
  RFC 7807 + F6 `role_violation_blocked` audit; member/unknown/no-session 404. Their
  matrix rows are captured from observed guard behaviour. Stale `archive/route.ts`
  header comment fixed in PR 2.

## 3. Users routes — per-TARGET-role contract (§ 7.1)

The six mutating routes (invite, resend, revoke, change-role, disable, enable) branch
on the TARGET row's role (guard already loads it):

| Target | Required permission | Held by |
|---|---|---|
| staff-role target (super_admin/admin/manager/marketing) | `users.manage` (SA-only) | super_admin |
| member target | `users.member_accounts` | super_admin + admin |

Matrix carries per-target-role expectation rows for all six routes × all actor roles.
Last-SA protection: change-role / disable (and erase-user, delete path) refuse on the
last active super_admin at app + DB layers (typed error, never a 500).

## 4. Role × endpoint matrix (the review artefact)

- Table-driven; one row per (surface, actor role[, target role]) with expected outcome
  per flag leg. Flag-OFF cells = OBSERVED behaviour (anti-circularity).
- Marketing rows (PR 4): every money/PII/compliance surface DENIED (SC-004);
  broadcasts compose→approve→send + events RW (minus relink/erasure) ALLOWED.
- Per-role F6 rows from guard behaviour, not from the D9 prose.

## 5. Navigation / palette / settings index (third surface)

- PR 2 (behaviour-preserving): `filterNavConfig` + palette role filters swept through
  the flag-parameterised evaluator; the three literal `roles: ['admin']` arrays
  (erasure-log, broadcasts-settings, eventcreate-integration — nav.ts:301/349/376)
  widen to `['admin','super_admin']`; palette if-chains stop falling through to empty
  for `super_admin`.
- PR 4 (end state): every nav item / palette action / settings category declares
  `requiredPermission`; filtering is server-derived; **no role literals in nav code**
  (architecture guard enforces).
- Invariants (E2E-asserted): visible set ≡ permitted set; every visible entry opens
  successfully (no dead links); post-C super_admin sees a non-empty palette + the
  erasure-log entry; every staff role lands on ≥1 dashboard widget.

## 6. Insights split (PR 4)

- F9 snapshot loader splits: engagement part ↔ `insights.engagement`; finance part ↔
  `insights.finance`; widget→permission map is data.
- Marketing receives engagement widgets only — no finance figures in the payload
  (server-side, not CSS hiding); grid collapses without holes.
- Activity feed redaction keys to `insights.activity_unredacted` (ON leg).
- Audit viewer: ON leg — `audit.read` holder ⇒ unredacted projection; OFF leg keeps
  today's projection exactly (admin full / manager redacted; post-C super_admin →D16→
  full). `AuditViewerRole` union is NOT widened to string.
