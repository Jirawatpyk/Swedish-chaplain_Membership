# Phase 0 Research — 108 Contact Recipient Rules

**Status**: No open `NEEDS CLARIFICATION`. Product decisions were settled in the spec's three
clarification sessions (2026-09-04). This file resolves the *engineering* unknowns in
Decision / Rationale / Alternatives form and pins the repo facts each decision depends on.
Facts were gathered by four read-only code walks on 2026-09-04 (invoicing/payments recipient
plumbing; members module; broadcasts resolver; RBAC/nav/table patterns) and spot-verified.

Three items are **verify-before-task** (not clarifications — the decision is made, the
operator confirms a fact first): V1 prod count of secondary contacts and of active members
with zero primaries — **DONE 2026-09-04 (read-only, tenant `swecham`)**: 150 live contacts, all
primary, **0 secondary contacts**, 0 secondaries with portal login; invariant check
`status <> 'archived' AND erased_at IS NULL` → **0 members with zero primaries, 0 with more
than one** (PR-B's pre-check will pass); members: 110 `active`, 40 `inactive`, 0 archived,
0 erased; `marketing_unsubscribes`: 0 rows. Consequences: the FR-027a pre-flight list will be
empty until Tier C import or manual adds (Q2 cutover risk is nil today), and FR-021's
active-only rule removes the 40 inactive members' primaries from the audience (~27 % of
today's recipients) — decision Q1 = A stands, now with the number known. V2 the Resend
**Contacts Import API** on the test account — multipart
shape accepted by a raw `fetch` from the current SDK-4.8 codebase, the status values of
`GET /contacts/imports/{id}` (only `completed` is documented), the `counts` fields, and that
`on_conflict: upsert` never touches a contact's Resend-side `unsubscribed` flag when the CSV
carries no such column; V3 whether `scripts/lib/enum-migration-guard.ts` accepts several
`ADD VALUE` statements in one file — **DONE 2026-09-04 (code read, no DB needed)**: YES.
`ALTER_TYPE_ADD_VALUE_RE` is a `/g` regex and `extractAlterTypeAddValueStatements` returns
**every** match (`sql.match(re)` → array), which `run-migrations.ts` replays one by one in
autocommit before the transactional pass. The header's "single" describes what the regex
matches per capture, not a per-file limit. Consequence: migration **0295 stays one file**
with both `ADD VALUE` statements; each statement must be on its own and end with `;`, and
must not sit on a `--` comment line (those are stripped);
V4 (superseded by the V2 redesign — no recipient working table is planned; keep only if V2
shows the import id + counts cannot live on the `broadcasts` row); V6 (PR-A security review, PCI F-5) — whether a browser-side
`stripe.retrievePaymentIntent(clientSecret)` can surface
`payment_method_data.billing_details.email`, which since 108 is a DIFFERENT person's
address than the payer's on a PromptPay PI. My reading is that it cannot (client-side
retrieval returns a publishable-key-scoped PI with `payment_method` unexpanded), but it
is not settleable from source: initiate a PromptPay payment in test mode, call it in the
console, and grep the result. Also eyeball Stripe's hosted PromptPay instructions page.
V5 the team's actual Resend
rate limit (~~Settings → Usage~~ — **MEASURED 2026-09-08 from the API's own `ratelimit-*` headers: 10 req/s confirmed, but the serial loop is latency-bound at ~3.4 req/s; see the T095 block in R9**) and
whether the Audiences → Segments / Global Contacts migration has a deprecation date that
affects F7's `audienceId`-based gateway (R16).

---

## R1 — Money emails: resolve the recipient live through the existing `RecipientLocalePort`

- **Decision**: Widen `src/modules/invoicing/application/ports/recipient-locale-port.ts`
  with one **required** method, `getMemberEmailRecipient(tx, tenantId, memberId) →
  { email: string; locale: F4OutboxLocale | null } | null`, implemented by the existing
  `recipient-locale-adapter.ts` (one SQL read of the live primary contact,
  `is_primary = true AND removed_at IS NULL`). A shared helper
  `resolveMoneyRecipient(port, tx, tenantId, memberId, snapshot)` in
  `application/lib/` returns `{ kind: 'member', email, locale }` for member invoices
  (live primary), `{ kind: 'non_member', email: snapshot.primary_contact_email }` when
  `memberId === null` (event buyers, admin-typed), or `{ kind: 'no_recipient' }`. The four
  use cases (`record-payment`, `void-invoice`, `issue-credit-note`, `resend-pdf`) call it
  instead of reading `memberIdentitySnapshot.primary_contact_email`; the
  `receiptPdfRenderEnqueue` sentinel and `receipt-pdf-reconcile` sentinel keep the
  sentinel (render jobs, not emails).
- **Rationale**: R-A found this port is already a *live* primary-contact read wired into
  all four deps (`RecordPaymentDeps:252`, `VoidInvoiceDeps:183`,
  `IssueCreditNoteDeps:346`, `ResendPdfDeps:147`) and its adapter already handles the
  `tx === null` resend case via `runInTenant`. Adding a second port or a new deps field
  would touch the same 47 test files for no gain. Locale and email come from the same
  row, so one read replaces two.
- **Alternatives**: (a) rewrite `member_identity_snapshot` on promote — rejected, it is
  the tax document's buyer identity (FR-002, spec 007 FR-038); (b) an optional method with
  a snapshot fallback — rejected, a fake lacking the method would silently exercise the old
  behaviour (memory: *port method → stale test stub silent*); (c) resolving in the outbox
  dispatcher at send time — rejected, the dispatcher is shared by F1/F3/F7 and sends
  `row.toEmail` verbatim by design; queued rows stay immutable (spec edge case accepted).
- **Blast radius (pinned)**: `RecordPaymentDeps` in 31 test files, `IssueCreditNoteDeps` 14,
  `VoidInvoiceDeps` 6, `ResendPdfDeps` 1 (`barrel-exports.test.ts`). Object-literal fakes
  fail typecheck (good); fakes built via `as unknown as` or spreads do not — tasks MUST run
  the whole `tests/unit/invoicing` + `tests/integration/invoicing` suites and introduce one
  shared fake in `tests/helpers/` so the port has a single test double.
- **Guards to add in the same change**: `void-invoice.ts:486` (no empty-recipient guard)
  and `resend-pdf.ts:418-419` credit-note arm (no guard) → route through the helper's
  `no_recipient` branch. `member-identity-adapter.ts:159-169` and
  `recipient-locale-adapter.ts:35-40` gain `removed_at IS NULL` (FR-009).
- **Verified facts**: outbox `to_email text NOT NULL` (auth `schema.ts:978`); enqueue port
  `EmailOutboxPort.enqueue(tx, { recipientEmail, recipientLocale?, … })`
  (`email-outbox-port.ts:26-106`); `autoEmailSkipped` is a metric only (`metrics.ts:711`),
  no audit event exists for a skipped send.

## R2 — "No recipient" becomes visible: audit event + live warning, no new persisted state

- **Decision**: Add F4 audit event `auto_email_skipped_no_recipient` (**10-year** retention
  — CORRECTED at the PR-A security review from the 5y first shipped: the row records that a
  §86/4 / §86/10 document was never delivered, and every document event it can refer to is
  10y. Keeping "sent" for ten years and "never sent" for five is an asymmetry that always
  favours us,
  payload `{ invoice_id | credit_note_id, event_type, member_id }`, no email) emitted at the
  helper's `no_recipient` branch inside the same tx (throw-to-rollback like the existing
  emits). The invoice detail page and the member detail page compute the warning **live**
  ("this member has no primary contact — payment emails are not being sent") from the
  contact list; no column is added. Admin resend from the invoice page is the retry path
  (FR-003).
