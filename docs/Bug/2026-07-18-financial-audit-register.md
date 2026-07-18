# Financial audit — consolidated issue register

**Date**: 2026-07-18
**Sources**: two subagent audits run on the same day —
`financial-integrity-reviewer` (money-path correctness on branch
`invoice-dialogs-ux-declutter`) and `financial-reporting-analyst` (F9 admin
dashboard metric semantics + query correctness, reconciled read-only against
the `dev` Neon branch).
**Fix branch**: `worktree-financial-audit-fixes` (worktree, based on `main` @ `b425612c8`).

## How to read this

Findings are grouped by **where they can be fixed**, not by which audit found
them, because the two audits landed on different bases. Severity is stated by
consequence: a silent wrong number that people act on outranks a crash.

Status values: **FIXED** (in this branch) · **DEFERRED** (needs an accounting
decision or a schema change) · **OTHER BRANCH** (the code does not exist on
`main` yet).

---

## Part 1 — Fixed on this branch

### B1 · BLOCKER · Donut centre total contradicted its own label

`src/components/dashboard/invoice-status-chart.tsx`

The card was titled *"Receivables by value"* with the centre figure labelled
*"Total outstanding"*, but the underlying data is `InvoiceStatusDistribution` —
which includes a `paid` bucket. The centre summed all three buckets, so
already-collected cash was presented as an outstanding receivable.

Measured on `dev`: displayed **฿2,997,568** against real receivables of
**฿1,250,637** — overstated by ฿1,746,930 (**140%**).

The same file already carried a comment stating that a partially-credited
invoice's net balance "is already-collected cash, not a receivable".

**Fix**: the card was misnamed, not the arithmetic. Renamed to what it
actually shows so the centre total equals the sum of its arcs:

| key | before | after |
|---|---|---|
| `invoiceStatus.title` | Receivables by value | Invoice value by status |
| `invoiceStatus.empty` | No outstanding receivables yet. | No issued invoices yet. |
| `invoiceStatus.totalLabel` | Total outstanding | Total invoiced |

A dedicated receivables figure is a **follow-up**, not a regression — the
number shown before was never correct.

### M-2 · HIGH · CWE-915 mass-assignment on two money routes

`src/app/api/invoices/[invoiceId]/void/route.ts`
`src/app/api/invoices/event-draft/route.ts`

Both routes spread the request body **last** into `safeParse`, so a client
value overrode every server-derived field:

- `actorUserId` — flows straight into `audit.emit()`. An admin could stamp
  another user's id onto the audit record for a void, and a void irreversibly
  retires a §87 sequential number.
- `tenantId` — held only by RLS; the explicit repo filter was not a real
  second layer.
- On the void route, three internal void-on-reissue flags (`requireStatus`,
  `suppressCancellationEmail`, `supersededByInvoiceId`) were client-settable —
  allowing the FR-036 cancellation email to be skipped and a manual void to be
  disguised as an automated supersede in the audit payload.

Not privilege escalation (admin-only, RLS-bounded), but it removes any
guarantee that the audit trail on a money mutation is truthful.

**Fix**: event-draft spreads the body first and overwrites with server-derived
identity last. The void route gets a narrow HTTP-boundary schema
(`voidInvoiceBodySchema`, `voidReason` only) and assembles the use-case input
explicitly, so the internal flags are unreachable from HTTP. `.strict()` would
not have helped — these are known keys of the schema, so spread order is the
control.

### M3 · MEDIUM · `countOverdue` sampled the host clock

`src/modules/insights/infrastructure/sources/invoice-source-adapter.ts`

`countOverdue(ctx)` called `new Date()` internally while its two sibling
methods take an injected `nowIso`. The overdue KPI and the donut's overdue
bucket are computed in the same `Promise.all` but read the clock separately,
and the count could not be pinned in a test.

**Fix**: `countOverdue(ctx, nowIso)`; the use-case passes the same `now` it
already passes to its siblings. Port, adapter, and three integration call
sites updated.

### M4 · MEDIUM · Best-effort audit write bypassed tenant context

`src/modules/insights/infrastructure/audit/insights-audit-adapter.ts`

`record()` called `insertAuditRow(db, event)` — the pool-global singleton,
outside `runInTenant`, with no `SET LOCAL app.current_tenant`. The
`recordInTx` path in the same file documents this as forbidden. It was the
only query in the insights module doing it; the row still landed under the
right tenant because `tenant_id` is bound from the event, but with no second
layer behind it.

