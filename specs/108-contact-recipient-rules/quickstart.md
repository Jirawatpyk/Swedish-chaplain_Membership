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
| C (audience) | flag OFF restores the primary-only leg and the 5,000 CONFIGURED ceiling — **read item (10) before reasoning about any number here; this row has stated the ceiling delta backwards once already**. **Everything else in PR-C is UNFLAGGED and lands on merge** — a code revert (`vercel promote`), not a flag flip, is the rollback for any of it (reliability M-3; the list below was completed at the re-review, finding #1): **(1)** FR-021 `status = 'active'` — an inactive / archived member's primary stops receiving; **(2)** the `.limit(5000)` removal — a >5,000 audience is refused, not silently cut; **(3)** the bridge lookups AND `setMemberHalt` throw on a failed read/write — submit 500s, dispatch retries, clear-halt 500s, instead of failing open; **(4)** self-exclusion is by MEMBER id on member-based segments only — pre-108 the sender's primary address was filtered out of EVERY segment kind, so a member who puts their own address on a custom list now receives their own e-blast (FR-022a/b; the compose hint says so); **(5)** every unsubscribe writes `marketing_unsubscribes.contact_id` — the column is in use from merge, see the Data column; **(6)** GDPR erasure now severs `member_id` AND `contact_id` on that member's suppression rows (`severMemberRefs`, FR-056) — before PR-C the `member_id` back-reference was retained; **(7)** a persisted `tier` broadcast whose `segment_params` lost its codes is a terminal `failed_to_dispatch` (before: it was sent to every active member); **(8)** the whole compose UI — live count, per-segment hints, the submit block on a measured refusal, the separate preference toast, the halt-state banner, the compose page throwing on a failed member read; **(9)** the `approved_overdue_count` gauge and the zero-fill / forget behaviour of the gauges cron; **(10)** ⚠️ **THE CEILING, STATED ONCE, AGAINST `origin/main`.** This item has now been rewritten three times and was WRONG the second time (round 2 R2-5): it promised batching, splitting, one-wave dispatch and `broadcasts_batch_no_progress_count`, all of which `ca51f59a1` **deleted on this same branch** — 42 files, both crons, the manifests repo, the retry/accept-partial routes. It also stated the delta backwards. Everything in this item before the sentence below is history; do not act on it.

**What is true.** There is no batch path and no split threshold. `currentAudienceCeiling()` is `isF7ImportAudienceEnabled() ? configuredAudienceCeiling() : min(configuredAudienceCeiling(), 500)`, and `FEATURE_F7_IMPORT_AUDIENCE` defaults **false** — which is its state at merge. So, on merge, unflagged: **the ENFORCED ceiling moves 5,000 → 500**, and an audience above 500 is REFUSED, not split.

That refusal is deliberate (`reviews/cutover.md` § 5): 501–5,000 is accepted today and *already fails silently*, because 300 s of the serial push drains ~623. The refusal replaces a silent non-delivery with a legible error and an FR-021 email. **Run `scripts/inventory-broadcast-outbox.ts` before merging** — it lists the in-flight rows this refuses, and its exit-1 message is the action list.

With `FEATURE_F7_IMPORT_AUDIENCE` ON the clamp does not apply — one import call is size-independent — so the accepted ceiling is what the flags configure: 5,000, or 50,000 once `FEATURE_CONTACT_MARKETING_RECIPIENTS` is also on.

Rollback for the ceiling change is a **code revert**, not a flag flip.

Nothing SweCham can currently compose reaches 500 (150 recipients; ~450 after the secondary import), so the practical blast radius today is zero — but that is a fact about SweCham's size, not a property of the code. | `FEATURE_CONTACT_MARKETING_RECIPIENTS=false` + redeploy — for the WIDENING only. **This cell does not restate the ceiling: item (10) owns that number, go read it.** (Round 4 D1 — this cell said "the interim clamp is gone", promised a 50,000 → 5,000 narrowing, and named five subsystems `ca51f59a1` deleted ON THIS BRANCH: the split threshold, the one-wave dispatcher, the cron partition, the retry gate, the drift halt. Item (10) two cells away already said the opposite, correctly, because the previous fix rewrote that cell and not this one. Two cells stating one number is how this row got the delta backwards twice; now one states it and the other points.) In one line for an incident: flipping this flag changes the CONFIGURED ceiling only — with `FEATURE_F7_IMPORT_AUDIENCE` off, which is its state at merge, the ENFORCED ceiling is 500 either way. | **0297 is WRITTEN from merge, flag or not**: `contact_id` is filled by every unsubscribe (`unsubscribe-recipient.ts` reads no flag). Dropping the column while PR-C's code is deployed breaks every unsubscribe with a 42703 — drop it only after a code revert, via a new migration. (0298 deferred with T086.) |

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

## Dev rehearsal before the flip

**Why bother, when the resolver is already covered by live-Neon tests?** Because prod cannot
exercise the thing the flag actually changes. It holds **150 members / 150 primaries / 0 secondary
contacts** (measured 2026-09-08), so `all_contacts` and `primary_only` resolve to the *same* 150
addresses there — flipping in prod proves the flag is wired, not that the widening works. Dev can
have secondaries. It is the only place the 1:N fan-out can be seen before SweCham's import lands.

It also removes the awkward dependency in T094's completion criterion: prod has **never had a
single broadcast** — the `broadcasts` table is empty in every status — so "observe the first send"
waits on an event with no precedent. Rehearsal ② below produces that observation on an audience
you control entirely.

> ### ⚠️ The Neon branch is isolated. The Resend account is NOT.
>
> `.env.local` and `.env.production` carry the **same `RESEND_BROADCASTS_API_KEY`** and the **same
> `BROADCASTS_FROM_EMAIL`** (`SweCham <noreply@dxtspace.com>`). A dispatch on dev therefore sends
> real mail from the production sender identity, spends the same Free-plan 1,000-contact quota and
> 3 audience slots, and any bounce lands in the **production** suppression list and on the
> production domain's reputation.
>
> So: **never seed fake addresses and then dispatch.** `scripts/seed-dev-secondary-contacts.ts`
> refuses `@example.com` and friends for exactly this reason, and refuses to invent any address at
> all — you pass ones you own. Separating the dev Resend key (or at least its sender domain) is a
> worthwhile follow-up; the Free plan allows 3 domains.

### ① Prove the widening with ZERO email sent

Everything here stops before approval, and nothing is dispatched.

> **RUN 2026-09-08 on the dev branch — the resolver half passed.** Two secondaries seeded onto an
> eligible member, then `resolveSegmentRecipients` called on both legs through the real
> `membersBridge`, the real repos and live RLS:
>
> | leg | recipients | droppedByPreference | seeded secondaries visible |
> |---|---|---|---|
> | `primary_only` | 110 | 0 | 0 / 2 |
> | `all_contacts` | **112** | 0 | **2 / 2** |
> | `all_contacts`, one seeded contact opted out | **111** | **1** | 1 / 2 |
>
> The fan-out, the per-contact opt-out drop (FR-022a) and `droppedByPreference` all behave as
> specified, and `primary_only` stays at 110 throughout — a secondary is invisible to that leg, as
> it must be. **No mail was sent**: the resolver only reads. The UI steps below (compose count,
> audience-page cross-check, submit-then-cancel) are still worth walking, and the dispatch half is
> rehearsal ②.
>
> **The run also caught a bug in the seed script itself, which is the point of rehearsing.** The
> first version picked "the first active member with a live primary" and got one with
> `broadcasts_halted_until_admin_review = true` — excluded from every segment by design. The
> seeded contacts were therefore invisible and the first measurement read
> `all_contacts = primary_only = 110`, i.e. *"the widening does not work"*. It did work; the
> fixture could not be seen. The member query now mirrors the resolver's own eligibility
> predicate. A fixture that cannot appear in the audience fails in the direction of a spurious bug
> report, which is the expensive direction.

```bash
# 1. Seed secondaries onto a real dev member. Use + sub-addresses of an inbox you own.
#    The script refuses prod (host blocklist), refuses unroutable domains, and only ever
#    inserts is_primary = false, so migration 0293's invariant is untouched.
SEED_SECONDARY_EMAILS="you+sec1@gmail.com,you+sec2@gmail.com" \
EXPORT_DOWNLOAD_TOKEN_SECRET='<any 32+ char dummy>' TENANT_SLUG=swecham \
TSX_TSCONFIG_PATH=tsconfig.scripts.json \
node --env-file=.env.local --import tsx scripts/seed-dev-secondary-contacts.ts

# 2. Turn the flag on for the dev runtime only.
#    Local: add FEATURE_CONTACT_MARKETING_RECIPIENTS=true to .env.local and restart.
#    Preview: set it in Vercel scoped to Preview, then redeploy the branch.
```

Then, signed in as a member:

1. Open compose → segment **all members**. The live count should rise by the number of secondaries
   you seeded. That number is the resolver running the `all_contacts` leg.
2. Compare against `/admin/marketing/audience?kind=secondary&state=on&eligible=1` — the same rows,
   which is SC-011 (page total = compose estimate).
3. Toggle one seeded contact's marketing preference OFF and re-check the count: it drops by one,
   and the difference is reported as `droppedByPreference`.
4. **Submit** the broadcast. This emits `broadcasts_audience_resolved_total{mode, phase="submit"}`
   — the mode flip, observed, with no mail sent (`phase` is a `'submit' | 'dispatch'` union; there
   is no count phase, so opening compose alone does not emit it).
5. **Cancel it before approval.** The state machine allows cancellation up to `approved`; nothing
   leaves.

### ② Prove the send path, to an audience of exactly you

> **RUN 2026-09-08 15:00 on dev — passed, and it moved the ceiling.** A custom-list broadcast to
> the two seeded addresses went through submit → approve → `dispatchScheduledBroadcast` against the
> real Resend gateway: audience `2ffc6ad1…`, broadcast `c4bfc0c2…`, 2 recipients, **4,063 ms**.
> Member-based was deliberately NOT used: dev holds 131 contacts on the placeholder domain
> `pending.swecham.zyncdata.app`, and dispatching to those would have produced 131 hard bounces on
> the **production** Resend reputation and suppression list. A custom list proves the gateway, the
> cron path and the send without that risk.
>
> **The 4 s for 2 recipients is what mattered.** Five Resend round trips in 4.06 s is ~0.8 s each —
> far off the 0.29 s that T095 had measured with `GET /audiences`. Fifteen serial samples of
> `POST /contacts`, the verb the push actually calls, then gave **mean 481 ms → 2.08 req/s →
> ~623 per tick → a 20 % margin of ~499**. `DELIVERABLE_RECIPIENTS_PER_TICK` was lowered **800 →
> 500**. Zero 429s across the fifteen, confirming the serial loop never approaches the 10 req/s
> policy.
>
> Two things the run also surfaced, both of them systems working: submit was refused with
> `broadcast_quota_blocked {used: 0, reserved: 1, cap: 1}` because a stale `submitted` broadcast
> from an e2e run the day before still held the member's yearly reservation (cancelled through the
> real cancel use case, which freed it); and the first opt-out attempt was refused by migration
> 0294's correlated CHECK for setting `marketing_opt_out_at` + `_source` without `_by_user_id`.