- **Rationale**: The invariant (R4) makes this state reachable only for erased members
  (excluded anyway) and pre-existing bad rows; a persisted flag would need its own
  lifecycle. The audit row is the durable record; the live banner costs one existing
  query. `EmailDispatchOutcome` already carries `skipped_no_email`.
- **Alternatives**: persist `last_email_skip_reason` on invoices — rejected (YAGNI, second
  source of truth); block invoice issuance when no primary — rejected (auto-invoice cron
  would fail closed on an already-guarded state; spec chose warn + skip).

## R3 — Payment processor gets the primary contact's email via a payments-side port

- **Decision**: New Application port in payments,
  `BillingRecipientPort { getPrimaryContactEmail(tenantId, memberId): Promise<string | null> }`,
  implemented in `src/modules/payments/infrastructure/` by calling the members barrel
  (`getMemberPrimaryContact`, exported at `src/modules/members/index.ts:476`). Added to
  `InitiatePaymentDeps` and wired in `payments/infrastructure/di.ts:113`.
  `InitiatePaymentInput.actorEmail` is **removed**; the use case resolves the billing email
  itself. If null and the method is PromptPay → typed permanent error
  `primary_contact_missing` (409 at the route) — Stripe rejects PromptPay without
  `billing_details.email` anyway. Card flow unchanged (no email shared).
- **Rationale**: R-A confirmed payments has no members bridge and `actorEmail` is consumed
  at exactly one site (`initiate-payment.ts:633` → `stripe-gateway.ts:392`). Cross-module
  via the public barrel is the sanctioned pattern (Principle III). Removing the input field
  makes the old behaviour unrepresentable rather than merely unused.
- **Alternatives**: resolve in the route from `requireMemberContext` — rejected, the
  context exposes only the caller's own contact (`member-context.ts:35`) and Presentation
  would be doing Application work; extend `InvoicingBridgePort` — rejected, invoicing does
  not own contacts.

## R4 — Exactly-one primary: app guard + DB constraint trigger (defence in depth)