**Fix**: routed through `runInTenant(asTenantContext(event.tenantId), …)`.
Tenant-less events (`tenantId: null`) keep the auto-commit path. Verified
every caller is a read-side or probe path holding no row lock, so opening a
transaction here cannot hit the FK-child deadlock class.

### H1–H4, M2, M6, M7 · HIGH/MEDIUM · Dashboard figures did not state their basis

Three money figures sit on one screen computed on three different bases, none
of which was disclosed:

| figure | VAT basis | period | date anchor |
|---|---|---|---|
| revenue KPI | ex-VAT | fiscal year | issue date |
| trend sparkline | ex-VAT | rolling 12 months | payment date |
| status donut | **VAT-inclusive** | **all-time** | — |

Reconciled on `dev`: KPI ฿1,632,645 vs donut paid slice ฿1,746,930. The
difference is **exactly VAT**, plus 20 satang of BigInt-division truncation
across ~140 invoices. Both numbers are right; nothing on screen said so.

Specific defects fixed:

- **H1** — TH read "(ปีนี้)" and SV "(i år)" — *this calendar year* — for a
  figure filtered by `invoices.fiscal_year`. Correct only by coincidence for a
  January-start tenant like SweCham; silently wrong for any other.
- **H2** — the KPI and the "12-month total" showed an identical ฿1,632,645 on
  `dev`, but only because FY2025 happened to net to zero. Different bases, so
  they will diverge with no on-screen explanation.
- **H3** — the current, incomplete month was rendered identically to closed
  months in both sparklines. On the 3rd of a month the last bar reads as a
  collapse in revenue.
- **M2** — the donut is all-time but sits beside a fiscal-year KPI.
- **M6** — the member-growth delta chip said "this year" for a rolling
  12-month window (overstating by ~5 months in July).
- **M7** — `kpi.total` and `memberGrowth.total` shared the string "Total
  members" for two different quantities.

**Fix** — label changes across en/th/sv, plus a new `invoiceStatus.basisCaption`:

| key | after (EN) |
|---|---|
| `kpi.revenue` | Paid revenue (fiscal year to date, ex-VAT) |
| `revenueTrend.total` | 12-month total (by payment date, ex-VAT) |
| `revenueTrend.perMonth` | Per month · current month still in progress |
| `memberGrowth.cumulative` | Cumulative · current month still in progress |
| `memberGrowth.netNew` | +{count} over 12 months |
| `memberGrowth.total` | Cumulative members |
| `invoiceStatus.basisCaption` | All fiscal years · includes VAT |

H3 is addressed as a caption rather than a visual encoding change; marking the
in-progress bar differently in the chart itself is a follow-up for
`enterprise-ux-designer`.

---

## Part 2 — Belongs to branch `invoice-dialogs-ux-declutter`

Neither exists on `main`; both were introduced by that branch's event-draft
409 work and must be fixed there.

### H-1 · HIGH · New cross-tenant-capable port method has no isolation test

`findEventInvoiceIdByRegistration(eventRegistrationId, tenantId)` takes a raw
registration id and returns an **invoice id**. Isolation is implemented
correctly (server-derived `runInTenant` ctx + RLS + explicit `eq(tenantId)`,
no `db` singleton), but Constitution v1.4.0 Principle I makes a cross-tenant
integration test a Review-Gate blocker, and there is none. The pattern already
exists in `tests/integration/invoicing/event-registration-lookup-cross-tenant.test.ts`.

### M-1 · MEDIUM · Unwrapped read in a catch block can turn a correct 409 into a 500

The duplicate-detection path catches Postgres 23505 and then performs an extra
read to attach `existingInvoiceId`. That read is not wrapped, and the route
has no surrounding try/catch — a connection blip during it converts a correct
`409 duplicate` into a `500`. The type and comment already allow `null`.
One-line fix: `try { … } catch { existingInvoiceId = null }`.

### Tests to add on that branch

1. Cross-tenant integration test for `findEventInvoiceIdByRegistration` (H-1).
2. Integration test that a **voided** event invoice does not block re-creating
   one for the same registration — today's test would still pass if
   `ne(status, 'void')` were deleted.