This is the only step that puts mail on the wire, and it is what closes the signals rehearsal ①
cannot reach — the real Resend gateway, the real cron under `maxDuration`, and a throughput figure
measured from `sin1` rather than from a Bangkok workstation with `GET` (the caveat T095 left open,
recorded in `research.md` § R9).

1. Make the audience **only addresses you own**. Easiest: archive or opt out every other dev member
   so the `all_members` segment resolves to your seeded contacts alone, and confirm the compose
   count says so before submitting. Verify the number, do not assume it.
2. Submit → approve → let `dispatch-scheduled` pick it up (or invoke the cron route with the
   `CRON_SECRET` bearer).
3. Watch, in order: `broadcasts_audience_resolved_total{mode="all_contacts", phase="dispatch"}` ·
   `broadcasts_marketing_opt_out_filter_count{phase="dispatch"}` present as a live series ·
   `broadcasts_dispatch_resolve_failed_total` and `broadcasts_approved_overdue_count` both 0 ·
   the outbox showing `estimated_recipient_count` = delivered.
4. **Record the throughput**: the elapsed time between the dispatch start and
   `resend.broadcasts.contacts_added` in the Vercel logs, divided by the recipient count. Put it in
   `research.md` § R9 next to the workstation figure. If it is materially below ~2.08 req/s,
   `DELIVERABLE_RECIPIENTS_PER_TICK` needs revisiting before any ceiling is raised.
