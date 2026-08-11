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

### 1.1 Pinned page-guard inventory (verified 2026-08-10 by full code walk — 47 pages)

The staff shell layout (`(staff)/admin/layout.tsx:32-37`) is the only inherited gate:
`requireSession('staff')` (session validity ONLY — zero role comparison) + a
`role === 'member' → redirect('/portal')` eject. Baseline observed truth for T015 capture
and the T022 shim rows; the round-1 "47 files / 11 without checks" note is SUPERSEDED by
this verified classification (47 = 17 + 8 + 21 + 1).

**Class A — 17 pure session-only pages = the EXACT `legacySessionOnly` shim membership**
(any signed-in staff role reaches them today):
`/admin` · `/admin/account` · `/admin/audit` · `/admin/broadcasts` · `/admin/broadcasts/[id]` ·
`/admin/credit-notes/[creditNoteId]` · `/admin/directory` · `/admin/invoices` ·
`/admin/invoices/[invoiceId]` · `/admin/members` · `/admin/members/[memberId]` ·
`/admin/members/[memberId]/timeline` · `/admin/plans` · `/admin/plans/[year]/[planId]` ·
`/admin/settings` · `/admin/settings/invoicing` · `/admin/users`

**Class A\* — 8 pages with an INERT `admin||manager` deny-arm** (admits exactly what the
layout admits today, but DENIES any 4th/5th role pre-sweep — these checks are class-4
call sites converted in the PR-2 sweep; their flag-OFF shim row class is
`legacyAdminOrManager`, which after D16 normalisation is extensionally identical to
`legacySessionOnly` — super_admin→admin passes, marketing/unknown denied):
`/admin/credit-notes` · `/admin/events` · `/admin/events/[eventId]` ·
`/admin/members/[memberId]/benefits`\* · `/admin/renewals` · `/admin/renewals/[cycleId]` ·
`/admin/renewals/tasks` · `/admin/settings/renewals/schedules`

\* `/admin/members/[memberId]/benefits` deviates twice and its PR-2 conversion must fix both:
its deny arm **throws** (rendering the 500 boundary at `(staff)/admin/error.tsx`) instead of
denying, and the check sits **below** the `getMember` + `computeBenefitUsage` PII reads. Convert it
to `notFound()` placed ABOVE those two reads (re-review 016 PR1, C-2).

**Class B — 21 admin-only-checked pages** (`role !== 'admin'` → notFound/redirect; the
observed guard is the flag-OFF expectation): broadcasts/new, broadcasts/templates{,/new,
/[id]/edit}, compliance/erasure-log, events/{[eventId]/registrations/[rid]/erase, erasure,
import, import/history}, invoices/{new, registers, [invoiceId]/void,
[invoiceId]/credit-notes/new}, members/{new, [memberId]/edit}, plans/{new, clone,
[year]/[planId]/edit}, renewals/tier-upgrades, settings/broadcasts,
settings/integrations/eventcreate

**Class C — 1 redirect-only page** (gate-script exemption): `/admin/compliance`

Sweep must also fix the STALE comments contradicting observed behaviour:
`users/page.tsx:12` ("admin role via the staff-shell auth guard" — false, manager reaches
it), `credit-notes/page.tsx:16`, `benefits/page.tsx:124`, `timeline/page.tsx:143`
("requireSession narrows to admin|manager" — the narrowing is the layout's member-eject,
not the helper).

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
