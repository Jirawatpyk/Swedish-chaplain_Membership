# Member Contacts — Primary vs Secondary: gap analysis

**Date**: 2026-09-04 · **Status**: **CLOSED by feature 108 — H1, H2 and G1–G9 are resolved except G3, which was
deliberately KEPT** (§ 9 below records what closed each one and where). Tier C (bulk import of secondary
contacts) is NOT built — it remains the one open requirement from § 1. · **Owner**: maintainer
**Scope**: SweCham/TSCC requirement "Member Info – Primary & Secondary Contacts" (verbatim below) checked against `main` at `057e15ce3`.

## 1. Requirement (as received from SweCham)

> **Primary Contact**: this field must be locked to one contact only per member. Only this person receives invoices, receipts, payment notifications, and payment follow-ups. No changes to this rule.
>
> **Secondary Contacts**: a member can have many secondary contacts (for marketing emails, newsletters, event news only — never payment/invoice emails).
>
> Secondary Contacts must support bulk upload (import a file, e.g. Excel/CSV) — we will receive a huge list from SweCham's marketing team, so manual adding one-by-one will not work.
>
> Anyone NOT set as Primary Contact can receive marketing emails, but must NOT receive any payment/invoice/receipt emails.

## 2. Headline findings

| # | Finding | Severity |
|---|---------|----------|
| H1 | **Broadcasts (E-Blast) currently do the inverse of the requirement.** Member-based segments send to the primary contact ONLY; secondary contacts are excluded by design (spec 010 Q8 / FR-015c, deferred to F7.1b US3). Query: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:1337` (`eq(contacts.isPrimary, true)`). Secondaries reach a broadcast only via the ≤100-address custom list or as incidental event attendees. | Blocking for requirement |
| H2 | **Receipt / void notice / credit note / resend can go to a FORMER primary contact.** `invoices.member_identity_snapshot.primary_contact_email` is frozen at issue (FR-038) and never refreshed. After `promotePrimary` or an email change, every money email tied to an already-issued invoice still targets the old address, which is now a secondary (or removed) contact. Sites: `record-payment.ts:1116`, `void-invoice.ts:486`, `issue-credit-note.ts:1237`, `resend-pdf.ts:222,419` (all under `src/modules/invoicing/application/use-cases/`). F8 renewals are unaffected (live join). | Violates "never" |
| H3 | **No bulk import for contacts exists.** Admin adds secondaries one dialog at a time on the member detail page; member-create allows exactly one secondary. The only import pipeline is F6 event-attendee CSV, walled off by Clean Architecture ESLint rules. | Blocking for requirement |

## 3. What already satisfies the rule (no change needed)

- Invoice-issued email, the whole F8 reminder ladder (T-90…T-0), due-track dunning, retry, tier-upgrade approval and bulk portal invite all resolve the **live** primary contact.
- No CC/BCC anywhere; every transactional send has a single `to`.
- DB guarantees **at most one** primary per member: `contacts_one_primary_per_member` partial UNIQUE (`drizzle/migrations/0009_members_contacts.sql:89`). `promotePrimaryInTx` demotes-then-promotes atomically.
- Suppression (`marketing_unsubscribes`) is keyed on `(tenant_id, email_lower)` and the unsubscribe token encodes the email, not a member id. Both are already contact-agnostic.
- Dedupe in the broadcast resolver is by email string, so a person listed under two companies would still receive one send.

## 4. Secondary gaps

| # | Gap | Where | Notes |
|---|-----|-------|-------|
| G1 | Stripe billing email = signed-in portal user, who may be a secondary | `src/modules/payments/application/use-cases/initiate-payment.ts:633` → `src/modules/payments/infrastructure/stripe/stripe-gateway.ts` (~374) | Only bites if the tenant's Stripe Dashboard "successful payment" receipt email is ON. `receipt_email` is not set on the PaymentIntent. Check the toggle first; the code fix (pass the primary's email) is cheap regardless. |
| G2 | Zero-primary member reachable via race | `contact-crud.ts:417-433` (pre-check outside tx) + `drizzle-contact-repo.ts:173` (`removeInTx` force-demotes) | Admin A promotes Y while admin B removes Y. No DB guard. Fix: `removeInTx … WHERE is_primary = FALSE` so the race becomes `not_found`. `assertPrimaryContactInvariant` (domain policy) is dead code, test-only callers. |
| G3 | Contact email is UNIQUE per **tenant**, not per member | `0009_members_contacts.sql:88` `contacts_tenant_email_uniq` | One person cannot be a contact at two member companies; shared mailboxes (`info@`) cannot repeat; an existing primary cannot be a secondary elsewhere. Expect a noticeable row-failure rate on import. |
| G4 | Portal resend response discloses the primary's email to any linked contact | `src/app/api/portal/invoices/[invoiceId]/resend/route.ts:95` | Email itself goes to the (snapshot) primary, which is correct. Any linked contact, including a secondary, can view/download invoices and trigger resend. Policy question, not a defect. |
| G5 | Recipient query silently truncates at 5,000 before the cap check | `drizzle-member-repo.ts:1358` `.limit(5000)` vs `AUDIENCE_HARD_CAP = 5000` vs DB CHECK 50,000 vs `MAX_RECIPIENT_COUNT = 50_000` | Adding secondaries multiplies audience size. Must be settled before/with the resolver change. |
| G6 | `all_members` has no `members.status = 'active'` predicate | `drizzle-member-repo.ts:1353-1355` | Archived/lapsed members' primaries still receive E-Blasts. Widening to secondaries multiplies the leak. |
| G7 | Secondary unsubscribes lose `member_id` | `unsubscribe-recipient.ts:151` uses `lookupMemberPrimaryContactEmailInTenant` only | Suppression still works; the back-reference for GDPR Art. 17 cascade + tier index is lost. `lookupContactEmailInTenant` exists on the port and is unused here. |
| G8 | No per-contact marketing flag/consent record | `schema-contacts.ts` | Only `is_primary`. No `contact_type`, no opt-in/out, no consent source. F7.1b backlog proposes `receive_broadcasts` default FALSE, which conflicts with this requirement's default (see D3). |
| G9 | F4 primary lookup omits `removed_at IS NULL` | `member-identity-adapter.ts:159-169` | Safe today only because of the partial index; F8 does filter it. Consistency fix. |

## 5. Recommendation — three tiers, in order

### Tier A — harden the existing primary-only rule (small; no new spec)

This is what "No changes to this rule" is actually asking us to protect.

1. Resolve the **email recipient live** from the current primary at enqueue time in `record-payment`, `void-invoice`, `issue-credit-note`, `resend-pdf`. **Do NOT rewrite `member_identity_snapshot`** on promote: it is the buyer identity of a tax document and must stay frozen. Split "document buyer" (snapshot) from "delivery address" (live).
2. Stripe: pass the primary contact's email as `billing_details.email`, not the actor's.
3. `removeInTx … WHERE is_primary = FALSE`; wire or delete `assertPrimaryContactInvariant`.
4. Redact `recipientEmail` from the portal resend response.
5. Add `removed_at IS NULL` to the F4 primary lookup (G9).

### Tier B — secondaries receive marketing (medium; F7.1b US3 already designed)

Promotion criterion (b) in `specs/014-email-broadcast-advance/f71b-backlog.md` ("a chamber admin formally requests it") is satisfied by this request.

1. Recipient model v1: **every non-removed contact (primary + secondary) of every eligible member, minus suppressions, minus per-contact opt-out.** No opt-in flag, no backfill (see D3).
2. Resolver: drop the `is_primary` filter; add `members.status = 'active'` (G6); replace `.limit(5000)` with keyset pagination so nothing truncates silently (G5); `MemberRecipient` becomes 1:N.
3. Self-exclusion extends to all contacts of the submitting member.
4. Wire `lookupContactEmailInTenant` into `unsubscribe-recipient.ts` (G7).
5. Compound index `contacts(tenant_id, member_id) WHERE removed_at IS NULL AND marketing_opt_out_at IS NULL`.
6. Admin member-detail: per-contact "Marketing" toggle + badge; portal: contact sees own state.

### Tier C — bulk import of secondary contacts (large; new feature via `/speckit.specify`)

Ships after B, otherwise imported contacts receive nothing.

- **Format v1: CSV UTF-8** with a downloadable template. Defer XLSX: `xlsx@0.18.5` is dev-only and `scripts/import-members.ts:14-17` records the security stance against web-facing SheetJS. Detect Windows-874/TIS-620 (Thai-locale Excel default) and either transcode or fail with a clear "re-save as CSV UTF-8" message; today `decodeUtf8` with `fatal: true` rejects it opaquely.
- **Row → member resolution**: `company_name` (required) + optional `member_number` override. See D1.
- **Per-row sink**: reuse `addContact` (`contact-crud.ts:126`) verbatim; force `is_primary = false`; reject rows that claim primary.
- **Art. 14 / PDPA**: upload-level attestation + `consent_source` stamped onto every row (see D3). Show rows whose email is already in `marketing_unsubscribes` at dry-run.
- **Pipeline**: clone F6's batch + parallel workers + SAVEPOINT-per-row + 55 s time budget (`import-csv.ts`); lift the four parser primitives from `streaming-csv-importer.ts:98-298` into `src/lib/csv-parse.ts` (ESLint bars deep import); port `scripts/import-members/columns.ts` for header aliasing (already knows contact column names); clone `csv-column-mapping.ts`.
- **Dry-run first**, then commit (smart-chamber feature #13 asks for this; F6 lacks it).
- **Error CSV** contains names + emails: use `privateBlobAdapter` (`access: 'private'`), not the F6 public-with-suffix store.
- **New table** `contact_import_records` (clone migration 0139 incl. RLS+FORCE), new audit events `contact_import_*` (+ `check:audit-events` bump), permission `contacts.write` (no `*.import` key exists; catalogue is pinned at 40 keys).
- Rate limit: copy the F6 factory with prefix `contacts-import:`.

## 6. Decisions log (2026-09-04, maintainer)

| # | Question | Decision | Notes |
|---|----------|----------|-------|
| D2 | Does the primary still receive marketing? | **Yes, unchanged.** | Recipient set = primary + secondaries. |
| D1 | What member key is in the marketing list? | **Company name expected** (not confirmed). | Recommendation: match on normalised `members.company_name` (lower, trim, collapse whitespace, strip punctuation and common suffixes such as "Co., Ltd." / "Company Limited" / "AB"). Exact normalised match required; 0 or ≥2 matches → row fails with reason and the dry-run lists every unmatched name. Accept optional `member_number` column as an override (per-tenant UNIQUE, deterministic). Do not fuzzy-match silently; the trigram index is for search, not for attaching PII to the wrong company. Also match `company_name_th` if present in the list. |
| D3 | Imported secondaries eligible by default? Lawful basis? | Recommendation requested → **default eligible (opt-out model).** | Model: new nullable `contacts.marketing_opt_out_at`; NULL = receives. No backfill needed (avoids F7.1b E13 chunked-backfill concern). Lawful basis: B2B contacts of member companies in professional capacity. TH PDPA §24(5) legitimate interest + §35 record of processing; EU/Swedish data subjects GDPR Art. 6(1)(f) legitimate interest with Art. 14 notice (already modelled as `art14_attested_at`) and Art. 21 objection via the existing one-click unsubscribe. Importer requires an upload-level attestation checkbox + free-text `consent_source` (e.g. "SweCham marketing list 2026-09, collected at events / onboarding") stamped onto every created contact. Route through `pdpa-gdpr-compliance-officer` review at the spec gate. Honour existing suppressions at import (import the contact, show it as "already unsubscribed"). |
| D6 | Audience size / 5,000 cap | **5,000 likely enough, but must scale normally.** | Remove silent truncation (`.limit(5000)`), paginate the resolver, single source of truth for the cap, F7.1a split-cron path for >5k. Recipient count shown at compose time. |
| D5 | Can secondaries with portal login see invoices? | Recommendation requested → **Yes, keep view + pay access; fix the two leaks.** | The primary invited them (`invite-colleague` is primary-gated), so access was granted by the member. Invoices are company documents. Keep: view, download, pay. Fix: resend response redaction (G4), Stripe billing email (G1). Notification emails always go to the primary. Optional later: a portal "billing access" toggle per contact if SweCham wants tighter control. |
| D4 | Same person at two member companies? | **Unsure.** | Recommendation: keep `contacts_tenant_email_uniq` for v1. Relaxing it touches `linked_user_id` (one login ↔ one contact), the bounce resolver, the attendee matcher, unsubscribe attribution and the invoice buyer identity. Make the importer report such rows with reason "email already belongs to a contact at {other company}" and count them in the dry-run summary. Revisit the index only if the data shows it is common. |

## 7. Open items

- Confirm the actual columns in the marketing team's file (D1). As of 2026-09-04 the file has not been delivered; SweCham marketing is checking it first. If it has no company linkage at all, this becomes a standalone subscriber list, a different feature.
- Stripe Dashboard receipt-email toggle (G1): Settings → Business → Customer emails → "Successful payments". Chamber-OS never sets `receipt_email`; for PromptPay it sends `billing_details.email` = the signed-in portal user, for card no email reaches Stripe at all. With the toggle ON, Stripe sends its own (non-Thai-tax) receipt to that address. **Not actionable yet**: the Stripe account is still in Test mode as of 2026-09-04, and Stripe does not send customer receipts in Test mode. Add to the Live-mode switch checklist: verify the toggle is OFF (the setting is per mode). Landing Tier A item 2 before the switch makes this independent of Dashboard configuration.
- Tier A can start immediately as a small PR (invoicing + members + payments; money path → `financial-integrity-reviewer` + integration tests on live Neon).
- Tier B → re-spec F7.1b US3 with the opt-out default; Tier C → `/speckit.specify` for `contacts-bulk-import` after B.

## 8. Evidence index

Four read-only explorations on 2026-09-04 covering: contacts model + primary enforcement; transactional recipient resolution (24 send paths tabulated); broadcast recipient pipeline; bulk-import infrastructure inventory. Key claims re-verified against source before writing: the `is_primary` join filter, both partial unique indexes, the frozen snapshot read in `record-payment`, the dormant `recipientEmailOverride`, and the portal resend response body.

## 9. Resolution — feature `108-contact-recipient-rules` (T097, 2026-09-08)

All four PRs are merged and deployed: **PR-A #340** + **PR-B #342** (2026-09-05), **PR-D #344**
(2026-09-06), **PR-C #346** `91505b8f2` (2026-09-07). Migrations `0292`–`0297` are applied to prod.
Each row below was re-verified against source on 2026-09-08, not taken from the PR description.

| Gap | Status | What closed it |
|---|---|---|
| H1 — broadcasts do the inverse of the requirement (primary only) | **Closed, FLAG-GATED** | PR-C's 1:N audience leg in `resolve-segment-recipients.ts`, behind `FEATURE_CONTACT_MARKETING_RECIPIENTS`. **This is the one row that is not yet live**: the variable is ABSENT from Vercel (set then deleted on 2026-09-08), so the resolver still runs the `primary_only` leg. At today's 0 secondary contacts the two legs resolve to an identical audience anyway. See § 10. |
| H2 — money mail can go to a FORMER primary (frozen snapshot) | **Closed, LIVE** | PR-A: every money email resolves the LIVE primary contact; `scripts/check-money-email-recipient.ts` is a pre-push + CI gate with a positive control, so a new send path cannot re-introduce the snapshot read. |
| G1 — Stripe billing email = signed-in portal user | **Closed in code; one operator residual** | F5 takes the address from `BillingRecipientPort` (`src/modules/payments/application/ports/billing-recipient-port.ts:41`, wired at `initiate-payment.ts:218`), not from the session. Residual: the Stripe Dashboard "Successful payments" toggle must be switched OFF at the live-mode switch (quickstart § Cutover 7). |
| G2 — zero-primary member reachable via a race | **Closed, LIVE** | Migration `0293`: `contacts_check_member_primary()` SECURITY DEFINER (`row_security = off`) behind two DEFERRABLE INITIALLY DEFERRED constraint triggers — the check is at COMMIT, so the pre-check-outside-tx race has no window. Predicate narrowed by spec AMENDMENT to members with ≥ 1 contact row. |
| G3 — contact email UNIQUE per tenant, not per member | **KEPT — deliberate (D4)** | `contacts_tenant_email_uniq` stays for v1. Relaxing it touches `linked_user_id` (one login ↔ one contact), bounce resolution and suppression keying. PR-C added `contacts_tenant_lower_email_all_idx` (migration `0296`, NOT partial) so the carry-forward opt-out lookup can also match REMOVED rows — that index does not relax the constraint. |
| G4 — portal resend response discloses the primary's address | **Closed, LIVE** | `src/app/api/portal/invoices/[invoiceId]/resend/route.ts:106` returns `{ ok: true }` with no address. The in-code comment records that the original "leak" framing was overstated on review (the same user can read `GET /api/portal/profile`); the change stands on data minimisation, not on a confidentiality boundary. |
| G5 — recipient query silently truncates at 5,000 | **Closed, LIVE** | The `.limit(5000)` is gone from `findMembersBySegmentForBroadcast` (`drizzle-member-repo.ts:1621` records why). The resolver's ceiling is now the one truthful bound. **Residual**: there is no walk bound on the unbounded read — deliberately deferred, because a bound placed at the ceiling would re-introduce truncation-before-refusal. It must land before the ceiling is raised (§ 10). |
| G6 — `all_members` has no `status = 'active'` predicate | **Closed, LIVE (unflagged)** | `drizzle-member-repo.ts:1613` — `eq(members.status, 'active')` plus `isNull(members.erasedAt)`. Archived and lapsed members' primaries no longer receive E-Blasts; this shipped with PR-C and is live now, flag or no flag. |
| G7 — secondary unsubscribes lose `member_id` | **Closed, LIVE (unflagged)** | `unsubscribe-recipient.ts:139-147` resolves `contactId` via `lookupContactEmailInTenant` and writes it (migration `0297`, `marketing_unsubscribes.contact_id`) on EVERY unsubscribe with no flag read. **Do not drop that column while this code is deployed** — the GDPR Art. 21 path 42703s. |
| G8 — no per-contact marketing flag / consent record | **Closed, LIVE** | Migration `0294`: `contacts.marketing_opt_out_{at,source,by_user_id}` with a correlated CHECK and a partial index; migration `0295` adds the two audit event types. Permission key `contacts.marketing` (admin / super_admin / marketing — never manager). `MembersBridgePort.filterMarketingOptedOut` drops opted-out addresses from every segment kind at dispatch, fail-closed. |
| G9 — F4 primary lookup omits `removed_at IS NULL` | **Closed, LIVE** | `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts:173`. |

**Tier C (bulk import of secondary contacts) was NOT built.** § 1's "must support bulk upload …
huge list from SweCham's marketing team" is still an open requirement, and D1 (what columns the
marketing file actually has) is still unanswered — as of 2026-09-08 the file has not been
delivered. The separate Resend Contacts-Import build (tasks T086/T087/T106 and migration `0298`)
was deferred during PR-C and never authored; nothing in the codebase implements it, and no
`audience_import_status` gauge exists.

> **⚠️ Superseded on 2026-09-08/09 — see `specs/108-contact-recipient-rules/reviews/review-20260909-142600.md` § 6 and `docs/changelog.md`'s dated correction.** This was written before the Contacts-Import build landed. In short: `0298`+`0299` EXIST and apply on this deploy; the ceiling clamp is import-flag-OFF only, not "every flag state"; and the two batch cron routes were DELETED by `ca51f59a1`. The `audience_import_status` gauge genuinely does not exist. Left as written — it is the record of what was believed at the time.

## 10. What is still open after 108

1. **The flag flip itself** (task T094). The variable is **absent** from Vercel — it was set at
   09:44 on 2026-09-08 and deleted at 10:41, once it was clear that setting it arms the flip for
   whoever merges next (`vercel.json` has no `ignoreCommand`). H1 is closed in code, not yet in
   behaviour. T094 completes at first-send observation, not at flag-set.
2. ~~**Push-capacity gate**~~ — **CLOSED in code 2026-09-08.** The gate was also mis-described
   here: at the measured ~2.08 req/s the undeliverable band starts near **623**, *below* the 5,000
   ceiling already enforced, so it was never "the 5,001–10,000 band the flip adds" and it did not
   need the flip to be reachable. `DELIVERABLE_RECIPIENTS_PER_TICK = 500` now clamps
   `currentAudienceCeiling()` in every flag state, so compose, submit and dispatch refuse above
   what one 300 s tick can push. **Consequence for this document: the enforced ceiling is 500,
   unflagged, from the Phase-9 merge onward.**
3. **The walk bound for G5** — still open, and now the only piece of (2) that did not land: the
   read still walks to exhaustion. It matters before any future ceiling RAISE, not for the clamp.
4. **GDPR Art. 14 first-contact attestation** for secondary contacts the chamber has not itself
   informed (`docs/compliance/processing-records.md:128-135`, quickstart § Cutover 3a). Vacuous
   only while no such contact exists.
5. **Tier C bulk import** + D1, as above.
