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

## Rollback

Flip `FEATURE_VOID_ON_REISSUE=false` in Vercel env + redeploy. Zero
schema changes ship with this branch (plan.md § 6), so disabling is a
plain env flip — `issueMembershipBill` reverts to a plain issue with
`supersedeWarnings: []` and no supersede pass runs. Any bill already
auto-voided while the flag was on stays voided (void is not reversible
by the flag flip — that is expected; a wrongly-voided bill is corrected
through the normal admin re-issue flow, same as any other void).

## Related

- `docs/superpowers/plans/2026-07-18-void-on-reissue.md` — full plan (§4
  behaviour spec, §6 kill-switch, Task 6 brief).
- `docs/runbooks/f5-0242-preflight-credit-note-dupes.md` — sibling
  ship-day pre-flight pattern (pre-existing-duplicate check before a
  behaviour change goes live).
- `docs/runbooks/out-of-band-refund.md` — the broader F5 stale/OOB refund
  reconciliation runbook (ship-gate 2's guard is one instance of this).
