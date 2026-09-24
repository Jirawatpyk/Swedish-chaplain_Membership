# Void-on-reissue (106-void-on-reissue) — ship-gates + enable procedure

**Gate class:** BLOCKING. Both ship-gates below MUST pass before setting
`FEATURE_VOID_ON_REISSUE=true` in prod.

**Flag:** `FEATURE_VOID_ON_REISSUE` (default `false` — `src/lib/env.ts:348`,
`env.features.voidOnReissue`). The whole branch merges and ships with the
flag **OFF** — merging does not change prod behaviour. Enabling it is a
deliberate, separate, ops-owned action gated by this runbook.

## What the flag does

When ON, `issueMembershipBill` (the F8 reactivation bridge's entry point
into F4) auto-voids a member's strictly-older, still-outstanding
new-flow membership bill after the new bill successfully issues — see
`src/modules/invoicing/application/use-cases/issue-membership-bill.ts`.
The supersede-void reuses the **exact same** `voidInvoice` use-case as a
manual admin void (same `status='void'`, `voided_at`, `void_reason`,
`invoice_voided` audit row — just with `supersededByInvoiceId` on the
payload). A supersede-void failure is **never fatal** to the new issue
(metric-only `voidOnReissueFailed`, not a durable audit row — see
`plan.md` § 4.4).

The `§4.2` matcher (`listSupersedableMembershipBills`) only selects the
**new-flow bill shape**:

```
bill_document_number_raw IS NOT NULL AND document_number IS NULL
```

It will never match, and therefore never auto-void, a **legacy** §86/4
row that predates 088-invoice-tax-flow-redesign (shape:
`document_number IS NOT NULL`). That asymmetry is ship-gate 1.

## Ship-gate 1 — legacy §86/4 pre-check (`scripts/check-legacy-membership-86-4.ts`)

**Why:** if a member with an old, `issued`, unpaid pre-088 §86/4
membership invoice reactivates after the flag ships, the new bill issues
normally but the legacy invoice is silently left dangling forever — not
superseded, not voided, not paid. That is a live, uncollected tax
document that never gets flagged to the treasurer.

**Run (read-only, no writes):**

```bash
node --env-file=.env.local.bak.prod --import tsx scripts/check-legacy-membership-86-4.ts
```

- **Exit 0** (`0 legacy issued §86/4 membership rows`) → ship-gate 1 CLEAN.
- **Exit 1** (rows printed, grouped by tenant with `invoice_id` /
  `document_number` / `member_id` / `issue_date`) → ship-gate 1 FAILS.
  Hand the listed rows to the treasurer for manual §86/10 / ป.86/2542
  cancellation (do **not** hard-delete a §87-numbered tax document; void
  it through the normal admin invoice-void flow, which reconciles the
  sequence counter). Re-run until it exits 0.

Dev-branch smoke-test (sanity-check the script itself, not a ship-gate
run): `node --env-file=.env.local --import tsx scripts/check-legacy-membership-86-4.ts`.
A non-zero dev result is expected/harmless — it is finding real pre-088
fixture/import rows on the `dev` branch, not a prod signal. Only the
**prod** run (`.env.local.bak.prod`) is the actual ship-gate.

## Ship-gate 2 — prove a stale Stripe PaymentIntent can't settle a voided bill

**Why:** a member could have an open Stripe Elements tab (client-side
PaymentIntent already created) against an OLD bill at the moment that
bill gets auto-voided by a reactivation. Two independent, pre-existing
guards must both still hold so that stale PI can never settle money
against — or even be *initiated* against — a bill that void-on-reissue
just voided:

1. **The 059 portal chokepoint** (`checkPortalAccess`,
   `src/lib/lapsed-portal-scope.ts`, wired into every
   `requireMemberContext` call including `POST /api/payments/initiate`
   at `src/app/api/payments/initiate/route.ts`) — a `terminated` member
   can *view* their invoice list (read-only tax records stay
   allowlisted) but `/api/payments/initiate` is deliberately **not** on
   `LAPSED_PORTAL_ALLOWED_PREFIXES`, so a terminated member's Pay-now
   click 403s (`membership_access_restricted`) before `initiatePayment`
   ever runs. A `suspended` (not yet terminated) member is NOT blocked
   here by design — the suspended state is allow-by-default; ship-gate 2
   is specifically about the **terminated** case, which is the state a
   reactivation supersede-void implies (the old cycle lapsed/terminated
   before the member re-registered onto a new one).

2. **F5's stale-invoice auto-refund guard**
   (`confirmPayment`, `src/modules/payments/application/use-cases/confirm-payment.ts`)
   — if a PI somehow DOES reach Stripe and succeeds (e.g. it was
   confirmed client-side in the window before void), `confirmPayment`
   checks `invoiceStatus === 'issued'` before marking the invoice paid.
   A `void` status (however it got there — manual admin void OR
   void-on-reissue's supersede-void, they are the same code path) routes
   to the stale-invoice branch, which **auto-refunds the full amount**
   instead of marking the bill paid (`payment_auto_refunded_stale_invoice`,
   10y audit). This is pre-existing F5 behaviour, not new to this
   branch — void-on-reissue just needs to not have accidentally
   bypassed it, which it hasn't (it calls the same `voidInvoice`
   use-case as every other void path).

**Verify (read-only — run the existing suites, do not need new tests):**

