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

### LOW findings — closed after the re-review

| # | Fix | Proof |
|---|---|---|
| LOW-2 (test) | 3 cases pinning what the replay arm REPORTS: suppressed + no primary → `disabled`; auto-email off → `disabled` without reading the contact; genuine no-recipient → `skipped_no_email` (the control, without which the first two would pass against an arm that always said `disabled`) | Reverting the arm ordering turns 2 red |
| LOW-4 (test) | An empty primary address is treated as no address on the F5 path too — live, through the real adapter | — |
| LOW-6 (test) | The `read_failed` distinction proven against a real database rather than a mock. The failure is induced honestly: `contacts.member_id` is `uuid`, so a non-UUID id makes Postgres raise, the repo catches it, and the adapter must report `read_failed`. Plus a control asserting the same adapter succeeds on a real member | Mutating the adapter's catch back to `return ok(null)` turns it red |

### Left open, deliberately

- **LOW-7** — an ERASED member still sees the banner on the invoice and
  credit-note pages. `getMember`'s Member type does not carry `erasedAt` (the
  member page reads erasure status separately), and adding a second query to a
  page already carrying one extra read for this banner is the wrong trade for a
  cosmetic case. The gap is written into both call sites, naming the right fix
  (the domain type, not another round-trip).
  *(Round 3 note: the "one extra read" half of this reasoning is gone — the
  banner no longer costs a `getMember` on either page. The finding itself still
  stands: the fix belongs on the domain type.)*
- **LOW-5** — resolving above the resume check means a member who loses their
  primary contact mid-flight gets a 409 instead of their existing PromptPay
  `clientSecret`. There IS a shape that fixes it (resolve pre-tx, refuse inside
  the tx after the pending-row read but before the cross-method arm, with a
  `pending?.method !== 'promptpay'` exclusion) and both reviewers described it.
  It is not taken because the test that guards the round-1 blocker asserts
  `withTx` is never called on the refusal path — the strongest form of "no write
  happened before we refused" — and that fix necessarily weakens it. A rare UX
  edge is the right thing to trade for a structural guarantee against a money
  bug that already shipped once.

  **REVERSED in round 3 — see finding #1 below.** A third independent reviewer
  raised it, and the reasoning above does not hold up: the `withTx` assertion
  was a proxy for "nothing was written", and that property can be asserted
  directly and more precisely. Nothing was traded away.
- **LOW-6 (second half)** — the new explicit `contacts.tenant_id` predicate has
  no test of its own; proving it would mean disabling RLS. The reviewer's own
  reading applies: RLS is the wall, this is the second layer, and the wall is
  what the cross-tenant test proves.
- **LOW-6 / INFO-2/4/5/6/7** — test-depth and doc items recorded in the review;
  none change behaviour.

## T029 — round 3: `/code-review` over the whole branch diff (2026-09-05)

Ten finder angles over `main...HEAD` (~7.9k insertions), deduped, plus a gap
sweep. Fifteen findings. Fourteen were real; one was wrong on its premise, and
finding out which took a database query rather than a re-reading.

Order of work was deliberate: **the gate helper went first.** Five gates share
`scripts/lib/source-scan.ts`, so changing what it can see changes what all of
them see. Doing it after the money edits would have made it impossible to say
which change moved a gate.

### Fixed