5. Clean up: `SEED_SECONDARY_MODE=remove` with the same env removes only the rows the script added.

Rehearsal ② is not a prerequisite of the prod flip — at 0 secondaries the flip is a no-op on the
audience — but it is the cheapest way to learn whether the 1:N dispatch path works before
SweCham's import makes it load-bearing.

## Cutover checklist (prod)

1. PR-A, PR-B, PR-D deployed; V1 counts confirmed 0 violations before PR-B.
2. PR-C deployed with the flag OFF; the unflagged changes are the ones listed in the rollback
   matrix above (active-only narrowing, no silent cut, fail-closed reads, the compose UI) —
   **plus item (10), the Phase-9 ceiling clamp to 500, which is not a flag flip and applies in
   every flag state.**

2a. **Immediately BEFORE merging the Phase-9 branch** (not before the flip — the clamp lands on
   merge), run `scripts/inventory-broadcast-outbox.ts` against prod. Any `approved` row above 500
   becomes a terminal `failed_to_dispatch` on its next tick, with an email to the member. The
   outbox was empty at 13:30 on 2026-09-08, but that snapshot ages the moment anyone approves a
   broadcast — re-run it, do not cite it.
3. Staff run the FR-027a pre-flight review on the audience page (preset link) and switch
   off anyone who should not receive.