3. Unit test for the throw path in the catch block (M-1).
4. Contract test asserting a spoofed `actorUserId` in the body does not reach
   the audit event (M-2 regression guard — worth having on both branches).

---

## Part 3 — Deferred: needs a decision or a schema change

### H5 · HIGH · No recognised revenue, and the schema cannot express it

Annual dues are booked entirely in the month of payment. `invoices` has **no
coverage-period column** (verified against `information_schema`); the only
period data lives in `renewal_cycles.period_from/period_to`, which F9 never
joins. A member paying a Jan–Dec subscription in January produces one spike
and eleven empty months. For a membership chamber this is the primary shape of
revenue, not an edge case.

### M1 · MEDIUM · Credit notes rewrite closed periods

Credits are netted into the month the original invoice was **paid**. On `dev`,
144 credit notes issued 2026-03-15 apply to invoices paid in 2025-11, changing
that month from ฿24,610 to ฿0 four months after the fact. Anyone who
screenshotted a board report cannot reconcile it. See accountant question 2.

### M5 · MEDIUM · Member and revenue KPIs use different populations

Member tiles exclude GDPR-erased members; revenue figures do not. On `dev` the
two erased members have no invoices so nothing diverges yet. **Counting an
erased member's invoices in revenue is correct** — erasure pseudonymises the
person, it does not delete tax documents (§87/3 retention). This needs a
written definition, not a code change.

### M8 · MEDIUM · Event fees are mixed into "revenue"

One event invoice (65,421 satang) sits inside the membership revenue KPI on
`dev`. Recurring dues and transactional event income should almost certainly
be separated before anyone reads a trend.

### A1 · ADVISORY · No staleness affordance

`asOf` renders as muted text with no threshold. The snapshot cron runs every 5
minutes; if it dies, a six-hour-old figure looks identical to a fresh one.

### A5 · ADVISORY · No financial export for the accountant

F9 ships `export-members-backup` and `generate-directory-export` — both
PII/directory, neither financial. There is currently no way to reconcile the
dashboard against the tax-document register without opening SQL. Recommend one
export with an explicit column contract (including units) before go-live.

### A2 · ADVISORY · Buddhist Era is stored in one place, with no inverse

BE never reaches a WHERE clause anywhere in the repo. But
`create-invoice-draft.ts` computes `feeYearBE = feeYearCe + 543` into
`membershipDescTh`, which is persisted to `invoice_lines`. This is **by
design** — tax-document text must be frozen at issue — and every queryable
field stays CE. The hazard: there is no `-543` anywhere in the codebase, so
this cannot be round-tripped. Any future backfill that recomputes line
descriptions must re-apply +543 or silently shift years by 543.

---

## Part 4 — Open questions for the chamber's accountant

Questions 2 and 3 extend the thread already open from the 088 whole-feature
review (ภ.พ.30 voided-VAT + §86/10 netting) and should be asked together.

1. **Deferred revenue** — should annual dues collected in January be January
   revenue, or recognised 1/12 per month?
   *Recommendation*: keep today's figure but label it **Collected**, and add
   recognised revenue as a separate metric later — it cannot be built today
   without joining `renewal_cycles`.
   *If wrong*: the board budgets against a revenue shape that does not exist.

2. **Credit-note period** — should a March credit note reduce the original
   November period, or March?
   *Recommendation*: March, matching ภ.พ.30 and keeping closed months closed.
   If the current behaviour is kept, the trend chart must warn that history
   can change.
   *If wrong*: already-distributed reports stop matching the live dashboard.

3. **ex-VAT or gross** — is "revenue" net of VAT?
   *Recommendation*: ex-VAT is correct for a management KPI (VAT is a
   liability, not income) — but it must be stated, along with why the donut
   beside it is VAT-inclusive.
   *If wrong*: every figure is off by 7% and nobody notices until ภ.พ.30.

4. **Event fees** — same "revenue" bucket as membership dues, or separate?
   *Recommendation*: separate; one large event otherwise looks like membership
   growth.

5. **Withholding tax** — do corporate members deduct 3% on payment? If so, an
   invoice marked paid at face value received less cash.
   *Recommendation*: confirm whether this actually happens at TSCC first. If
   it does, "Collected" is the amount owed, not the amount banked.
   *If wrong*: the on-screen cash figure never matches the bank statement.