| # | Finding | What it actually was |
|---|---|---|
| 7 | `source-scan` test asserted a tautology | `toHaveLength(3)` on a 3-line input — true for every input under every implementation. Rewriting it to assert CONTENT failed immediately, twice. |
| 9 | `${…}` frame popped on any `}` | The `}` of an object literal closed the interpolation; the next backtick then read as the outer template's closing one, and the `//` after it ate the rest of the line. |
| — | (found via #7) EOL reduced the stack to a boolean | A multi-line `${…}` resumed the next line in template TEXT, keeping comments and pushing/popping the wrong frames for every later line. The whole stack now carries; `'` and `"` frames unwind at EOL because they cannot span a line. |
| 1 | Pre-tx billing read also gated the RESUME path | The one I had declined — see below. |
| 8 | F5 `primary_contact_missing` emitted no metric | F4's identical condition has had one all along, so the PAYMENT-BLOCKING variant — the one a member notices — was the one with nothing to alert on. Added `payments.billing_recipient_blocked{tenant,reason}`. |
| 2 | Banner re-implemented the recipient predicate | `isPrimary && removedAt === null` is two thirds of the rule. A primary contact with an empty `email` makes the resolver return `no_recipient` — every money email skipped, PromptPay 409 — while all three banners, finding that contact, rendered nothing. Exactly the outcome FR-003 exists to prevent. All three sites now ask `resolveMoneyRecipient`. |
| 11 | Two hot admin pages gained a full `getMember` for one boolean | Same fix: the resolver's single indexed JOIN replaces the round-trip. The invoice page's `getMember` is draft-only again; the credit-note page's is gone. |
| 12 | Recipient resolve inserted above the impossible-row guard | For a row with neither `member_id` nor `event_registration_id` and an empty snapshot address, the resolver returned `no_recipient` first — so staff were told to "add a contact" for an invoice with no member at all, and `resend_pdf_invoice_inconsistent_buyer`, the only signal such a row exists, never fired. |
| 3 | Reconcile cron hardcoded `subject: 'membership'` | A voided EVENT invoice was counted as a membership skip. The caller had `loaded.invoiceSubject` in hand and did not pass it. |
| 4 | Reads tested the TRIMMED email, returned the RAW one | `'  a@b.com  '` reached Stripe's `billing_details.email` and `notifications_outbox.to_email` verbatim. Also retires a `row!`. |
| 5 | Portal toast was the admin string, byte for byte | It told a member to fix contacts "on the member page" — a route their role cannot reach. Rewritten in EN/TH/SV to point at the chamber staff, matching the portal's existing phrasing for staff-only fixes. |
| 14 | `void-invoice` comment stated the opposite of the code | It claimed the resolve sat above the `shouldAutoEmail` branch "so the no-recipient case can be audited even when auto-email is on", while the code resolved INSIDE that ternary — and paid for the false claim with two guard conditions that could never be false. Collapsed to a plain `if (shouldAutoEmail)`. |
| 15 | Wave-4 S15 fold-decision note cited a removed property | Reason (3) said the recipient is "truthiness-checked, NOT trimmed". 108 removed that difference. That note IS the decision record for whether the block may be folded into the shared helper; a stale premise in it is how the next refactor gets made on a reason nobody re-derived. |
| 6 | CLAUDE.md said "PLANNED, no code yet" | Written in the very PR shipping ~2,700 lines, migration 0292 and a new pre-push gate. Corrected, along with the live migration number. |
| 10 | A comment pasted twice | Removed with the surrounding rewrite. |

### Finding #1 — reversing a documented refusal

I recorded LOW-5 as "deliberately declined" after round 2 and told the user so.
Round 3 raised it again: three independent reviewers on one placement, which
earns a re-derivation rather than a repeat of my reason.

My reason was that the fix weakens `expect(withTx).not.toHaveBeenCalled()`, the
assertion guarding the round-1 money blocker. It does. But that assertion was a
PROXY for "nothing was written", and the property itself can be asserted
directly: no cancel, no status update, no audit, no insert, no PaymentIntent.
Stated that way the fix costs nothing:

- the READ stays pre-tx, so the adapter's `runInTenant` never asks the pool for a
  second connection while this request holds one and the advisory lock is open;
- the REFUSAL moves inside, BELOW the pending lookup (so a resume is exempt) and
  ABOVE the cross-method arm (the first write). A transaction-scoped advisory
  lock and a SELECT are not writes, so the refusal still leaves nothing behind.

It also fixes a second bug I had not noticed: a transient read failure used to
500 a member out of a resume, on a read the resume never uses.

Both placements are mutation-proved — moving the block below the cross-method arm
kills the card-survival test; removing the resume exemption kills both new resume
tests. Neither co-signed security property regresses, so the
`checklists/security.md` footer stands.

### Finding #13 — REJECTED, on evidence

The finding said the four primary-contact reads could each pick a different
contact, since all four use `LIMIT 1` with no `ORDER BY` and "the
exactly-one-primary invariant is not yet enforced by a DB constraint". I agreed,
added `ORDER BY created_at, contact_id` to all four, fixed a test stub that broke
on the longer Drizzle chain — and then the integration test meant to prove it
could not even seed the two-live-primaries state:

```
PostgresError: duplicate key value violates unique constraint
  "contacts_one_primary_per_member"
```

Migration 0009 has carried a partial UNIQUE index on `(tenant_id, member_id)
WHERE is_primary = TRUE AND removed_at IS NULL` since F3. All four reads filter
on exactly that predicate, so at most one row can match. PR-B adds the
at-LEAST-one half, which is a different guarantee. Confirmed against the live
index definition, not the migration text.

The tiebreak was therefore **reverted**: it would have implied a multi-row case
the database forbids, and a comment saying these reads "might otherwise disagree"
is worse than no comment. What replaced it is a test pinning what the reads
actually rest on — that the index is there and rejects the second row, asserted
on `constraint_name` and SQLSTATE rather than on "something failed", since a NOT
NULL or FK violation would satisfy a bare `toThrow` while proving nothing. If
that index is ever dropped, finding #13 becomes real for all four reads at once,
and this test says so.

This is the second time in this feature that a redundancy I was about to
introduce turned out to be already guaranteed by a 0009 constraint — the first
was the `removed_at IS NULL` mutation survivor. The rule worth keeping: when a
review says "the DB does not enforce X", query the database before writing code
that assumes the review is right.

### Finding #8 — split, not deferred whole

The metric landed. The per-member AUDIT row did not: it needs a new
`audit_event_type` value (5 places plus a migration on `0293`, the number PR-B is
planned on), and reusing `auto_email_skipped_no_recipient` for it would be false
— no email was skipped. That is the actor-role-truth class of lie in a different
column. Recorded as a PR-B item rather than left to land by default.

## T029 — round 4: second `/code-review` over the branch diff (2026-09-05)

Fifteen more findings. Fourteen fixed, one rejected. Two of them were rules I
broke while fixing round 3, and one was a REGRESSION this branch had already
shipped — 31 commits deep, unnoticed, because nothing runs the suite that
catches it.

Order again put the shared gate helper first, for the round-3 reason: five gates
read through `scripts/lib/source-scan.ts`, so changing what it sees changes what
they all see.

### The regression, found by accident

`tests/integration/invoicing/void-pdf-reconcile-cron.test.ts` passes **14/14 on
`main`** and failed **3 on this branch**. PR-A changed the void-cancellation cron
to resolve its recipient LIVE instead of copying `o.to_email` forward, and the
fixture seeds a member with **no contacts** — so the resolve correctly returned
`no_recipient` and refused to re-enqueue. The product behaviour is the intended
FR-001 rule; the tests encoded the copy-forward that 108 removed.

Nothing caught it. The route is `src/app/api/**`, which the conditional
per-module integration pre-push gate does not cover (it keys on
`src/modules/<m>/**`), and CI runs `integration-smoke.yml` — tenant isolation and
money invariants — not this suite. **The lesson is about the gate map, not the
diff:** a feature that changes behaviour under `src/app/api/**` has no automatic
integration coverage in this repo, and I did not go looking.

Repaired by seeding a live primary contact. D6's assertion had read
`toBe('void.member@example.com')` with the comment "copied context" — the exact
behaviour 108 exists to remove — and now asserts the address is NOT the stale
one. That assertion is the only thing standing over this path: the token here is
`to_email`, so `check:money-recipient` cannot see it.

### Blockers

| # | Finding |
|---|---|
| 1 | The PromptPay **409** `primary_contact_missing` never reached the member. The hook maps by STATUS and consulted the body code only on the 403 arm, so 409 fell through to "Payment could not be completed" beside a Retry button — for a condition retrying cannot fix and the member cannot fix either. The bilingual string added for this case rendered nowhere. |
| 2 | The reconcile **skip audit was not intent-gated**, while the enqueue always has been. A SUPPRESSED void (void-on-reissue, which never queues a notice) wrote a ten-year row claiming a notice went undelivered; the ambiguous-upload leg recorded "never delivered" for a document the buyer had received. Append-only rows asserting events that did not happen — the actor-role-truth class in a different column. |
| 7 | **Principle III (NON-NEGOTIABLE).** Round 3 fixed the banner's hand-copied predicate by having three server components call `resolveMoneyRecipient(recipientLocaleAdapter, …)` — an `application/lib` helper plus an infra adapter, in Presentation. `plan.md` ticks "Presentation calls use cases only", which that made false. The architecture guard missed it because the import went through the barrel and its allowlist tracks DEEP infra paths. |

Finding #7 is worth naming precisely: **round 3 traded one rule break for
another.** The fix for a predicate that had drifted was to wire infrastructure
into a page. `getMemberMoneyRecipientStatus` + `makeMemberMoneyRecipientStatusDeps`
now give it the same use-case/deps shape as `makeResendPdfDeps`, and returning a
`Result` also closed #5 — the three pages had a bare `.catch(() => false)` with
no log, so a sustained read fault would have hidden the warning on every admin
surface during exactly the incident class FR-003 exists to surface.

### The rest

| # | Finding |
|---|---|
| 15 | Two bugs, one symptom: a real `//` comment surviving the strip. (a) A `'` in code context opened a string frame unconditionally — but `'` cannot span a line, so an unmatched one is an apostrophe in prose (`<p>It's fine</p>`). (b) Found while fixing (a) and much broader: `<` was in the `startsRegex` set, so the `/` of a JSX **closing tag** opened a "regex" that ran to the `/` of the following `//`. These scanners run over `.tsx`. Both are over-inclusion, not blindness — `skipRegex` appends what it consumes — but a gate that reports a hit for a sentence is one people learn to ignore. |
| 13 | `check:money-recipient` did not scan `src/app/(staff)` or `src/app/(member)` — trees that already load invoices and snapshots. Widened 615 → **965 files**; the three reads found are identity display and identity authoring, allowlisted with reasons. A gate's scope is part of its claim. |
| 3 | The skip event filed under `'other'` in the audit viewer — absent from the Billing group an admin opens to ask the one question it exists to answer. |
| 4 | `voidInvoice` returned a bare `Invoice`, so a skipped §86/10 notice read as an unqualified success. Both siblings already report delivery. |
| 6 | A non-member event invoice with an empty typed address returned `no_recipient`, whose copy sends staff to a member page that does not exist for that row — and left no trace at all. New `no_buyer_email` code, copy, metric and warn. |
| 8 | The credit-note skip's non-member arm bumped no metric, unlike both siblings. |
| 11 | `issue-credit-note` round-tripped a resolved `no_recipient` through an `''` sentinel and re-tested it, leaving the second trim dead. |
| 12 | The banner set `role="alert"` on content in the INITIAL server render — `aria-live="assertive"`, interrupting a screen reader on every navigation. Live regions announce CHANGES; the sibling `ArchivedBanner` sets no role. |
| 14 | The skip counter was bumped BEFORE awaiting the audit emit. The row rolls back with the money tx; the counter cannot. |
| 10 | The 11-line retirement UPDATE was duplicated verbatim in both reconcile arms, 30 lines apart. Folded into #2's restructure. |

### #9 — REJECTED

"Defer the billing-recipient read into the `!isResume` branch so a resume does
not pay for it." That branch is **inside `withTx`**. Moving the read there
reintroduces the round-1 blocker verbatim: the adapter opens its own
`runInTenant`, so it would ask the pool for a second connection while this
request holds one and the `payments:` advisory lock is open. The wasted read on
a resume is the deliberate price of pool safety, and the pending lookup cannot
move out of the transaction either — it needs the advisory lock for its TOCTOU
guard. Written here so a fifth reviewer finds the reason rather than the shape.

### Corrections to the findings themselves

- **#6's premise is wrong.** It says the row "before this change returned
  `not_issued`". A non-member event invoice carries `eventRegistrationId`, so it
  never reached that guard. The UX half was real; the history was not.
- **#1 is fixed only halfway, deliberately.** The Retry CTA still renders. That
  is a pre-existing property of `PaymentFailurePanel`, shared with
  `membership_access_restricted`, which is equally permanent. Suppressing the CTA
  for permanent failures is a panel-API change worth making once, for both codes,
  with a UX pass — not smuggled in beside a copy fix. **Open item.**

## T029 — round 5: third `/code-review` over the branch diff (2026-09-05)

Thirteen findings. Eleven fixed, two perf items answered. **Two of the eleven
were bugs round 4 introduced**, and one was a gap I had recorded as cosmetic for
three consecutive rounds and mischaracterised.

That is now the pattern of this feature, and it is worth stating rather than
smoothing over: **rounds 3, 4 and 5 each found something the round before
broke.** Round 3 fixed a drifted predicate by wiring infrastructure into a page;
round 4 fixed that and, de-duplicating an UPDATE, made it stamp a reason that is
false on one arm; round 4 also fixed `no_buyer_email` on one of the two resend
paths and left the other. None of these were caught by tests I wrote in the same
round — they were caught by a reader coming in cold.

### Bugs round 4 introduced

| # | What round 4 did | What it broke |
|---|---|---|
| 5 | Hoisted the retirement UPDATE above the recipient resolve, to stop the same eleven lines being written twice (round-4 #10) | Every arm then stamped `last_error = 'superseded_by_void_pdf_reconcile'`, including the arm that enqueues no replacement. An operator tracing the replacement row finds none; the row asserts an event that did not happen — the same class as the audit row the intent gate directly above it was added to stop. Now one statement, three honest reasons. |
| 1 / 9 | Added `no_buyer_email` for a non-member event buyer on the INVOICE resend path | Left the CREDIT-NOTE path answering `no_recipient`, whose copy reads "add or promote a contact on the member page" — for a document with no member. And the copy was added to BOTH i18n namespaces, so three locales carried translated DEAD copy, which disguised the missing branch from anyone reading the message file. |

### The one I had been wrong about for three rounds

**#2 — the FR-003 banner on an ERASED member.** I recorded this as LOW-7 in
round 2, called it "cosmetic" in round 3, and carried it as a KNOWN GAP comment
in round 4. It is not cosmetic and it is not occasional:
`scrubPiiForMemberInTx` sets `is_primary = false` AND `removed_at` on every
contact, so the live-primary read is **guaranteed** empty for an erased member.
The banner therefore fired on every invoice and credit note they had ever had,
telling staff to "add or promote a contact" for an Art.17 data subject — advice
that, followed, re-introduces the PII that was erased.

What I got wrong was the reasoning, not just the priority: I deferred it because
the fix "needs `erasedAt` on the `Member` domain type", having assumed the only
route to the fact was through `getMember`. It was not. The banner's own read
already selects `FROM members`, so `erased_at` and `status` are one column each
on a query that was already happening. The exclusion now lives in the use case
(`shouldWarn` + `suppressedBecause`), which also gives the invoice and
credit-note pages a gate they never had — only the member page checked.

### The rest

| # | Finding |
|---|---|
| 7 | A member credit-note resend that reached nobody bumped no counter, because `subject` was omitted (a `CreditNote` carries no invoice subject). The label now takes `'unknown'` — honest, where a membership/event guess would be a lie and omission was silence. |
| 3 | `catch {}` discarded the error while the function's own JSDoc claimed the pages logged the cause. They could not, and all three logged with no `err` field — a Neon timeout, a missing enum value and an RLS denial were indistinguishable. |
| 4 | `email_delivery` had NO consumer: `void-confirm-dialog` fired `toast.success` unconditionally and navigated away, so round 4's fix reached nobody. Wired as a warning (the void itself succeeded). Round 4's premise was also wrong — void is reachable only from its own page, not "the list or the row menu". |
| 10 | The barrel re-exported `recipientLocaleAdapter` with a comment saying "not for pages". A comment is not a guard: ESLint's rule is scoped to deep infra paths, so a barrel import in a server component was invisible to it, re-opening the exact Principle III hole the new use case exists to close. Removed; its one consumer deep-imports and is allowlisted — the architecture guard verified that by failing first. |
| 11 | CLAUDE.md still said pre-push runs "ten static gates" after 108 added an eleventh. |
| 12 | The gate script's `shown === SELF` skip is unreachable — `scripts/` is not in SCOPE, so `walk()` never reaches the file. A dead guard reading as a live one is how someone adds `scripts/` to SCOPE believing the exclusion works. |
| 13 | `walk()`'s catch reported every failure as "scope root missing", so a dangling symlink or an unreadable directory would abort CI pointing at a directory that is present. Root existence is now tested separately; both paths exercised. |

### The Retry CTA — round 4's open item, closed

`PaymentFailurePanel` offered "Try again" for PERMANENT failures: a terminated
membership and a membership with no primary contact. Neither is fixable by
clicking, and both are fixable only by the chamber. Round 4 deferred this as "a
panel-API change worth making once, for both codes, with a UX pass" — which is
exactly what it now is: a `permanent` prop, set from the two arms that know, with
the reason text still naming the action the member CAN take. Mutation-proved,
with a transient control so the assertion cannot pass vacuously.

### Perf findings — answered, not fixed

- **#6 (the resume pays for a discarded read).** Rejected for the third time, and
  the suggested "lazily-invoked thunk" does not change the answer: the thunk
  would have to be invoked in the `!isResume` branch, which is INSIDE `withTx`,
  and the adapter opens its own `runInTenant`. That is the round-1 pool-nesting
  blocker exactly. The read cannot move later because resume-ness is not known
  until the advisory lock and the pending lookup, and neither can move out of the
  transaction. One indexed read on the resume path is the price of that.
- **#8 (three pages each add a serial round-trip for the banner).** Real, and
  smaller than when it was raised: the banner's read replaced a whole `getMember`
  on two of the three pages, so the invoice page is now cheaper than before 108,
  not dearer. Batching it into a `Promise.all` with its neighbours is a genuine
  improvement and is NOT done here — reordering awaits on a page with six
  existing serial reads is a change I would want measured, not assumed, and this
  branch is long enough. Recorded as an open item.

## Status

**PR-A is review-complete.** T001-T029 + T101/T102/T107 all closed. FIVE rounds
of review — three concurrent reviewers, a fresh-context re-review, then three
ten-angle `/code-review` passes — with every finding fixed or refused in writing.

The pattern worth carrying out of this feature: **rounds 3, 4 and 5 each found
something the round before broke**, and none of it was caught by tests written
in the same round. A fix for a drifted predicate wired infrastructure into a
page; the fix for THAT left a barrel export re-opening the same hole behind a
comment; de-duplicating an UPDATE made it stamp a reason false on one arm;
`no_buyer_email` was added to one of two resend paths. Each was found by a
reader coming in cold, not by the author verifying their own work.

Three findings were REJECTED on evidence rather than accommodated: round-3 #13
(the primary-contact reads cannot disagree — `contacts_one_primary_per_member`
has been a partial UNIQUE index since migration 0009; the tiebreak written for
it was reverted), and round-4/round-5 #9/#6 (deferring the F5 read into the
`!isResume` branch, or behind a thunk invoked there, reintroduces the round-1
pool-nesting blocker — that branch is inside `withTx`).

Both checklists carry Constitution v1.4.2 co-sign footers with per-round
re-affirmations. Three claims were AMENDED when a later round made them false
rather than left standing: `money.md`'s transaction-safety bullet, and
`security.md`'s Principle III line **twice** — the second time because a
principle check that reads a green guard instead of the rule will keep passing
while the rule is broken.

Gate run at HEAD `631e5fd33`: lint 0 · typecheck 0 · static gates PASS
(`check:money-recipient` 965 files, up from 615) · full unit suite 1007 files /
11328 tests · `pnpm test:coverage` **exit 0** — 1198 files / 13264 tests, money
pins met · architecture guards 133 · live-Neon suites green (void-pdf-reconcile
18/18, primary-contact-read-agreement 6/6).

`check:plan-divergence` fails and is NOT a defect in this branch: it reports on
72 leftover integration-test tenants on the shared dev Neon branch (every tenant
with invoices there is `test-`-prefixed; there are no real ones). It has no
`test-` exclusion, so it fails for anyone who has run the integration suite
against dev. Deliberately not "fixed" — adding a tenant filter to a
money-integrity gate could mask a real divergence, and that is an owner's call.

## Open at hand-off

- **T029** — the reviewer stack (`financial-integrity-reviewer`,
  `pci-saqa-guardian`, `security-engineer`) and the checklist co-signs.
- PR-B/D/C untouched. PR-B's migration `0293` still needs a fresh V1 run
  (`node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts`)
  immediately before merge.
- ~~**Open UX item (round 4, finding #1):** the Retry CTA for PERMANENT
  failures.~~ **CLOSED in round 5** — `PaymentFailurePanel` takes a `permanent`
  prop, applied to both `primary_contact_missing` and the pre-existing
  `membership_access_restricted` at once, as round 4 said it should be.
- **Open (round 5, finding #8):** the three banner sites each add a serial
  round-trip. Smaller than when raised — the read REPLACED a whole `getMember`
  on two of them, so the invoice page is cheaper than before 108, not dearer —
  but batching it into a `Promise.all` with its neighbours is a real
  improvement. Not done here: reordering awaits on a page with six existing
  serial reads is a change worth measuring, not assuming.
- ~~**Open (round 4, finding #2 fallout):** `src/app/api/**` has no automatic
  integration coverage.~~ **CLOSED on branch `api-route-integration-gate`** —
  the pre-push hook now maps a changed route to the integration tests that
  IMPORT it (exact `@/app/api/.../route` literal, not a name heuristic), and a
  branch's FIRST push gates everything since `merge-base origin/main HEAD`
  instead of one commit. Verified by breaking the reconcile route and watching
  the hook exit 1.
- **New PR-B item (round 3, finding #8):** a per-member AUDIT row for the F5
  `primary_contact_missing` refusal. Needs a new `audit_event_type` value (5
  places + a migration) — deliberately NOT folded into
  `auto_email_skipped_no_recipient`, which would state that an email was skipped
  when none was due.
