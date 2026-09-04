# Quickstart — 108 Contact Recipient Rules (developer workflow)

## Prerequisites

Standard repo setup (`pnpm install`, `.env.local` → the **dev** Neon branch, dev server on
:3100 run by the user). No new services. One new env var (PR-C):

```bash
FEATURE_CONTACT_MARKETING_RECIPIENTS=true   # 1:N audience + new ceiling + custom-list drop; default false
```

Read only in `src/modules/broadcasts/infrastructure/broadcasts-deps.ts`; the resolver takes
`audienceMode` as a parameter. Never read it in components or Domain code.

## Before PR-B merges (operator, read-only, prod)

```bash
# counts only — no PII. Run with the ! prefix if the session classifier blocks it.
node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts
# prints: active/non-erased members with 0 or >1 live primaries (must be 0), secondaries total,
#         secondaries with portal login, marketing_unsubscribes count
```

Migration 0293's pre-check fails the deploy if the first number is not 0.

**Remedy when the count is not 0**: for each listed member (ids only), open the member page,
promote a remaining contact (or add one and promote it) — the existing promote path is the
fix; do not edit rows by hand. Re-run the inventory until it prints 0, then merge PR-B.

## Rollback matrix

| PR | Code revert | Flag | Data |
|---|---|---|---|
| A (money hardening) | `vercel promote` previous deployment; 0292 is an enum add (harmless when unused) | none | none |
| B (invariant) | revert restores the racy path; triggers stay installed and are safe with correct data | none | 0293 forward-only; drop triggers only via a new migration |
| D (permission + page + columns) | revert hides the page/route; 0294/0295 columns + enum values are unused when reverted | none | none |
| C (audience) | not needed for behaviour — **flip the flag OFF** (primary-only leg) | `FEATURE_CONTACT_MARKETING_RECIPIENTS=false` + redeploy | 0296/0297 unused when OFF |

Incident notes: a broadcast already delivered under the wrong audience cannot be recalled —
record the broadcast id, notify the tenant admin contact, and flip the flag off before the
next scheduled dispatch; a money email delivered to a former primary (pre-PR-A) is corrected
by an admin resend from the invoice page after promoting the right contact.

## Migrations (dev branch only)

```bash
pnpm db:migrate            # applies 0292..0297 to the dev branch; prod migrates on deploy
pnpm db:verify             # then confirm the DDL landed (information_schema) — a duplicate `when` is a silent no-op
```

Enum `ADD VALUE` files (0292, 0295) contain nothing but `ALTER TYPE` statements.

## Per-PR test loops

```bash
# PR-A — money hardening (invoicing + payments)
pnpm test tests/unit/invoicing tests/unit/payments
pnpm test:integration tests/integration/invoicing/record-payment-live-recipient.test.ts   # file PATH, never -- <pattern>
pnpm vitest run tests/contract/invoicing/money-email-recipient-inventory.test.ts
pnpm check:money-recipient

# PR-B — invariant
pnpm test:integration tests/integration/members/primary-contact-race.test.ts
pnpm test:integration tests/integration/members/primary-contact-trigger.test.ts

# PR-D — permission + audience page + toggles
pnpm test tests/unit/auth/permissions tests/unit/nav tests/unit/members
pnpm vitest run tests/contract/rbac/ tests/contract/members/contact-marketing.test.ts
pnpm check:staff-page-guard && pnpm check:api-route-guard && pnpm check:layout && pnpm check:actor-role-truth
pnpm test:e2e tests/e2e/admin-marketing-audience.spec.ts --workers=1

# PR-C — resolver + push + count
pnpm test tests/unit/broadcasts tests/unit/members/application/get-members-by-segment.test.ts
pnpm test:integration tests/integration/broadcasts/audience-1n-status.test.ts
pnpm test:integration tests/integration/broadcasts/audience-pagination-20k.test.ts
pnpm test:integration tests/integration/broadcasts/audience-import-two-tick.test.ts
```

Before opening any PR: `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm vitest run tests/contract/`
(~4 min) then `pnpm test:coverage` for the pinned files. Money-path PRs (A, C) go through
`financial-integrity-reviewer`; PII/RBAC PRs (B, D) through `security-engineer` +
`pdpa-gdpr-compliance-officer`; every UI PR through `enterprise-ux-designer`.

## Manual verification (browser, dev server on :3100)

1. **Tier A**: as admin, issue an invoice to a member whose primary is A; promote B; mark
   paid, void, credit-note, resend. Check `notifications_outbox.to_email` = B for all rows.
   Sign in to the portal as a secondary with a login; resend → 202 body has no address;
   pay with PromptPay (Stripe test) → PaymentIntent `billing_details.email` = primary.
2. **Invariant**: on a member with primary P and secondary Y, run the race script
   (`scripts/dev/race-promote-remove.ts`) → one of the two calls returns 409, member keeps
   exactly one primary.
3. **Audience page**: as marketing persona, open `/admin/marketing/audience?kind=secondary&state=on&eligible=1`;
   switch one contact off; as manager the switch is absent; as marketing try to edit the
   same contact's phone via the member page → 403.
4. **Broadcast** (flag ON on dev): compose "All members" → count equals the audience page's
   eligible count minus your own contacts; submit; after dispatch, the Resend audience
   contains every eligible contact once and none of the switched-off / unsubscribed ones.

## Cutover checklist (prod)

1. PR-A, PR-B, PR-D deployed; V1 counts confirmed 0 violations before PR-B.
2. PR-C deployed with the flag OFF; no behaviour change except `status = 'active'`.
3. Staff run the FR-027a pre-flight review on the audience page (preset link) and switch
   off anyone who should not receive.
4. Flip `FEATURE_CONTACT_MARKETING_RECIPIENTS=true` in Vercel; redeploy.
5. First send: watch `broadcasts.audience_import_status` (and the import's `counts` in the Resend dashboard) and the outbox; confirm
   `estimated_recipient_count` = delivered.
6. After one clean week: follow-up PR deletes the flag and the `primary_only` leg.
7. Live-mode switch checklist (separate): Stripe Dashboard → Customer emails →
   "Successful payments" OFF.