```bash
pnpm test:integration tests/integration/portal/require-member-context-access-gate.test.ts tests/integration/payments/stale-invoice-auto-refund.test.ts
```

Confirm both are GREEN, specifically:

- `require-member-context-access-gate.test.ts` → `'terminated member +
  non-allowlisted route → 403 membership_access_restricted'` (covers any
  non-allowlisted route including `/api/payments/initiate` by the
  deny-by-default policy).
- `stale-invoice-auto-refund.test.ts` → `'void invoice → same
  auto_refunded flip (cause=invoice_voided) + durable marker'`.

Optional manual click-through (staging, before prod flip): as a member
whose most recent cycle is `terminated`, open an old unpaid invoice in
`/portal/invoices` — the page loads (read-only tax record) but the
Pay-now action 403s.

## Enable order

1. Ship-gate 1 clean (`check-legacy-membership-86-4.ts` against prod
   exits 0, or every listed row has been handed off + resolved by the
   treasurer).
2. Ship-gate 2 verified (both integration suites GREEN — re-run against
   prod topology if there is any doubt they've drifted since merge).
3. `vercel env add FEATURE_VOID_ON_REISSUE true --scope production` (or
   edit in the Vercel dashboard) + redeploy.
4. Smoke-test one real reactivation in prod: confirm the new bill issues
   AND the member's prior new-flow bill (if any) flips to `void` with a
   `supersededByInvoiceId` audit payload pointing at the new bill.

## When a supersede-void fails

The new bill is issued regardless; the older bill stays `issued`, so the
member has two open bills until someone voids the older one. Signals:

- `invoicing_void_on_reissue_failed_total{tenant}` increments (one per
  failed list or failed void).
- `issueMembershipBill` returns a typed `SupersedeWarning` per failure
  (`list_failed` / `void_failed` with the `voidInvoice` error code /
  `void_threw`), carrying the old bill's `invoiceId` and printed `SC`
  number. `POST /api/invoices/[invoiceId]/issue-auto-drafted` and
  `POST /api/admin/members/[id]/renew` return them as `supersede_issues[]`.
- Staff who issue from the admin auto-renewal queue or the member-detail
  "Renew" dialog see a persistent warning toast in their locale: "The older
  bill SC-… could not be voided automatically. Void it manually." It
  includes a link to that bill. For `list_failed`, no bill can be named, so
  the toast asks staff to check the member's invoices.
- Every renewal path logs one `warn` line per failure with the old bill's
  number (`supersededBillNumber`) and invoice id (`supersededInvoiceId`):
  - `F8.CONFIRM_RENEWAL.SUPERSEDE_VOID_FAILED`: member self-service
    renewal. The member is never shown this, so **no staff member sees a
    toast**. This log line is the only place that names the bill.
  - `F8.ADMIN_RENEW.SUPERSEDE_VOID_FAILED`: the admin "Renew" dialog, which
    also shows the toast above.
  - `F8.AUTO_ISSUE.SUPERSEDE_VOID_FAILED`: the auto-renewal queue's Issue
    actions, which also show the toast above. Carries `requestId` instead
    of `correlationId`.

Action: open the named bill and void it through the normal admin void.
Whenever the metric increments, search the logs for
`*.SUPERSEDE_VOID_FAILED`. A toast can be dismissed before anyone acts on
it; the log line cannot.

## Rollback

Flip `FEATURE_VOID_ON_REISSUE=false` in Vercel env + redeploy. Zero
schema changes ship with this branch (plan.md § 6), so disabling is a
plain env flip — `issueMembershipBill` reverts to a plain issue with
`supersedeWarnings: []` and no supersede pass runs. Any bill already
auto-voided while the flag was on stays voided (void is not reversible
by the flag flip — that is expected; a wrongly-voided bill is corrected
through the normal admin re-issue flow, same as any other void).

## Where staff and members see the link (121-void-supersede-links)

The `superseded_by_invoice_id` audit payload (snake_case in storage; the
use-case input field is `supersededByInvoiceId`) is read back by
`getInvoiceSupersession` (`src/modules/invoicing`):

- **Admin** `/admin/invoices/[id]` — a dashed "Replaced by SC-… · issued
  {date}" row inside the Voided section of the old bill; a "Replaces SC-…"
  field on the new bill.
- **Portal** `/portal/invoices/[id]` — "This bill was replaced by SC-…" inside
  the void block, and "Replaces SC-…" on the new bill. Member-scoped: a link
  whose other end is not the viewing member's own invoice is dropped and
  logged (`getInvoiceSupersession: supersede link member mismatch`). That
  should never happen; if it does, investigate the audit row.

A manual void carries no `superseded_by_invoice_id`, so it shows nothing new.
The audit row stays the single source of truth; migration `0305` only adds two
partial expression indexes on `audit_log` for the forward and reverse lookups.
Flipping the flag off stops new links being written; links already written
keep rendering.

## Related

- `docs/superpowers/plans/2026-07-18-void-on-reissue.md` — full plan (§4
  behaviour spec, §6 kill-switch, Task 6 brief).
- `docs/runbooks/f5-0242-preflight-credit-note-dupes.md` — sibling
  ship-day pre-flight pattern (pre-existing-duplicate check before a
  behaviour change goes live).
- `docs/runbooks/out-of-band-refund.md` — the broader F5 stale/OOB refund
  reconciliation runbook (ship-gate 2's guard is one instance of this).
