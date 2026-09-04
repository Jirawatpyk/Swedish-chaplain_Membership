# PR-A — money-email recipient hardening (US1)

**Branch**: `108-contact-recipient-rules` · **Commits**: `e3f1e856d` … (13 on top of `main` at `057e15ce3`)
**Scope**: T001–T029 + T101, T102, T107 · **Status**: implementation + tests complete; gate run recorded below.

## What changed, and why it was wrong before

An invoice carries two facts that look identical in code and are not:

| | Frozen at issue | Resolved now |
|---|---|---|
| **Question** | who was billed | where the mail goes |
| **Source** | `member_identity_snapshot.primary_contact_email` | the member's contact with `is_primary AND removed_at IS NULL` |
| **Authority** | Thai RD §86/4 — must never move | operational — must always be current |

Every F4 auto-email answered the second question with the first. So once a member
promoted a new primary contact, their receipts, void notices, credit notes and
resends kept going to the person who had left — indefinitely, silently, and with
no surface anywhere that said so. F5 had the same class of bug through a
different pipe: it handed Stripe the signed-in portal user's address, so when a
secondary contact paid the company's invoice, Stripe's own receipt went to that
individual.

Nothing in the type system separates the two — both are `string`.

## Delivered

| Area | Change |
|---|---|
| Resolver | `resolve-money-recipient.ts` — pure `MoneyRecipient` union + a separate `auditAutoEmailSkippedNoRecipient` emitter |
| Port | `RecipientLocalePort.getMemberEmailRecipient` (required) + adapter (one JOIN, self-scoping on a null tx) |
| Test double | `tests/helpers/recipient-locale-fake.ts` — 29 inline literals across 25 files swept onto it |
| Invoicing | record-payment (fresh + replay), void-invoice (+ the guard it never had), issue-credit-note, resend-pdf (both arms) |
| Deleted | `ResendPdfInput.recipientEmailOverride` (no caller; a hand-supplied money address is the bypass FR-001 closes) |
| Routes | `no_recipient` → 409 on all three resend routes; portal resend body is now `{ ok: true }` |
| Payments | `BillingRecipientPort` + adapter via the members barrel; `actorEmail` removed from the input; `primary_contact_missing` → 409 with EN/TH copy |
| Audit | `auto_email_skipped_no_recipient` (migration `0292`, enum-only, verified in `pg_enum`), 10-year retention (corrected at review), registered in all six places incl. `REQUIRED_ENUM_VALUES` |
| UI | `NoPrimaryContactBanner` — `role="alert"`, non-dismissible, on the member and invoice pages (EN/TH/SV) |
| Gate | `pnpm check:money-recipient` — package.json + pre-push + quality-gates.yml |

## Three deliberate deviations from the brief

1. **Payload key `related_member_id`, not `member_id`.** Migration 0009's
   trigger bumps `members.last_activity_at` for ANY audit row carrying
   `member_id`, and the member-timeline view selects on the same key. A skipped
   email is not member activity: stamping it would inflate the at-risk scorer's
   recency signal for exactly the members whose contact data is broken. Staff
   visibility is FR-003's banner instead. Synced into spec FR-053 + the contract.
2. **`resolveMoneyRecipient` is pure**; the audit + metric side effect is a
   second export. record-payment's idempotent-replay arm has to resolve without
   re-auditing a decision the original attempt already owned.
3. **The emitter's metric `subject` is optional.** A `CreditNote` carries no
   invoice subject, and the resend path was about to label every credit-note
   skip `'membership'`. A guessed metric label is worse than an absent one; the
   audit row lands either way.

## One claim corrected mid-flight

Adding `removed_at IS NULL` to the primary-contact reads is **redundant, not a
fix**. Migration 0009's CHECK `contacts_primary_not_removed` already forbids a
removed row from staying primary — mutation-proved (deleting the predicate
changes no result), and the fixture that would prove otherwise is rejected by the
constraint. It is kept so each money-path read states the whole rule rather than
inheriting half of it from a constraint three migrations away; the code comments
say exactly this. The commit message and the tasks.md log carry the correction so
a reviewer is not told a redundancy was a defect.

Same discipline caught a second vacuous assertion: a test comparing
`members.last_activity_at` before/after a payment proves nothing, because
`invoice_paid` legitimately bumps it. The assertion is now on the audit ROW
(`payload ? 'member_id'` is false).

## Verification

Every cycle ran RED → GREEN → commit. Where a test passed on its first run
(because the code already existed), it was mutation-checked instead of trusted:

