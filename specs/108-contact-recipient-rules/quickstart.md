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

First run (2026-09-04): violations 0, secondaries 0, secondaries with login 0,
unsubscribes 0, members 110 active / 40 inactive. Re-run immediately before PR-B merges.

**Remedy when the count is not 0** (T041 round 3 corrected this — the earlier wording pointed at
a 409): which code is running decides the fix. **With PR-B deployed**, open the member page and
promote a remaining contact — promote designates when the member has no current primary — or
add a contact (the first contact of a member with no live primary becomes the primary). **Before
PR-B is deployed** (the 0293 pre-check failed the build, so prod is still on the previous
deployment) that promote refuses with `no_current_primary` and add inserts a secondary, so the
repair is a human-chosen, per-member, tenant-scoped `UPDATE contacts SET is_primary = true
WHERE tenant_id = … AND contact_id = …` — one row, the contact the chamber names; never a script
that auto-picks (research R4). The preview deployment is copy-on-write from prod and runs the
same pre-check in `vercel-build`, so a prod violation fails the preview before merge. Re-run the
inventory until it prints 0, then merge / redeploy.

## Rollback matrix

| PR | Code revert | Flag | Data |
|---|---|---|---|
| A (money hardening) | `vercel promote` previous deployment; 0292 is an enum add (harmless when unused) | none | none |
| B (invariant) | revert restores the racy path; triggers stay installed and are safe with correct data | none | 0293 forward-only; drop triggers only via a new migration |
| D (permission + page + columns) | revert hides the page/route; 0294/0295 columns + enum values are unused when reverted | none | none |
| C (audience) | flag OFF restores the primary-only leg and the 5,000 ceiling. **Everything else in PR-C is UNFLAGGED and lands on merge** — a code revert (`vercel promote`), not a flag flip, is the rollback for any of it (reliability M-3; the list below was completed at the re-review, finding #1): **(1)** FR-021 `status = 'active'` — an inactive / archived member's primary stops receiving; **(2)** the `.limit(5000)` removal — a >5,000 audience is refused, not silently cut; **(3)** the bridge lookups AND `setMemberHalt` throw on a failed read/write — submit 500s, dispatch retries, clear-halt 500s, instead of failing open; **(4)** self-exclusion is by MEMBER id on member-based segments only — pre-108 the sender's primary address was filtered out of EVERY segment kind, so a member who puts their own address on a custom list now receives their own e-blast (FR-022a/b; the compose hint says so); **(5)** every unsubscribe writes `marketing_unsubscribes.contact_id` — the column is in use from merge, see the Data column; **(6)** GDPR erasure now severs `member_id` AND `contact_id` on that member's suppression rows (`severMemberRefs`, FR-056) — before PR-C the `member_id` back-reference was retained; **(7)** a persisted `tier` broadcast whose `segment_params` lost its codes is a terminal `failed_to_dispatch` (before: it was sent to every active member); **(8)** the whole compose UI — live count, per-segment hints, the submit block on a measured refusal, the separate preference toast, the halt-state banner, the compose page throwing on a failed member read; **(9)** the `approved_overdue_count` gauge and the zero-fill / forget behaviour of the gauges cron. | `FEATURE_CONTACT_MARKETING_RECIPIENTS=false` + redeploy — for the WIDENING and the 50,000 ceiling only | **0297 is WRITTEN from merge, flag or not**: `contact_id` is filled by every unsubscribe (`unsubscribe-recipient.ts` reads no flag). Dropping the column while PR-C's code is deployed breaks every unsubscribe with a 42703 — drop it only after a code revert, via a new migration. (0298 deferred with T086.) |

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
# NOTE: audience-import-two-tick.test.ts was listed here until 2026-09-08 (T098) and does
# NOT exist — it was dropped with the deferred import build (T086/T087/T106). Running it
# returned "no test files found", which vitest reports without failing the command.
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
2. PR-C deployed with the flag OFF; the unflagged changes are the ones listed in the rollback
   matrix above (active-only narrowing, no silent cut, fail-closed reads, the compose UI).
3. Staff run the FR-027a pre-flight review on the audience page (preset link) and switch
   off anyone who should not receive.
3a. **GDPR Art. 14 gate (staff review 🟡-3 lifted it here from
   `docs/compliance/processing-records.md:128-135`, where an operator would not have seen
   it).** The flip MUST NOT happen until EITHER the system sends a notice to a new
   secondary contact on first marketing contact, OR the FR-027a pre-flight above verifies
   the attestation per contact. A secondary who never gave their address to the chamber
   directly is a data subject the chamber has not yet informed.
3b. **Push-capacity gate (staff review 🔴).** The 1:N ceiling accepts up to 50,000, but the
   dispatch push is a serial one-contact-at-a-time loop at ~2 req/s inside a 300 s
   function budget, and `split-large-broadcasts` skips anything at or below 10,000 — so a
   broadcast in that band is accepted and then never delivered. Before flipping, land ONE
   of: the import build (T086/T087/T106); a lowered `SPLIT_THRESHOLD_RECIPIENTS` **plus** a
   wall-clock budget with resume in `addContactsToAudience`; or an explicit submit-time
   refusal above `300 s × measured req/s − margin`. Measure the team's real req/s
   (Settings → Usage, T095) and record the number in `reviews/pr-c.md` row 33. At
   SweCham's ~150 members × 3 contacts this is ~225 s against 300 s — no margin.
4. Flip `FEATURE_CONTACT_MARKETING_RECIPIENTS=true` in Vercel; redeploy.
5. First send — watch the five signals PR-C ships (the `audience_import_status` gauge went
   with the deferred T086 and does not exist):
   - `broadcasts_audience_resolved_total{mode}` flips from `primary_only` to `all_contacts`
     on the first resolve (phase `dispatch`);
   - `broadcasts_recipient_count_ms{outcome="ok"}` p95 inside SLO-F7-013 (400 ms @ 5,000);
   - `broadcasts_dispatch_resolve_failed_total` stays 0 and `broadcasts_approved_overdue_count`
     stays 0 through the send;
   - `broadcasts_marketing_opt_out_filter_count{phase="dispatch"}` is a LIVE series (present,
     even at 0 — its absence means the filter stopped running);
   - the outbox: `estimated_recipient_count` = delivered.
   Any of the first four wrong → § Rollback (flag OFF) before the next tick.
6. After one clean week: follow-up PR deletes the flag and the `primary_only` leg.
7. Live-mode switch checklist (separate): Stripe Dashboard → Customer emails →
   "Successful payments" OFF.
