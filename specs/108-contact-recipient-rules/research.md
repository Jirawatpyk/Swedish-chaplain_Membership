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
`ADD VALUE` statements in one file (its regex matches per statement; header says "single");
V4 (superseded by the V2 redesign — no recipient working table is planned; keep only if V2
shows the import id + counts cannot live on the `broadcasts` row); V5 the team's actual Resend
rate limit (Settings → Usage; docs default is 10 req/s per team, raisable via support) and
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

- **Decision**: Add F4 audit event `auto_email_skipped_no_recipient` (5-year retention,
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
  ordered by `(member_id, contact_id)`, page size 1,000, **no `.limit(5000)`**. Rows carry
  `{ memberId, contactId | null, emailLower | null, isPrimary }`; a null contact marks an
  orphan member (FR-029). The broadcasts `MembersBridgePort` gains
  `getContactsBySegment(tenant, kind, params) → ContactRecipient[]` which loops pages until
  exhausted and **propagates repo errors** (today `members-bridge.ts:88` returns `[]` on
  error — a second silent-truncation vector under pagination). `resolveSegmentRecipients`
  works on `{ memberId, contactId, emailLower }` candidates: self-exclusion by
  `memberId === requestingMemberId` (input gains `requestingMemberId`; the email-equality
  arm is removed), dedupe by email, suppression `lookupBatch` in chunks of 1,000, then the
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

- **Decision**: `src/modules/broadcasts/domain/audience-ceiling.ts` exports
  `audienceCeiling(batchingEnabled: boolean): number` = 5,000 when the F7.1a batching flag
  is OFF, 50,000 when ON (matches the DB CHECK `broadcasts_estimated_recipient_cap` and
  `MAX_RECIPIENT_COUNT`). The composition root passes the number into
  `ResolveSegmentDeps.audienceCeiling`; `AUDIENCE_HARD_CAP`, the submit and dispatch checks
  all read that one value; `split-large-broadcasts` keeps its 10,000 threshold *below* the
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
- **Decision (push)**: build the provider audience with **one import per broadcast**: the first
  `dispatch-scheduled` tick resolves the audience, renders a CSV (`email` column only — never an
  `unsubscribed` column, so the upsert cannot flip a Global Contact's Resend-side preference),
  submits it with `on_conflict: 'upsert'` to the broadcast's audience/segment, stores the
  returned import id on the `broadcasts` row and moves it to `audience_building`; later ticks
  poll `GET /contacts/imports/{id}`; when `status = completed` and
  `created + updated + skipped = total` with `failed = 0` the tick calls `sendBroadcast`; any
  `failed > 0` or a non-completed status after 30 min fails the dispatch with a typed reason
  (audit + alert). This is still "resumable across ticks" in FR-044's terms — progress is the
  provider's import job, not a per-recipient table — so **migration 0297 becomes two nullable
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
  ceiling, import-based audience build (0297 broadcasts import columns), custom-list drop, unsubscribe
  attribution (0296 `contact_id`), count endpoint, spec-010 amendments (R8, R9, R11), behind
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

- **Decision**: `marketing_unsubscribes` gains `contact_id uuid NULL` (0296, PR-C);
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
  (F3; payload `{ member_id, contact_id, source: 'staff'|'self' }`, 5y) — split 0295 into
  two files if V3 says the guard needs one statement per file. Pins: F3 union + `f3-audit-event-type-count.test.ts` 35→37 (+ title); the auth
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
  count p95 < 400 ms at 5,000 and < 3 s at 20,000 (SC-004; 1,000-row pages ⇒ 20 round
  trips); Marketing audience page LCP < 2.5 s at 50 rows/page; toggle API p95 < 400 ms.
  `docs/observability.md` gains the four metrics; `docs/runbooks/broadcast-audience-build.md`
  documents the import-based audience build (submit → poll → send) and the
  stuck-`audience_building` reconcile.
- **Alert thresholds**: `audience_import_status` not `completed` within 30 min of submission,
  or `failed`/`stuck` → page; `invoicing.auto_email_skipped{reason:no_recipient}` > 0 in
  any 24 h → warn (expected 0 once the invariant ships); `recipient_count_ms` p95 > 3,000
  over 15 min → warn; existing bounce/complaint alerts unchanged. Runbooks to update:
  `docs/runbooks/cron-jobs.md` (new sub-state), `reconcile-stuck-sending` runbook
  (audience_building case), `void-pdf-reconcile` runbook (copy-forward note). Env: the flag
  is added to `.env.example` and passes `check:env-example` + `check:env-boot`.

## R16 — Resend Audiences → Segments / Global Contacts (risk outside this feature's scope)

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
  0294 contacts columns + 0295 enum (PR-D) · 0296 `contact_id` + 0297 broadcasts import
  columns (PR-C). If PRs land out of order, renumber the later one (memory: parallel-branch
  migration collision).
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