| What was mutated | Result |
|---|---|
| record-payment fresh arm → snapshot read | 4 of 5 live-Neon cases red |
| resend invoice arm → snapshot read | 2 of 3 live-Neon cases red |
| portal 202 body → echoes the address | 2 of 5 contract cases red |
| stray `.primary_contact_email` in void-invoice | `check:money-recipient` fails at the right line |
| one `removed_at` predicate dropped from F8 | the F8 drift guard fails |
| the locale adapter's `removed_at` predicate | **survived** → led to the correction above |

### Gate run (T028) — 2026-09-04, branch HEAD `2eb475473`+

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm check:i18n` | OK — 5168 keys in all 3 locales |
| `pnpm check:money-recipient` | OK — 421 files, 0 snapshot-addressed emails, 14 justified reads |
| `pnpm test:coverage` | all thresholds met, incl. the new `resolve-money-recipient.ts` 100/100 pin |
| `pnpm vitest run tests/contract/` | 191 files / 1934 tests passed |
| `pnpm check:staff-page-guard` | OK — 47 pages |
| `pnpm check:api-route-guard` | OK — 119 route files |
| `pnpm check:actor-role-truth` | OK — 1743 files, 0 fabricated |
| `pnpm check:audit-events` | OK |
| integration by path | record-payment-live-recipient 6 · resend-pdf-live-recipient 3 · void-invoice 15 · credit-note-partial-accumulation 10 · recipient-locale-adapter 11 · audit-coverage 7 · payments cross-tenant-probe 1 — all green |

**The coverage gate earned its place on the first run.** It failed on exactly one
file: `record-payment.ts`, pinned at 100/100 by the money-path remediation
(#329), had dropped to 99.59 line / 98.83 branch. The uncovered branch was the
non-member arm of the new skip — an event buyer with no typed address, where
there is no member to attribute the skip to and the audit payload arm requires
an `event_registration_id`, so the path keeps the pre-108 metric-only signal.
Two unit tests close it (that arm, and the `requestId ?? null` path a webhook
can take). Nothing about the feature was wrong; the gate simply refused to let
a money-path branch ship unexercised, which is what it is for.

## T029 — review round 1 (2026-09-04)

Three read-only reviewers, concurrent: `financial-integrity-reviewer`,
`pci-saqa-guardian`, `security-engineer`. **All three returned BLOCK**, and they
converged on the same root cause from three different angles — which is the
strongest signal a review round can give.

### What they agreed was right

The identity/delivery split itself, and the F4 side of it. The financial reviewer
grepped the entire diff for money identifiers and found **zero** hits; confirmed
the resolve sits after `allocateNext`, that the resolver's output reaches only
`recipientEmail` and `recipientLocale`, and that the replay arm is structurally
incapable of sending or auditing. The security reviewer tried to break tenant
isolation, IDOR and PII paths on the new code and could not. PCI confirmed SAQ-A
is untouched and card shares no address.

### The blocker, and why I had already been told about it

The F5 billing lookup ran INSIDE `paymentsRepo.withTx`, while the `payments:`
advisory lock was held, through an adapter that opens its own `runInTenant`.
Two consequences:

1. Every PromptPay initiate asked the pool for a second connection while holding
   the first. At pool-max concurrency that is a connection queue nothing breaks —
   Neon's pooler drops `statement_timeout`. `db.ts` carries a comment recording
   this exact incident from 2026-04-25, and this file's own header says the F4
   bridge is kept outside `withTx` for the same reason.
2. Refusing below the transaction's first write COMMITS it. The cross-method arm
   cancels the member's pending CARD PaymentIntent and audits the switch — so a
   card→PromptPay switch by a member with no primary contact destroyed a working
   payment and left an audit row describing a switch that never happened.

My own memory note says "`err()` inside `runInTenant` COMMITS — guards ABOVE the
first write". I wrote the guard below it anyway. The lesson was recorded and not
applied; that is the failure worth naming.

### Remediation applied

| Finding | Fix |
|---|---|
| pool nesting + write-then-refuse | resolution moved ABOVE `withTx`; the refusal now precedes the lock, the cancel and every write |
| repo error → permanent 409 | port returns `Result<string \| null, {kind:'read_failed'}>`; new `billing_recipient_read_failed` → 500, mirroring `invoice_read_failed`. `errKind(rootCause(...))` so the log stops printing `'unknown'` |
| `void-pdf-reconcile` copied the frozen `to_email` | resolves live like every other path; on no-recipient it retires the doomed row and audits the skip. This was the one remaining path that could mint a money email to a removed contact, and the gate could not see it (`to_email`, not `primary_contact_email`) |
| payload key | `skipped_for_member_id` → **`related_member_id`**. F9's `member_timeline_v` already COALESCEs `member_id, related_member_id`, and 0009's trigger keys on `member_id` alone — so this reaches the member timeline (where an admin asking "why no receipt?" will look) without waking the trigger. My third key was invisible to both. Verified in the migration + view before adopting |
| retention | 5y → **10y**. The row records that a §86/4 / §86/10 document was never delivered; every sibling document event is 10y. Keeping "sent" longer than "never sent" is an asymmetry that always favours us |
| suppressed + no primary | the resolve is now gated on the caller wanting an email, and the suppression arm is checked first. Without it, a suppressed send with no contact audited `auto_email_skipped_no_recipient` — the field right, the value a lie. Same class as the actor-role sweep |
| doc/code mismatch | `audit-port.ts` JSDoc and migration 0292's header said `member_id`; both now match the code |
| test could not kill the mutant | the resolver pin was `expect.any(String)` with `actorMemberId === invoice.memberId` in every fixture. Now drives them apart and pins the invoice owner exactly |

### Overstatements in this document, corrected

- "no orphan PaymentIntent is ever created" was true and incomplete — nothing was
  *created*, but a live card PI was *destroyed*. The fix makes the claim true;
  the wording now says what it means.
- "0 snapshot-addressed emails" was true of the token the gate scans, and was
  used to support a broader claim the `void-pdf-reconcile` path violated.

### Round-1 items closed after the first remediation commit

| Finding | Fix |
|---|---|
| **Cross-tenant test missing** (Constitution I.3, hard blocker) | 4 cases in `recipient-locale-adapter.integration.test.ts` against a real second tenant: both arms of `getMemberEmailRecipient` (threaded tx AND standalone, because they acquire RLS context differently), the locale read, and — deliberately — a case proving the tenant-B member IS resolvable from tenant B, so the three negative assertions cannot pass against a member that was never seeded |
| **No live-Neon coverage for the PromptPay billing address** | `tests/integration/payments/promptpay-billing-recipient.test.ts`: the real adapter → members barrel → `runInTenant` → repo chain, with a capturing gateway. Live primary reaches Stripe; after a promotion the NEW one does; no primary → `primary_contact_missing` with no PaymentIntent and no `payments` row; card needs no contact and shares no address. The frozen snapshot carries a distinct address so an accidental pass would be visible |
| **409 `no_recipient` had no user-facing copy** | `resendNoRecipient` in EN/TH/SV, wired on the credit-note menu and the portal button. It names the fix ("add or promote a contact on the member page, then resend") rather than "Resend failed" |
| **No banner on the credit-note page** | `NoPrimaryContactBanner` added there too — the page carries a Resend action, so it must carry the warning that explains why the action will refuse |
| **Portal toast said "check your inbox"** | It now says the copy goes to the organisation's primary contact. A secondary contact with a login would otherwise wait for mail that was never addressed to them |
| **`findPrimaryContactEmailInTx` had no tenant predicate** | Added, with `tenantId` threaded through the port. RLS already scoped it; Principle I asks the application layer to state the same rule rather than inherit it, and 108 put this read on a money path |
| **Gate scope excluded renewals** | Widened (615 files scanned, up from 421). Renewals owns `mark-paid-offline` and the F4 bridge; it addresses no money email from a snapshot today, and the point of a gate is that it stays that way |
| **FR-006 rationale overstated** | Corrected in place: `/api/portal/profile` already returns every contact's email to that same user, so the old "discloses another person's address" claim was false. The honest reason is data minimisation, and the comment now says so |

### Deliberately not done, with reasons

- **F-5 (Stripe `retrievePaymentIntent` exposure)** — cannot be settled from
  source; recorded in `research.md` as a test-mode operator check rather than
  guessed at.
- **F-6 (malformed contact address → Stripe 502)** — real but pre-existing in
  shape: `asEmail` validates the app write path, and the exposure is limited to
  bulk-imported rows that bypassed it. Left as a named follow-up rather than
  adding a second validation layer inside a money path late in a review round.
- **F-8 / L-5 (`getMember` on every invoice page load)** — a deliberate cost of
  the banner. Handed to `performance-slo-guardian` rather than optimised blind.

## T029 — round 2: fresh-agent post-remediation re-review

A `security-engineer` with no prior context re-reviewed the remediation against
the code (not the write-up) and re-ran the gates at HEAD. Verdict: **APPROVE
WITH FIXES**, security checklist **signed**, conditional on two items. All three
round-1 blockers verified closed at the sink, and the two new tests confirmed
capable of failing.

### The two it asked for before merge — both closed

| Finding | What was wrong | Fix |
|---|---|---|
| **MEDIUM-1** | My own round-1 note said the `no_recipient` toast was "wired on the credit-note menu and the portal button" — and it was, but the **admin invoice** surfaces (`invoice-more-menu`, `email-failure-alert`) were skipped, leaving the i18n key orphaned in all three locales and the most-used surface still saying "please try again" about a data problem | Wired both |
| **MEDIUM-4** | Every non-primary contact in both new tests was ALSO removed, so `removed_at IS NULL` alone selected the right row — delete `is_primary = true` from the queries and every test stayed green. The feature's core predicate had no coverage | Live secondary contacts seeded in both files, **before** the primary (neither read has an `ORDER BY`, so seeding the wrong answer first is what makes the mutation deterministic instead of lucky). Mutation now kills 3 tests, not 1 |

### Also closed this round

| # | Fix |
|---|---|
| MEDIUM-2 | Allowlist entries pinned a LINE while their reason was about the CALL it feeds — repointing `receiptPdfRenderEnqueue.enqueue` at `outbox.enqueue` left the matched line byte-identical and the gate silent. Entries now carry `boundTo`, checked against the file. **Mutation-proved**: that exact edit now fails the gate. Plus a contract assertion on `resolve-invoice-buyer.ts`, which carries two entries' justification but holds no token the gate can see |
| MEDIUM-3 | `stripCommentLines` tracked ONE open quote, so a nested template inside `${…}` closed the outer one and everything after a `//` on that line vanished — from **six** gates, not just this one. Now a proper frame stack. Regression tests added; they fail against the old implementation |
| LOW-1 | The blindness floor's abort message described an assertion it does not make |
| LOW-2 | The replay arm still had the ordering the fresh path was fixed away from, while its comment claimed it "mirrors the fresh path EXACTLY". A suppressed replay for a member with no primary reported `skipped_no_email` — blaming contacts for the caller's own suppression |
| LOW-3 | The reconcile re-enqueue took the address from the live read but the LOCALE from the row being retired — mailing the new primary in the previous one's language |
| LOW-4 | F5 lacked F4's empty-address guard: `contacts.email` is NOT NULL but only length-checked, so an import that bypassed `asEmail` could hand Stripe `''` |
| INFO-1 | Retention doc drift (three files still said 5y) |