3a. **GDPR Art. 14 gate (staff review 🟡-3 lifted it here from
   `docs/compliance/processing-records.md:128-135`, where an operator would not have seen
   it).** The flip MUST NOT happen until EITHER the system sends a notice to a new
   secondary contact on first marketing contact, OR the FR-027a pre-flight above verifies
   the attestation per contact. A secondary who never gave their address to the chamber
   directly is a data subject the chamber has not yet informed.
3b. **Push-capacity gate (staff review 🔴) — ✅ CLOSED IN CODE 2026-09-08. No operator action.**
   `DELIVERABLE_RECIPIENTS_PER_TICK = 500` in
   `src/modules/broadcasts/domain/audience-ceiling.ts`, and the composition root now enforces
   `currentAudienceCeiling() = min(configuredAudienceCeiling(), 500)` — so compose, submit and
   dispatch all refuse above what one 300 s tick can actually push. This is option (c) of
   `reviews/pr-c.md` row 33, writable only after T095 measured the number.

   ~~The 1:N ceiling accepts up to 50,000, but the dispatch push is a serial
   one-contact-at-a-time loop at ~2 req/s inside a 300 s function budget, and
   `split-large-broadcasts` skips anything at or below 10,000 — so a broadcast in that band
   is accepted and then never delivered. Before flipping, land ONE of: the import build
   (T086/T087/T106); a lowered `SPLIT_THRESHOLD_RECIPIENTS` plus a wall-clock budget with
   resume; or an explicit submit-time refusal. At SweCham's ~150 members × 3 contacts this is
   ~225 s against 300 s — no margin.~~

   **Two corrections in the struck text, both worth carrying forward.** The rate was wrong:
   T095 measured the account limit at **10 req/s** (`ratelimit-policy: 10;w=1`, read from the
   API), but the serial loop only reaches `min(limit, 1/RTT)` and the warm round trip is
   ~0.481 s — so ~**2.08 req/s**, latency-bound. And the band was wrong: at 2.08 req/s it starts
   near **830**, which is *below* the 5,000 ceiling enforced with the flag OFF — so this was
   never "the 5,001–10,000 slice the flip adds", and the fix was worth shipping regardless of
   the flip. SweCham's post-import ~450 contacts push in ~132 s of the 300 s budget.
   (Detail: `research.md` § R9 T095 block; `reviews/cutover.md` § 5 / § 5a.)
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