- **Decision**: Three layers. (1) `removeInTx` adds `AND is_primary = false` and returns
  `repo.conflict{reason:'cannot_remove_primary'}` on zero rows where the row exists; the
  `SET is_primary = false` is dropped so the existing CHECK `contacts_primary_not_removed`
  becomes reachable again. (2) New `ContactRepo.listByMemberInTx(tx, memberId)`; the
  mutating use cases (`removeContact`, `promotePrimary`, `addContact`, `undeleteMember`)
  call `assertPrimaryContactInvariant` on the post-mutation list **inside the tx** and
  abort on violation (wires the dead domain policy). (3) Migration adds a
  `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `contacts` (UPDATE/DELETE) and on
  `members` (UPDATE OF status, erased_at) that, at commit, raises if a member with
  `status <> 'archived' AND erased_at IS NULL` has ≠ 1 live primary. Migration pre-check:
  `SELECT count(*)` of violating members; **raise** (fail the deploy) if > 0, printing counts
  only. `DROP TRIGGER IF EXISTS` precedes each `CREATE TRIGGER` (#336 lesson).
- **Rationale**: Constitution IX solo-maintainer substitute item 4 requires DB-level
  defence for invariants expressible below the app. Deferred evaluation is what makes
  demote-then-promote (`promotePrimaryInTx:471-496`) and erasure (scrub + `erased_at`
  co-commit in one tx — verified `erase-member.ts:358-530`) pass, while the promote/remove
  race and a bad unarchive fail at commit.
- **Alternatives**: `SELECT … FOR UPDATE` on the member row in every contact mutation —
  rejected (memory: *FOR NO KEY UPDATE FK-child deadlock*; the deferred trigger needs no
  row lock); advisory lock per member — considered, but it serialises without proving the
  end state; app-only fix — rejected by IX.4.
- **Verify-before-task**: V1 (prod count of active, non-erased members with zero live
  primaries) MUST be 0 before the migration PR merges, because prod migrates on deploy and
  the pre-check fails the build by design.
- **V1 re-run, and the scope correction it forced (2026-09-05).** V1 checks the tenant
  `swecham`. The pre-check DO block has **no tenant filter** — it scans the whole branch —
  so a `swecham`-only inventory cannot answer "will the migration apply?". Measured on the
  shared `dev` branch: **87 tenants / 411 non-archived, non-erased members**, of which
  **72 `test-*` tenants hold 150 violating members**. Classified by shape, **all 150 have
  zero contact rows** (`live_primaries = 0`, `any_contacts = 0`); **no member that has
  contacts violates the invariant**, on any tenant. `swecham` on dev: 131 members, 0
  violations. Prod: 150 members, 0 violations.
- **Why that changed the design rather than the data.** `integration-smoke.yml` is a
  REQUIRED check on `main` and runs against a **single persistent CI Neon branch**
  (`CI_DATABASE_URL`) that accumulates `test-*` tenants the same way `dev` does and that
  cannot be inspected or cleaned from a PR. The pre-check as first written would raise
  there, so PR-B could not merge — cleaning `dev` would not help, and neither would
  repairing the 58 integration fixtures that seed contact-less members. Hence the spec
  AMENDMENT at FR-010/FR-010a: the DB-level guarantee and its pre-check are scoped to
  members with `EXISTS (any contact row)`. `preview/*` branches are copy-on-write **from
  prod** (`docs/runbooks/db-environment-branching.md` § 3), so they are clean under either
  reading and were never the constraint.
- **The pre-check is not vacuous.** The migration role on Neon is `neondb_owner` with
  `rolbypassrls = true`, so the DO block reads every tenant's rows even though `members`
  and `contacts` are RLS ENABLE + FORCE and no `app.current_tenant` GUC is set. Verified by
  counting rows with the GUC unset (424 members visible). T031 pins this with a positive
  control: seed a violation, expect the DO block to raise.

## R5 — Unarchive designates a primary in the same transaction

- **Decision**: `UndeleteMemberDeps` gains `contactRepo`; `UndeleteMemberInput` gains
  `designatePrimaryContactId?: ContactId`. In-tx: if the member has a live primary → proceed;
  else if `designatePrimaryContactId` names a live non-removed contact of this member →
  set `is_primary = true` (+ `member_primary_contact_changed` audit with
  `old_primary_contact_id: null`) then proceed; else abort with
  `state_error{code:'no_primary_contact'}` → 409 carrying the list of designatable contacts.
  UI: the archived banner, on 409, opens a small dialog listing the member's live contacts
  (radio) with a "Restore and set as primary" action; with zero contacts it links to
  "Add contact" first (the existing add dialog; the new contact then appears as a choice).
- **Rationale**: R-B: unarchive never looks at contacts today; archive never demotes.
  A member can only reach "archived + zero primaries" via the race (closed by R4) or legacy
  rows, so the dialog is rarely shown but must exist for FR-014. Reusing add-contact avoids
  a new "create as primary" path (`addContact` hardcodes `isPrimary:false`).
- **Alternatives**: auto-pick the first remaining contact — rejected (silent choice of who
  receives money emails); block unarchive with no remedy — rejected (dead end).

## R6 — Permission model: `contacts.marketing` for the toggle; `contacts.read` finally gets its surface

- **Decision**: New catalogue key `contacts.marketing` (`sensitive: 'pii'`), added to
  `MARKETING_KEYS` (admin/super_admin inherit automatically). Pinned matrix row
  `row('contacts.marketing', admin=true, manager=false, marketing=true)`. The **toggle
  routes** gate on `contacts.marketing`. The **Marketing audience page** gates on
  `contacts.read` — the key the catalogue reserves for "a dedicated contacts surface"
  (`permission-catalogue.ts:37-43`); manager therefore gets the read-only view FR-034
  already implies, and the reserved-note debt is closed. The page renders the switch only
  when `canPerform(role, 'contacts.marketing')`.
- **Rationale**: R-D: marketing is fenced off from contact PII by test T057
  (`role-bundles.test.ts:176-186`); a separate key keeps that fence while granting the
  audience action. Gating the page on `contacts.read` follows the catalogue's own written
  instruction and avoids inventing a second read key.
- **Pins that move (from commit `d09be0199`, the last key-add)**: catalogue length 41→42
  (`permission-catalogue.test.ts:34`), evaluator sizes admin 35→36 / marketing 9→10 and the
  `it()` title (`evaluator.test.ts:96,100-104`), `tests/helpers/rbac-pinned-matrix.ts`,
  `tests/helpers/rbac-observed-baseline.ts` (page row + api rows, one-line literals),
  `role-endpoint-matrix.test.ts:33` pages 46→47, nav parity `STAFF_ITEMS` 16→17 and the
  frozen manager/marketing href lists (`nav-permission-parity.test.ts:70,213-223`),
  `rbac-navigation.spec.ts` MUST_NOT_SEE lists, breadcrumb keys. No i18n for keys.
- **Alternatives**: page on `contacts.marketing` only — rejected (leaves the reserved note
  open, hides the view from manager); widen `contacts.write` to marketing — rejected (PII
  edit capability, T057).

## R7 — Per-contact marketing state lives on `contacts`, not in the suppression list

- **Decision**: Migration `0294` (ships with PR-D) adds to `contacts`: `marketing_opt_out_at timestamptz NULL`,
  `marketing_opt_out_source text NULL CHECK (marketing_opt_out_source IN ('staff','self'))`,
  `marketing_opt_out_by_user_id uuid NULL`, with CHECK "all three null or all three set", and
  partial index `contacts_marketing_recipients_idx (tenant_id, member_id, contact_id)
  WHERE removed_at IS NULL AND marketing_opt_out_at IS NULL`. NULL = receives (FR-027, no
  backfill). Personal unsubscribe stays in `marketing_unsubscribes` and always wins
  (FR-025); the two are never merged.
- **Rationale**: Reversible staff/self states with attribution vs. an irreversible,
  reason-ranked, never-deleted suppression row are different lifecycles. The suppression
  port's docstring says rows are never deleted and `ON CONFLICT` applies reason precedence
  (`drizzle-marketing-unsubscribes-repo.ts:67-119`); "switch back on" would need a DELETE
  or a rank-lowering write there — both violate its contract.
- **Alternatives considered and rejected**: reuse `marketing_unsubscribes` with reason
  `admin_added` for staff opt-out (R-D suggestion) — rejected for the lifecycle reasons
  above and because a self opt-out would then be indistinguishable from an unsubscribe in
  the GDPR record; opt-in flag default FALSE (F7.1b backlog US3) — rejected by spec Q2/D3
  (needs a chunked backfill and inverts the SweCham default).
- **Six-place column checklist (R-B)**: `schema-contacts.ts`, `domain/contact.ts`,
  `drizzle-contact-repo.ts:rowToContact`, `src/app/api/members/_serialise.ts`,
  `src/app/api/portal/profile/route.ts` (its own serialiser), and the SCRUBBED/KEPT
  partition in `tests/unit/members/infrastructure/scrub-contacts-pii-column-coverage.test.ts`
  (classify all three as KEPT: not PII, irrelevant after erasure). `ContactPatch` is not
  widened; a dedicated repo method `setMarketingOptOutInTx` is added.
- **Members ↔ broadcasts**: the toggle use case must refuse "on" for a suppressed address.
  It takes a members Application port `MarketingSuppressionLookupPort
  { isSuppressed(tenantId, emailLower) }`; the adapter lives in
  **`src/lib/contact-marketing-deps.ts`** (composition layer), calling the broadcasts barrel
  `makeDrizzleMarketingUnsubscribesRepo(tenant).lookupBatch`. Putting it in
  `members-deps.ts` would create a members↔broadcasts barrel cycle (broadcasts already
  imports the members barrel at `members-bridge.ts:23-35`) — the 066 barrel-cycle class.

## R8 — Broadcast audience: 1:N contacts, `status = 'active'`, keyset pagination, no silent truncation

- **Decision**: New F3 repo method `findBroadcastRecipientContacts(ctx, { segmentType,
  tierCodes?, after?: { memberId, contactId }, limit })` — `members LEFT JOIN contacts ON
  member_id AND removed_at IS NULL AND marketing_opt_out_at IS NULL`, WHERE `status =
  'active' AND erased_at IS NULL AND broadcasts_halted_until_admin_review = false` (+ tier),
  ordered by `(member_id, contact_id)`, page size 5,000 (T081 raised it from 1,000: 20,000 contacts at 1,000-row pages were 42 round trips, 9–11 s from a ~220 ms-RTT workstation against FR-043 — the walk is latency-bound), **no `.limit(5000)`**. Rows carry
  `{ memberId, contactId | null, emailLower | null, isPrimary }`; a null contact marks an
  orphan member (FR-029). The broadcasts `MembersBridgePort` gains
  `getContactsBySegment(tenant, kind, params) → ContactRecipient[]` which loops pages until
  exhausted and **propagates repo errors** (today `members-bridge.ts:88` returns `[]` on
  error — a second silent-truncation vector under pagination). `resolveSegmentRecipients`
  works on `{ memberId, contactId, emailLower }` candidates: self-exclusion by
  `memberId === requestingMemberId` (input gains `requestingMemberId`; the email-equality
  arm is removed), dedupe by email, suppression `lookupBatch` in chunks of 5,000, then the
  ceiling. `tick-memoized-members-bridge` memoises the new method by
  `(tenant, kind, params)` like the old one.
- **Split by flag** (see R10): the `status = 'active'` predicate ships **unflagged** (it only
  narrows and closes the archived leak, FR-021/SC-009); the 1:N fan-out, the new ceiling and
  the custom-list drop ship behind `FEATURE_CONTACT_MARKETING_RECIPIENTS`, passed into the
  resolver as `deps.audienceMode: 'primary_only' | 'all_contacts'` (Domain stays pure).
- **Rationale**: R-C pinned the 1:1 join at `drizzle-member-repo.ts:1333-1340`, the
  truncation at `:1358`, the missing status filter at `:1349-1357`, and the email-equality
  self-exclusion at `resolve-segment-recipients.ts:105-109`. Contacts' email is unique per
  tenant among live rows, so email dedupe is exact.
- **Alternatives**: keep `.limit(N)` with a larger N — rejected (still silent); resolve in
  the DB with `COUNT(*) OVER()` and a single page — rejected (a 50,000-row result in one
  round trip on the submit path).

## R9 — One audience ceiling, and the Resend push must be resumable

> **DEFERRED out of PR-C (2026-09-07)** — see the spec AMENDMENT under User
> Story 5: the import-based build ships in a follow-up PR with T110, after a
> probe confirms the audience-id / segment-id relationship and the import
> `status` values. PR-C keeps the bounded per-contact push.

- **Decision**: `src/modules/broadcasts/domain/audience-ceiling.ts` exports
  `audienceCeiling(batchingEnabled: boolean): number` = 5,000 | 50,000 (matches the DB
  CHECK `broadcasts_estimated_recipient_cap` and `MAX_RECIPIENT_COUNT`). **Review H-2
  (2026-09-07)**: the composition root passes `isF71aUs1Enabled() &&
  FEATURE_CONTACT_MARKETING_RECIPIENTS` — 50,000 needs BOTH flags, because the wide ceiling
  was raised for the 1:N audience and prod already has batching ON. The number goes into
  `ResolveSegmentDeps.audienceCeiling`; the resolver's old `AUDIENCE_HARD_CAP` is deleted
  (T085) and the submit and dispatch checks all read that one value;
  `split-large-broadcasts` keeps its 10,000 threshold *below* the
  ceiling so audiences 5,001–50,000 are reachable through the batch path (today
  `AUDIENCE_HARD_CAP = 5000` makes the split path unreachable — R-C §4). The compose-page
  `estimateNote` copy (hardcoded "capped at 5,000" in EN/TH/SV, `en.json:5667`) is
  rewritten to interpolate the ceiling and to add the mandated self-exclusion hint.
- **The discovered blocker (corrected 2026-09-04 after checking Resend's docs)**: the
  single-audience push is a **serial per-contact loop** (`resend-broadcasts-gateway.ts:246-256`)
  inside a route with `maxDuration = 300` (verified on both dispatch routes). The code comment
  claims "2 req/s, no bulk endpoint"; both claims are **stale**. Resend's current docs
  (`api-reference/rate-limit`, `knowledge-base/account-quotas-and-limits`) state a default of
  **10 requests/second per team** (all keys), raisable through support, with `ratelimit-*` and
  `retry-after` headers on 429 — and Resend now offers a **Contacts Import API**
  (`POST /contacts/imports`, multipart CSV ≤ 200 MB, `column_map`, `on_conflict: upsert|skip`,
  async: returns `{ object:'contact_import', id }`; `GET /contacts/imports/{id}` returns
  `status` + `counts { total, created, updated, skipped, failed }`). Even at 10 req/s the
  serial loop needs ~500 s for 5,000 contacts, so the loop cannot stay; the import API removes
  the problem instead of pacing it.

> **T095 — MEASURED 2026-09-08 12:41 (Asia/Bangkok). The limit is real; it is also not the
> binding constraint.** Five `GET /audiences` calls against the production
> `RESEND_BROADCASTS_API_KEY`, keep-alive on one connection, from the maintainer's Bangkok
> workstation:
>
> ```
> ratelimit-policy: 10;w=1   ratelimit-limit: 10   (200 OK on every call)
> req0 (cold)  dns=4ms  tcp=8.5ms  tls=37ms  total=333ms
> req1..req4   (keep-alive)                  total=285 / 281 / 300 / 291 ms
> ```
>
> So the account limit is **10 req/s, confirmed from the API's own headers** — the paragraph
> above is right and `resend-broadcasts-gateway.ts`'s "2 req/s" comment is wrong. But
> `addContactsToAudience` is a **serial `await` loop**, so its throughput is
> `min(account_limit, 1 / RTT)` and the warm RTT is **~0.29 s**:
>
> ```
> throughput   = min(10, 1/0.29)  ≈  3.4 req/s      ← from GET /audiences — SUPERSEDED, see below
> per_tick_max = 300 s × 3.4 × 0.8 ≈ 830 contacts   (20 % margin)                 ← SUPERSEDED
> ```
>
> ### CORRECTED 2026-09-08 15:00 — the verb was wrong, and this is the CANONICAL derivation
>
> The sample above used `GET /audiences` because nothing had ever been dispatched and a read was
> the only probe available. Rehearsal ② (`quickstart.md` § Dev rehearsal) then dispatched a real
> broadcast, and **15 serial samples of `POST /contacts` — the verb `addContactsToAudience`
> actually calls —** came back at:
>
> ```
> mean 481 ms   median 420 ms   p95 894 ms   min 380 ms   zero 429s across all 15
> throughput   = min(10, 1/0.481)  ≈  2.08 req/s     ← latency-bound; writes ~1.7× slower than reads
> one tick     = 300 s × 2.08       ≈  623 contacts
> per_tick_max = 623 × 0.8          ≈  499  →  DELIVERABLE_RECIPIENTS_PER_TICK = 500
> ```
>
> Mean is the statistic (a serial loop of N requests takes N × mean, not N × p95). Caveat 2
> below — "GET latency, not POST" — turned out to be worth ~300 recipients. **Every other file
> that states this number (`domain/audience-ceiling.ts`, its unit test, `reviews/cutover.md`
> § 5a, `tasks.md` Phase 9b) cites THIS block; do not restate the arithmetic elsewhere, point
> here** (analyze 2026-09-08 D1 — five restatements had drifted by rounding and one was wrong).
>
> **Using the documented 10 req/s as a capacity input overestimates by ~5×.** The undeliverable
> band therefore starts near **~623 recipients**, not at the 5,001 the review reasoned about —
> i.e. **well below the 5,000 ceiling enforced before the clamp**, so the exposure predates the
> 108 flag exactly as `plan.md:268` claimed. The year-old "~2 req/s" comment was right about the
> effect and wrong only about the cause (it read as an account cap; the account allows 10).
>
> Three caveats, all of which push the true number DOWN, not up:
> 1. Measured from a Bangkok workstation, not from Vercel `sin1`. Re-check on the first real send.
> 2. `GET /audiences` is a read; the loop calls `POST /contacts`, a write. This is a lower bound
>    on latency and therefore an upper bound on throughput.
> 3. Four warm samples (281–300 ms, tight), one cold. Handshake is only ~37 ms, so connection
>    reuse is not the lever — the ~285 ms is the server round trip itself.
>
> One thing this settles cheerfully: at 2.08 req/s the loop never approaches the 10 req/s policy
> (zero 429s in 15 consecutive writes), so `withRetry`'s reactive 429 backoff never fires on the
> serial `dispatch-scheduled` path. It DOES fire on `dispatch-batches`, where `batch-dispatcher.ts`
> runs up to `concurrencyCap` (default 4) serial loops in parallel — 4 × 2.08 ≈ 8.3 req/s fits,
> 8 × 2.08 ≈ 16.6 does not (`MAX_CONCURRENCY_CAP = 8` exceeds the policy at this batch size).
>
> **SweCham today** (measured 2026-09-08: 150 primaries, 0 secondaries): 150 ÷ 2.08 ≈ **72 s** of
> a 300 s budget — 24 %. **Post-import** (~150 members × 3 contacts ≈ 450): ≈ **216 s**, 72 %.
> Both fit under 500, the second with little room. The gap is between ~623 and whatever ceiling
> is enforced — closed by the clamp, and reopened as the batch size by Phase 9b.
>
> ### V2 — the Contacts Import API on the live account (ANSWERED 2026-09-08, except one clause)
>
> Probed before writing any of T086/T087, because one clause could have made the design
> illegal rather than merely wrong. Synthetic `@example.com` addresses, throwaway audiences,
> no broadcast created, everything deleted after.
>
> **(a) Does `on_conflict=upsert` clear a contact's `unsubscribed` flag when the CSV carries
> no such column? → NO. SAFE.** Measured directly: import → `PATCH .../contacts/{id}
> {unsubscribed:true}` → re-import the same address with an email-only CSV → read back →
> `unsubscribed` is still `true`, and the import reports `updated: 1` (so it DID touch the
> row and still left the flag alone). `upsert` is therefore usable as designed. This was the
> gating question: had it cleared the flag, every import would have silently resurrected
> people who pressed unsubscribe (GDPR Art. 21 / PDPA § 32).
>
> **(b) Does an import attach a contact that already exists GLOBALLY but not in the target
> audience? → YES, and the suppression carries across.** A fresh audience B, importing an
> address that already existed account-wide, reports `updated: 1` and the address appears in
> B — **still `unsubscribed: true`**. Resend's suppression is account-wide, not per-audience.
> Useful, because every dispatch builds a NEW ephemeral audience: an unsubscribe from one
> broadcast protects the next one for free. **It does not make Resend the source of truth** —
> a member who opts out in our portal without clicking Resend's link is suppressed on OUR side
> only, so the CSV must still be built from the resolver, which applies `marketing_unsubscribes`
> and the PR-D opt-out filter. Resend's flag is defence in depth, one layer below ours.
>
> **(c) `status: completed` with `failed: 0` DOES NOT MEAN THE ROWS LANDED.** One import out
> of five, same code and same shape as the others, returned
> `{status: "completed", counts: {total: 0, created: 0, updated: 0, skipped: 0, failed: 0}}`
> and attached nothing. Three deliberate repeats afterwards (one with a 1.5 s delay after
> audience creation) all reported `total: 1` — so it is **not reproducible on demand, which
> makes it worse, not better**. Consequence: the contract § 4 completion rule
> (`total === resolvedCount`) is **load-bearing, not defensive**, and "completed with zero
> rows → do NOT send" is the first RED case T087 must carry, not an edge case appended later.
>
> **(d) The Free plan's 3-audience cap is REAL and `POST /audiences` FAILS at it.** Found by
> accident: with `General` plus two throwaway audiences live, creating a third returned no id.
> Every dispatch creates one ephemeral audience, so on Free at most **two** broadcasts can be
> in flight until `cleanup-audiences` reaps (grace 1 h, cron every 15 min).
>
> **(e) UNRESOLVED — whether the 1,000-contact cap counts GLOBAL contacts.** The probe read
> `GET /contacts` before and after and got **20 both times, and 20 again after cleanup**. 20 is
> the default page size, not a total: the call measured a page, not the account. **This
> answers nothing** and is recorded as unanswered rather than as "no change" — the same class
> as V4's earlier false negative. It matters because if the cap is global, reaping audiences
> frees no slots and a Free account fills permanently at ~1,000 distinct addresses ever mailed,
> which is a different operator story from "1,000 in flight". Resolve with the account's own
> usage page or a paginated count before promising an operator either reading.
>
> ### V4 — does the Contacts Import API attach contacts to the target audience? **YES** (T145, ANSWERED 2026-09-08)
>
> **It attaches. The two earlier "no" probes were measuring a typo.** They sent the field as
> `audience_id`; contract § 4 said `segments=[<audience id>]`; the API wants
> **`segments=[{ "id": "<uuid>" }]`** — an array of OBJECTS. So all three spellings were
> different, and the two that were tried were the two that do not work.
>
> Measured, one throwaway audience and one synthetic `@example.com` row, deleted after:
>
> | Field sent | Answer |
> |---|---|
> | `audience_id=<uuid>` (probes 1–2) | 201, import completes, contacts land in **Global Contacts only** — the field is ignored, not rejected |
> | `segments=["<uuid>"]` (contract § 4's shape) | **422** `validation_error` — *"The `segments` must be an array of objects with a UUID `id` field."* |
> | `segments=[{"id":"<uuid>"}]` | **201 in 412 ms** → `status: completed` in ~306 ms, `counts {total:1, created:1, updated:0, skipped:0, failed:0}` → `GET /audiences/{id}/contacts` returns **count = 1** ✅ |
>
> The 422 is the useful half of the finding: `audience_id` fails SILENTLY (accepted, ignored),
> which is exactly how two probes reached a confident wrong conclusion, while the wrong
> `segments` shape fails LOUDLY. Contract § 4 has been corrected to the object form.
>
> **What this changes.** The import build (T086 / T087 / T106) is now known to be a ~2-call,
> size-independent push: one `POST /contacts/imports`, then poll. It does not care whether the
> audience is 500 or 50,000, so it retires batch SIZING as the scaling mechanism — Phase 9b's
> batches become an implementation detail rather than the bound. It also supersedes the reason
> `data-model.md` § 2.5's working table was being held as a fallback for the *push*; the table is
> still the answer for FR-044 (a)/(d) **list freezing**, which is a different problem (the batch
> path re-resolves between ticks — see Phase 9b T143's drift halt, the interim guard).
>
> Not yet known, and needed before building on this: whether the import respects the Free plan's
> 1,000-contact cap the same way the serial push does (the addendum below), what it answers when
> the CSV exceeds it, and whether `on_conflict=upsert` re-attaches a contact that already exists
> globally but is not in the target audience. Those are T086's questions, not T145's.
>
> ### T095 addendum — the account is on Resend's **FREE** plan, and that binds first
>
> Confirmed from the Resend billing + usage pages, 2026-09-08:
>
> | Free-plan limit | Value | In use now |
> |---|---|---|
> | **Contacts** | **1,000** | 13 |
> | **Segments** (= Audiences) | **3** | 1 (`General`, id `e367de00…`) |
> | Domains | 3 | — |
> | Broadcast sending | unlimited | — |
>
> **1. The 1,000-contact cap is a harder bound than the wall clock, and it arrives first.** Every
> dispatch pushes the whole resolved audience into a Resend audience, so a broadcast above roughly
> **987** recipients (1,000 − the 13 already stored) hits the cap mid-push. Resend answers 4xx —
> not 429 — so `classifyResendError` returns `permanent`
> (`resend-broadcasts-gateway.ts:12,158`), and `dispatch-scheduled-broadcast.ts:21-22` transitions
> the broadcast to `failed_to_dispatch` with an audit event. **That is the good failure mode**: it
> fails loudly and terminally in one tick instead of sitting in `approved` being killed mid-push
> forever. The wall-clock bound (~623) and the plan bound (~987) land within ~40 % of each other by
> coincidence; both say the same thing about where the safe ceiling is.
>
> **2. Three segments means at most THREE audiences can exist at once — and one is already taken.**
> Chamber-OS creates an ephemeral audience per broadcast and lets the `cleanup-audiences` cron
> (`*/15`) delete it once the broadcast is terminal. With `General` occupying a slot, **two
> concurrent in-flight broadcasts is the real limit**; a third fails until the cron frees room.
> This is the "transient plan-segment-limit overflow surfaces as a `failed_to_dispatch`" already
> noted in `go-live-readiness.md` § 6.6 — on the Free plan the number behind that sentence is 2.
>
> **3. Upgrading does not fix the push.** Pro marketing ($40/mo) raises contacts to 5,000 — which
> happens to equal the app's flag-OFF ceiling — and segments to unlimited. It does **not** change
> latency, so the ~2.08 req/s and the ~623-per-tick bound survive the upgrade unchanged. Money buys
> the contact cap, not the wall clock.
>
> **Consequence for the enforced ceiling**: the app currently accepts up to 5,000 (50,000 after the
> 108 flip) while the provider account can physically hold 1,000. Nothing SweCham can compose today
> reaches either — 150 now, ~450 post-import — but the configured ceiling is 5× to 50× larger than
> what the account can accept, and that mismatch is invisible until a send fails.
- **Decision (push)**: build the provider audience with **one import per broadcast**: the first
  `dispatch-scheduled` tick resolves the audience, renders a CSV (`email` column only — never an
  `unsubscribed` column, so the upsert cannot flip a Global Contact's Resend-side preference),
  submits it with `on_conflict: 'upsert'` to the broadcast's audience/segment, stores the
  returned import id on the `broadcasts` row and moves it to `audience_building`; later ticks
  poll `GET /contacts/imports/{id}`; when `status = completed` and
  `created + updated + skipped = total` with `failed = 0` the tick calls `sendBroadcast`; any
  `failed > 0` or a non-completed status after 30 min fails the dispatch with a typed reason
  (audit + alert). This is still "resumable across ticks" in FR-044's terms — progress is the
  provider's import job, not a per-recipient table — so **migration 0298 becomes two nullable
  columns on `broadcasts`** (`audience_import_id`, `audience_import_completed_at`), not a new
  table. Idempotency comes from `upsert` (V2 no longer needs a duplicate-semantics spike).
- **SDK**: the installed `resend@4.8.0` (`package.json` `^4.0.1`) has no `contacts.imports`; the
  method arrived in the 6.x line (latest 6.26.0, 2026-09-03). Decision: call the two import
  endpoints with a raw multipart `fetch` inside the existing gateway adapter behind
  `BroadcastsGatewayPort` (two new port methods `createContactImport`, `getContactImport`), and
  **defer the 4 → 6 SDK upgrade** to its own PR with a full gateway contract suite — a major
  bump across every F7 call is the wrong blast radius for PR-C.
- **Alternatives**: keep the serial loop but make it resumable with a `pushed_at` working table
  (the original R9) — rejected once the import API was verified (5,000 calls vs 2, and a new
  RLS table for a working set); lower the ceiling to what fits one tick (~500 at 10 req/s) —
  rejected (moves the timeout); request a rate increase alone — not a code fix, not testable;
  switch to `emails.batch` (transactional, 100/call) — rejected, it abandons the Broadcasts
  surface F7 is built on (separate suppression list + webhooks); upgrade the SDK in PR-C —
  rejected for blast radius (see SDK bullet).

## R10 — Cutover behind a temporary flag; delivery order A → B → D → C → review → flip

- **Decision**: `FEATURE_CONTACT_MARKETING_RECIPIENTS` (zod `booleanFromString`, default
  `false`, read only in the broadcasts composition root) gates the 1:N resolver, the
  ceiling change and the custom-list drop. Delivery: **PR-A** Tier A money hardening (R1–R3)
  with enum migration 0292 · **PR-B** invariant (R4, R5, migration 0293 triggers) · **PR-D**
  permission key + contacts marketing columns (0294) + enum migration 0295 + member-page
  badges/toggle + Marketing audience page + portal self-toggle (R6, R7) · **PR-C** resolver,
  ceiling, ~~import-based audience build (0298 broadcasts import columns)~~ **DEFERRED 2026-09-07 with T086/T087/T106 — no 0298 was authored (spec AMENDMENT under US5)**, custom-list drop, unsubscribe
  attribution (0297 `contact_id`), count endpoint, spec-010 amendments (R8, R9, R11), behind
  the flag · operator runs the FR-027a pre-flight review on the audience page ·
  flag ON in Vercel · the flag and the `primary_only` leg are deleted in a follow-up PR once
  a week of sends is clean.
- **Rationale**: Prod is live; the audience change is the one behaviour that cannot be
  rolled back by code alone once a send has gone out. D precedes C because FR-027a's
  review surface must exist before the flip. The flag is temporary and its deletion is a
  named task (Principle X, Complexity Tracking #2).
- **Alternatives**: single PR — rejected (money + RBAC + PII + resolver in one review);
  flip-on-merge — rejected (no operator gate for the first send under the new rule).

## R11 — Unsubscribe attribution + custom-list opt-out drop

- **Decision**: `marketing_unsubscribes` gains `contact_id uuid NULL` (0297, PR-C);
  `unsubscribe-recipient.ts:147-162` resolves via `lookupContactEmailInTenant` (returns
  `{ memberId, contactId }`, exists on the bridge but unused there) and falls back to the
  primary lookup only for legacy rows; both audit payloads gain `contact_id`.
  `validate-custom-recipients` output gains `droppedOptedOut: number`, computed by a new
  bridge method `filterMarketingOptedOut(tenant, emails) → Set<EmailLower>` (contacts with
  `marketing_opt_out_at IS NOT NULL`); submit passes the dropped count to the response
  (`recipient_preference_excluded: n`) and the compose UI shows the count, never the
  addresses (FR-022a). The same filter runs on the event-attendee segment.
- **Rationale**: suppression is already email-keyed and contact-agnostic; only attribution
  was missing (R-C §6). The custom branch already iterates per address
  (`validate-custom-recipients.ts:109-130`), the natural site to count drops.
- **Alternatives**: reject the submission listing opted-out addresses (clarify Q2 option B)
  — rejected by maintainer; drop silently without a count — rejected (sender would think
  the list was sent in full).

## R12 — Truthful recipient count at compose

- **Decision**: `GET /api/broadcasts/recipient-count?segment=<kind>&tier=<codes>` (member
  portal; `requireMemberContext`, clone of `api/broadcasts/quota/route.ts`) and
  `GET /api/admin/broadcasts/recipient-count?member_id=…` for the admin-proxy compose
  (gated `broadcasts.write`, baseline row added). Both call `resolveSegmentRecipients` with
  the caller's member as `requestingMemberId` and return `{ count, ceiling, exceeds,
  orphans: n }` — never addresses. Rate limit `broadcasts:count:{tenant}:{user}` 30/min via
  the Upstash limiter (`rateLimiter.check`, atomic). Compose form fetches on segment change
  (debounced 400 ms) and renders the count next to the segment picker with an `aria-live`
  region; a failed fetch shows "count unavailable", never a stale number.
- **Rationale**: R-D: divergent counts are the bug class `/api/members/ids` was written to
  avoid — call the single source of truth, do not write a parallel query. The compose form
  documents the omission at `compose-form.tsx:434-441`; SC-004 pins count = dispatched.
- **Alternatives**: server-render the count on page load only — rejected (segment is chosen
  client-side); compute client-side from a member list — rejected (PII egress, drift).

## R13 — Audit events, enums, retention

- **Decision**: three new `audit_event_type` values in two enum-only migrations, each
  shipping with the PR that emits them: `0292` (PR-A) `auto_email_skipped_no_recipient`
  (F4, 5y); `0295` (PR-D) `contact_marketing_opted_out` + `contact_marketing_opted_in`
  (F3; payload `{ member_id, contact_id, source: 'staff'|'self' }`, 5y) — 0295 stays ONE
  file (V3 answered: the guard extracts and replays every `ADD VALUE` in a file). Pins: F3 union + `f3-audit-event-type-count.test.ts` 35→37 (+ title); the auth
  pgEnum tuple (`schema.ts`, F3 block — `contact_removed` is in the tuple, verified);
  `audit.eventType.*` labels in EN/TH/SV with real Thai script
  (`audit-event-label-coverage.test.ts`); F4 union + retention map. The auth
  `AUDIT_EVENT_TYPES` (37, F1-only, `completeness.test.ts:82`) is **not** touched — R-D's
  claim that it moves is wrong for F3/F4 events. No new F7 events (payload-only change).
- **Rationale**: two events with a `source` payload beat four events; the toggle actor's
  role is always `ctx.current.user.role` (never a literal — `check:actor-role-truth`).

## R14 — FR-054 recipient-path gate (positive-control pattern)

- **Decision**: `scripts/check-money-email-recipient.ts` (`pnpm check:money-recipient`, added
  to pre-push next to `check:actor-role-truth`): scans `src/modules/invoicing/**`,
  `src/modules/payments/**`, `src/app/api/**` for `.primary_contact_email` reads; every hit
  must be in an `ALLOWED` list `{ file, contains, why }` — the PDF buyer block, the two
  render/reconcile sentinels, the non-member arm inside `resolveMoneyRecipient`, and the
  snapshot factory. Every allowlist entry must be FOUND each run (positive control), so a
  rotted regex fails loudly. Also a contract test `money-email-recipient-inventory.test.ts`
  that drives the four use cases with a promoted primary and asserts every outbox row's
  `to_email` equals the live primary (SC-001).
- **Rationale**: this is the third instance of the "a literal in a sink position is
  invisible to tsc" class (actor-role truth, staff-page guard); the gate + positive control
  is the proven pattern (#334).

## R15 — Observability and performance budgets

- **Decision**: metrics `invoicing.auto_email_skipped{reason}` (exists) + new
  `broadcasts.audience_resolved_total{segment, mode}`, `broadcasts.audience_pages_total`,
  `broadcasts.audience_import_status{status}` gauge (submitted / completed / failed / stuck),
  `broadcasts.recipient_count_ms`
  histogram; structured logs carry `memberId` hashes, never emails. Budgets: recipient
  count p95 < 400 ms at 5,000 and < 3 s at 20,000 (SC-004; 5,000-row pages ⇒ 4 pages + one
  exhaustion page at 20,000 — T081); Marketing audience page LCP < 2.5 s at 50 rows/page; toggle API p95 < 400 ms.
  `docs/observability.md` gains three of the four metrics (the `audience_import_status` gauge went with the
  deferred T086) plus, from the 2026-09-07 review, `dispatch_resolve_failed.total` and
  `approved_overdue_count`, and (round 2) a `phase` label on `audience_resolved.total` and an
  `outcome` label on `recipient_count_ms`; `docs/runbooks/broadcast-audience-build.md`
  documents the bounded per-tick push PR-C ships — the resolver's steps, the failure
  signals, the rollback — NOT the import-based build (deferred with T086/T087/T106).
- **Alert thresholds**: `dispatch_resolve_failed.total` rate > 0 sustained 15 min → alarm;
  `approved_overdue_count` ≥ 1 sustained 30 min → alarm; `recipient_count_ms{outcome="ok"}`
  p95 > 3,000 over 15 min → warn (SLO-F7-013 carries both FR-043 bands);
  `invoicing.auto_email_skipped{reason:no_recipient}` > 0 in any 24 h → warn (expected 0
  once the invariant ships); existing bounce/complaint alerts unchanged. The
  `audience_import_status` alert, the `reconcile-stuck-sending` (`audience_building`) and
  `void-pdf-reconcile` runbook updates are DEFERRED with T086/T106. Runbooks updated by
  PR-C: `cron-jobs.md`, `broadcasts-stuck-sending.md` (cross-links). Env: the flag
  is added to `.env.example` and passes `check:env-example` + `check:env-boot`.

## R16 — Resend Audiences → Segments / Global Contacts (risk outside this feature's scope)

> **DEFERRED out of PR-C (2026-09-07); banner added 2026-09-08 (T098).** Everything below that
> describes adopting `contacts.imports`, segments or topics belongs to the follow-up PR with T110
> (tasks T086 / T087 / T106, migration 0298 — none authored). PR-C ships none of it and still runs
> the bounded per-contact push on `resend@4.8`. R9 carried this banner and R16 did not, so this
> section read as though the import path were already available.

- **Fact** (Resend docs `dashboard/segments/migrating-from-audiences-to-segments`, 2026-09):
  Audiences are being replaced by Segments; a contact is now one record per team across
  segments ("Global Contacts"); unsubscribe preference moves to Topics; "Contacts API
  endpoints that previously required an `audience_id` can now be used directly". No
  deprecation date is published; the page says to contact support for migration.
- **Decision**: out of scope for 108. PR-C keeps `audienceId` on the existing gateway calls
  (the import API accepts `segments[]`, which today's audience id satisfies per Resend's
  compatibility note — **V5 confirms on the test account**). Record as an F7 platform risk in
  `docs/email-broadcast-analysis.md` and the go-live risk register; the SDK 4 → 6 upgrade PR
  (deferred from R9) is the natural place to adopt segments/topics.
- **Why it matters here**: F7's suppression is our own `marketing_unsubscribes`; with Global
  Contacts, a Resend-side `unsubscribed` flag set by any other segment now applies team-wide,
  so the import CSV must never carry that column (R9) and the dispatch must keep re-resolving
  our suppression list at send time (unchanged).

## Pinned repo facts the tasks rely on

- Next migration: tag `0292_…`, `idx: 293`, `when: 1798542000000` (+100000 ms per file);
  enum `ADD VALUE` migrations must be their own file(s) (autocommit pre-pass,
  `enum-migration-guard.ts`). Planned sequence: 0292 enum (PR-A) · 0293 triggers (PR-B) ·
  0294 contacts columns + 0295 enum (PR-D) · 0297 `contact_id` (PR-C; the 0298 broadcasts
  import columns are DEFERRED with T086 — no 0298 on the PR-C branch). If PRs land out of
  order, renumber the later one (memory: parallel-branch migration collision).
- `.limit(5000)`: `drizzle-member-repo.ts:1358`; 1:1 join `:1333-1340`; no status filter
  `:1349-1357`. `AUDIENCE_HARD_CAP` private at `resolve-segment-recipients.ts:36`.
- F7 audit union pinned at 61 by a compile-time assert (`audit-port.ts:199-202`) — unchanged.
- `requireMemberContext` exposes `ownContact` / `ownContactId` (`member-context.ts:29-40`)
  — the portal self-toggle needs nothing else.
- Static gates: `check:staff-page-guard` (exactly one literal `requirePagePermission`),
  `check:api-route-guard` (gate inside the exported handler + baseline row + super_admin
  happy-path contract test), `check:layout` (`TableContainer` in page **and** `loading.tsx`),
  `check:actor-role-truth`, `check:authorization-role-reads` (floor 67, re-pin upward only).
- House patterns to clone: `plans-table.tsx` (inline `Switch` + `useTransition` + `fetch` +
  `router.refresh()`, no optimistic update), `bulk-action-bar.tsx` (toast taxonomy, Undo),
  `api/admin/members/[id]/preferred-locale/route.ts` (small write route),
  `api/members/ids/route.ts` (read-only count endpoint), `admin-erasure-log.spec.ts`
  (role-gated page + axe), `primary-contact-race.test.ts` (extend with promote-vs-remove).