### Left open, deliberately

- **LOW-7** — an ERASED member still sees the banner on the invoice and
  credit-note pages. `getMember`'s Member type does not carry `erasedAt` (the
  member page reads erasure status separately), and adding a second query to a
  page already carrying one extra read for this banner is the wrong trade for a
  cosmetic case. The gap is written into both call sites, naming the right fix
  (the domain type, not another round-trip).
- **LOW-5** — resolving above the resume check means a member who loses their
  primary contact mid-flight gets a 409 instead of their existing PromptPay
  `clientSecret`. Nothing is destroyed; moving the resolve back down is what
  caused the round-1 blocker, so this stays.
- **LOW-6 / INFO-2/4/5/6/7** — test-depth and doc items recorded in the review;
  none change behaviour.

## Status

**PR-A is review-complete.** T001–T029 + T101/T102/T107 all closed. Two rounds of
review (three reviewers, then a fresh-context re-review), every finding either
fixed or deferred with a written reason. `checklists/security.md` and
`checklists/money.md` carry Constitution v1.4.2 co-sign footers naming the
verification method.

Gate run at the co-signed HEAD: lint 0 · typecheck 0 · check:i18n 5171×3 ·
check:money-recipient 615 files / 17 justified reads · check:actor-role-truth ·
check:authorization-role-reads · check:staff-page-guard · check:api-route-guard ·
check:portal-guard · unit+contract 1197 files / 13238 tests · four live-Neon
suites 29 tests. (The earlier T028 table was pinned to a pre-remediation commit;
these numbers are HEAD.)

## Open at hand-off

- **T029** — the reviewer stack (`financial-integrity-reviewer`,
  `pci-saqa-guardian`, `security-engineer`) and the checklist co-signs.
- PR-B/D/C untouched. PR-B's migration `0293` still needs a fresh V1 run
  (`node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts`)
  immediately before merge.
