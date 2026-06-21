# Member Erasure (COMP-1) — Design

**Right to erasure for chamber members: GDPR Art. 17 ("right to be forgotten") + Thai PDPA §33.**

Date: 2026-06-16 · Status: design **revised after a 6-specialist review** (pdpa-gdpr · thai-tax · architect · security · reliability · QA — all confirmed the strategy is correct/legally-forced; this revision folds in the 8 critical + 14 high execution corrections). · Topic: COMP-1

---

## 1. Problem & purpose

A chamber member may exercise their statutory right to have their personal data erased. Today Chamber-OS can **export** a member's data (F9 — GDPR Art. 15 / Art. 20) and **archive** a member (status change + cascade that stops sessions, in-flight broadcasts, and renewal cycles), but it **cannot erase the personal data** — company name, tax ID, address, contacts (name/email/phone/DoB), the linked login account (email + password hash), event-attendance identity, and broadcast content all remain.

**Legal basis:** PDPA §33 · GDPR Art. 17 (Swedish/EU subjects via the SCCs in place). The chamber is the controller.

**Success criteria:**
- An admin can fulfil an erasure request, removing/anonymising the member's personal data across **every** module + every PII store the F9 export inventory recognises, in one auditable, **resumable** operation.
- **Idempotent**, **tenant-isolated** (Principle I), and **legally safe** — never deletes statutorily-retained data (Thai tax documents within their 10y window, the append-only audit log, the marketing-suppression list).
- The result is genuine **erasure** (the data subject cannot be re-identified from what survives — see §3), with a defensible DPO record.

---

## 2. The hard constraints that shape the design

| Constraint | Implication |
|---|---|
| **FK web** — `invoices`, `payments`, `event_registrations`, `broadcasts`, `renewal_cycles` FK to `members(tenant_id, member_id)` | Cannot hard-delete the member row. → anonymise **in place** (tombstone). |
| **Thai RD §87/3** (retain tax docs 10y) + **§86/4** (buyer name+tax_id on the doc **only for VAT-registrant buyers**; 46/131 SweCham members have no tax_id) | Tax-document buyer identity is held only where §86/4 pinned it, only **within** the 10y window, then redacted (DB snapshot **and** PDF blob bytes). Redaction is lawful **only after** the 10y obligation elapses. |
| **`invoices_enforce_immutability`** (mig 0019/0205/0206) + **`broadcasts_immutable_after_submit_fn`** (0064/0075) BEFORE UPDATE triggers | The scrub UPDATEs on issued invoices / submitted broadcasts will **RAISE** unless run under a **GUC-gated redaction exemption** (see §5 matrix + §9 US2). |
| **audit_log append-only** (mig 0001 — BEFORE UPDATE **and** BEFORE DELETE both RAISE; T-13) | Audit rows are **never modified or deleted**. → forward-fix (don't write PII into payloads) + documented residual for legacy payloads (see §6). |
| **GDPR Art. 21 / PDPA §32** — `marketing_unsubscribes` indefinite | The suppression list is **never erased** (its `email_lower` is intentionally retained plaintext so the suppression match keeps working). |
| **Irreversibility** | Admin-mediated + typed-phrase confirm. |

---

## 3. Re-identification analysis (the Art. 17 crux — NEW)

"Anonymise-in-place" only satisfies Art. 17 if the surviving data cannot **reasonably re-identify** the subject (GDPR Recital 26); otherwise it is mere *pseudonymisation* and still in scope. Per-field justification for what **survives** on the member tombstone + audit + held tax snapshot:

| Survives | Why it can't re-identify (or how restricted) |
|---|---|
| `member_id` (UUID), `member_number` (`SCCM-NNNN`) | Opaque internal IDs; re-identifiable **only** by joining the members row — which is anonymised. The UUID in audit rows is pseudonymous **because** that mapping is broken. |
| `plan_id`, `plan_year`, registration dates | Non-identifying membership metadata. |
| `turnover_thb`, `founded_year` | **Business quasi-identifiers** — at small-chamber scale these can aid re-identification. → **scrub these too** (NULL) unless a retention need is documented. (Was missing from v1.) |
| F4 invoice buyer **snapshot** (name/address/tax_id) | Retained **only** where §86/4 required it, **only** within the 10y window, under a statutory exception — then redacted (snapshot + PDF bytes). |
| `marketing_unsubscribes.email_lower` (plaintext) | Retained under Art. 21 by law; a documented, conscious residual (a hash would defeat the suppression match). |
| Legacy audit free-text payloads (`reason`/`notes`) | Documented residual under the audit log's forensic/record-of-processing basis (Art. 30 / §39); minimised forward (see §6). |

**Documented residuals (out of full technical erasure, stated in the RoPA + runbook):** an F9 export ZIP already downloaded by the subject; sub-processor copies (§9); backup/PITR snapshots (re-erased on any restore); domain/fuzzy-matched event registrations that stored `matched_member_id = NULL` (not linked to the member in our system).

---

## 4. Existing pieces — reuse vs build (corrected)

| Piece | Status | Note |
|---|---|---|
| `archiveMember` cascade shell (sessions/invitations/F7/F8 via ports) | **reuse** | But archive hard-codes `originator_member_deleted`; `eraseMember` passes the `gdpr_erasure_request`/`pdpa_deletion_request` reason explicitly. |
| F6 `eraseAttendeePii` | **reuse (per-registration)** | **HARD-DELETES one registration** (not "pseudonymise"). `eraseMember` needs a new **fan-out** that loops every `matched_member_id = member` registration; it runs as a **post-commit best-effort cascade** (it takes its own advisory lock — cannot join the atomic tx). |
| Non-member 10y `redact-expired-event-buyers` cron | **reuse the pattern** | Already does GUC bypass + DB-snapshot tombstone + **PDF blob-byte purge** + `pii_blob_purged_at` retry marker + `FOR UPDATE SKIP LOCKED`. The member arm extends it (predicate change only). |
| Session revocation + invitation cascade ports | **reuse** | Already invoked on archive. |
| **F1 linked-user erasure** | **BUILD (net-new, security-sensitive)** | The "F1 Art.17 already exists" claim was **wrong** — only `delete-invited-user.ts` (pending-invite SAGA compensation) exists. Must build: anonymise `users.email` → tenant-unique sentinel (preserve the unique constraint), invalidate `password_hash`, name → `[erased]`, revoke sessions (existing hook), new `user_erased` audit. Behind an auth-module port. **≥2 reviewers + security checklist** (Principle I / Gate 9). |

---

## 5. Erasure Outcome Matrix (corrected, codebase-checked)

| Module / table | Action | Bucket |
|---|---|---|
| **members** | Anonymise-in-place: `company_name → '[erased]'`; `tax_id`, `address_*`, `city`, `province`, `postal_code`, `description`, `notes`, `website`, **`turnover_thb`**, **`founded_year`** → NULL. Keep `member_id`, `member_number`, `plan_*`, dates. **`risk_score_factors`/`risk_score`/`risk_score_band` are NOT scrubbed — codebase-checked (US1 Task 9): the jsonb holds only a closed-vocabulary factor-code→integer-weight map (`{ invoices_overdue_count_gt_zero: 25, … }`, keys from `AT_RISK_FACTOR_WEIGHTS`), no names/emails/free-text → non-identifying derived signals, a documented residual like `plan_year`.** **Add `erased_at` column** (new migration). | atomic tx |
| **contacts** | Anonymise-in-place with **sentinels** (cols are NOT NULL): `first_name/last_name → '[erased]'`, `email →` per-row non-PII sentinel, `phone/date_of_birth/role_title` → NULL, `preferred_language → default 'en'`. **Set `removed_at`** so the row leaves the `lower(email) WHERE removed_at IS NULL` partial unique index (avoids sentinel-email collision across erased members). | atomic tx |
| **audit_log** | **Never UPDATE/DELETE** (append-only). Erasure emits only non-PII audit. Legacy free-text PII = documented residual (§3/§6). | — |
| **F1 users (linked)** | **Build** the erasure (see §4): anonymise email→**globally-unique** sentinel `erased+{userId}@erased.invalid`, password_hash→NULL, display_name→`[erased]`, status→`disabled` + revoke sessions + `user_erased` audit. **`users` is CROSS-TENANT (codebase-checked US2a):** no `tenant_id` column, a GLOBAL functional `lower(email)` unique index — so the sentinel is **globally** unique (NOT tenant-scoped), and the erasure runs in an **owner-role `db.transaction`** (not `runInTenant`), mirroring `delete-invited-user.ts`. `user_erased` = net-new **auth-taxonomy** event (4-place). | post-commit cascade (owner tx) |
| **F4 invoices / credit-notes** | **Keep** the document/number/amounts/VAT. Buyer identity is **already snapshot-frozen** (`member_identity_snapshot` jsonb; PDF bytes frozen on Blob) — **CONFIRMED**, so the member scrub **cannot corrupt** the tax PDF. **No `legal_hold_until` column** — the 10y redaction is a time-predicate concern (`issue_date < now() - interval '10 years'`). **No US2 trigger work (codebase-checked):** `invoices_enforce_immutability`'s existing `app.allow_pii_redaction` GUC branch already permits `member_identity_snapshot` to change for member invoices (`member_id IS NOT NULL`) — so US3's 10y cron reuses the F4 GUC unchanged (the live trigger body is migration **0214** — base any future amend off it). | (deferred, §9 US3) |
| **F5 payments / refunds / processor_events** | **No action** — no buyer PII (cardholder data at Stripe, SAQ-A; `card_last4`/brand/exp are tokenised; `processor_events` stores `payload_sha256` only). `member_id` linkage is pseudonymised by the members scrub. *(Strengthens the SAQ-A story.)* | — |
| **F6 event_registrations** (matched) | **Hard-delete** each registration where `matched_member_id = member` (reuse `eraseAttendeePii` semantics + quota credit-back + advisory lock), via a new `eraseAllRegistrationsForMember` fan-out. Idempotent (re-run finds 0). | post-commit cascade |
| **F7 broadcasts** | Scrub `subject`/`body_html`/`body_source` → `'[redacted]'` sentinel (NOT NULL + length≥1 CHECKs — cannot be `''`), `custom_recipient_emails` → NULL, `from_name`/`reply_to_email` → sentinel — **under a new `app.allow_broadcast_redaction` GUC + amended `broadcasts_immutable_after_submit_fn`** whitelisting only the trigger-checked PII cols (`subject`/`body_html`/`body_source`/`custom_recipient_emails`; `from_name`/`reply_to_email` are already unchecked by the trigger, so they need no GUC). Tombstone `broadcast_deliveries.recipient_email_lower` (sentinel) + `recipient_member_id` → NULL via the established **`ALTER TRIGGER … DISABLE/ENABLE`** bypass (the deliveries append-only trigger has NO GUC arm — different mechanism from `broadcasts`). **`broadcast_batch_delivery_events` is NOT a tombstone target (codebase-checked):** it is a pure idempotency ledger (`tenant_id`/`resend_event_id`/`batch_manifest_id`/`counter_field`) with NO recipient email or member PII. Cancel in-flight (existing hook). | post-commit cascade (GUC + trigger-disable) |
| **F8 renewal_cycles** | Cancel in-flight (existing hook). **NO row scrub needed (codebase-checked US2):** `renewal_cycles` + all 6 sibling renewals tables (`renewal_reminder_events`, `renewal_escalation_tasks`, `at_risk_outreach`, `tier_upgrade_suggestions`, `consumed_link_tokens`, tenant config) carry member identity only as a `member_id` FK + non-PII metadata/plan-snapshots — **zero denormalized member email/name/company**. Staff-authored free-text notes (`outcome_note`/`skipped_reason`/`dismissed_reason`) are annotations, not member-supplied data → out of erasure scope. | (cancel only — already wired US1) |
| **marketing_unsubscribes** | **Never erase** (Art. 21). | — |

**Sub-processor propagation (§9 US3):** instruct **Resend** to remove the member's contacts from any provider-side audience (keep only the suppression entry); request **Stripe** customer-object anonymisation if a customer exists. (Stripe holds no card data — SAQ-A — but email/name are PII.)

---

## 6. Flow, atomicity & recovery (corrected)

```
admin (member detail, admin-only) → "Erase member (PDPA/GDPR)"
  → reason (gdpr_erasure_request | pdpa_deletion_request) + typed-phrase confirm
  → eraseMember orchestration:
      1. emit member_erasure_requested (durable BEFORE destructive work)
      2. ATOMIC TX (runInTenant): scrub members + contacts (+ erased_at)   ← only rows the members module owns
      3. POST-COMMIT best-effort, each independently idempotent + resumable:
           F1 user · F6 registration fan-out · F7 content + deliveries (GUC) ·
           F8 cancel · existing session/invitation/broadcast/renewal cascade
      4. emit member_erased  ONLY when every cascade reports complete (terminal proof)
  → reconciliation sweep cron: finds members with erased_at set but cascade
       incomplete → re-drives the remainder (predicate re-select, like the F4 cron)
  → [10y] redact cron: member invoices past issue_date+10y → tombstone snapshot
       + purge PDF blob bytes (pii_blob_purged_at marker)
```

- **Atomic tx = members + contacts only** (one bounded context). Everything cross-module is **post-commit best-effort** + individually idempotent (re-run completes a partially-failed erasure — does NOT blanket no-op on `erased_at`).
- **`member_erased` is the completion proof** — emitted only after the cascades succeed, so the idempotency gate can't mark a half-run "done."
- **Reconciliation sweep + `erasure_outcome` metric + alert** so ops/DPO can detect a stuck/partial erasure (archive has no reconciler today — this is new).
- **New audit events:** `member_erasure_requested`, `member_erased`, `user_erased`. F3 events = **5y** retention; any member-invoice **redaction** audit emitted by the 10y cron = **10y** (tax-document retention class, like `event_buyer_pii_redacted`). Registration in the real F3 places: domain const + drizzle pgEnum + the F3 audit-event **count test** (`tests/unit/members/application/f3-audit-event-type-count.test.ts` — F3 uses a single count file, **not** the F1 audit+completeness pair) + the insights **audit-event-category** so the DPO log can render/filter them.

---

## 7. Admin UI (minimal — YAGNI) + Art. 12 duties

- **"Erase member"** action on the admin member-detail page (admin only; `manager` → 404 at the route boundary per the F6 convention). Typed-phrase confirm + reason selector; server-validated; CSRF Origin allow-list applies; Upstash rate-limited (abuse guard).
- **DPO erasure log** (read-only, reuses the F9 audit-viewer): surfaces `member_erasure_requested`/`member_erased`/`user_erased`, **and flags requests with no matching completion** (half-run), not just a two-event filter.
- **Art. 12 (in the runbook):** the `member_erasure_requested` timestamp starts the **1-month response clock**; **requester identity verification** is a named, mandatory runbook step. No request state-machine (proportionate at ~0–2/year).

---

## 8. Documentation deliverables

- `docs/compliance/processing-records.md` → **F3 members RoPA** (currently TODO), incl. the documented residuals (§3) + sub-processor propagation.
- `docs/runbook/member-erasure.md` → DPO/admin runbook: receive → verify identity (Art. 12) → execute → completeness checklist (per §5 matrix) → the 10y tax legal-hold note → the "already-downloaded export / backups are out of reach" statement.
- `docs/observability.md` → the `erasure_outcome` metric + stuck-erasure alert.

---

## 9. Phases (Spec Kit user stories)

- **US1 (core):** `members.erased_at` migration · `eraseMember` orchestration + members/contacts sentinel-scrub (atomic tx) · `member_erasure_requested`/`member_erased` audit · reuse session/invitation/broadcast/renewal cascades with the erasure reason · idempotent/resumable · cross-tenant.
- **US2 (per-module scrub + triggers + F1):** the GUC-gated immutability-trigger exemptions (F7 `app.allow_broadcast_redaction`; reuse F4 `app.allow_pii_redaction`) · **F1 linked-user erasure** (security-reviewed) · F6 registration fan-out (hard-delete) · F7 content + deliveries tombstone · F8 scrub · the reconciliation sweep + `erasure_outcome` metric. **F4 needs no snapshot work (already frozen)** — its only work is the cron in US3.
- **US3 (scheduled redaction + surfaces + docs):** extend the non-member redact cron to member invoices (`member_id IS NOT NULL AND members.erased_at IS NOT NULL AND issue_date < now()-interval '10 years' AND not-yet-purged`, **separate branch** from the `member_id IS NULL` non-member arm, with a batch LIMIT + oldest-first ordering + backlog gauge) — tombstone snapshot **and** purge PDF blob bytes · admin "Erase member" UI + DPO log · F3 RoPA + erasure runbook · sub-processor (Resend/Stripe) propagation.

---

## 10. Testing (re-grounded on a DB-level per-table PII oracle)

The "re-export an erased member yields tombstones" oracle is **insufficient** (the F9 export adapter doesn't project the F4 buyer snapshot, F7 body, or the suppression list). Replace it with **one live-Neon assertion per §5 matrix row**, plus:

- **Tax-retention regression (critical):** issued invoices present + renderable + their buyer snapshot intact within the 10y window; **re-render the PDF after erase and assert buyer name/tax_id unchanged** (proves the snapshot, not the scrubbed member row, drives the PDF).
- **Suppression-list invariant** — `marketing_unsubscribes` survives.
- **No residual plaintext member email** in `broadcast_deliveries` / `broadcast_batch_delivery_events` after erase.
- **Sentinel-email collision** — erase two members each with a contact; assert no unique-index violation.
- **F6 fan-out throw-path** — inject a throwing `eraseAttendeePii` on registration 2 of 3; assert documented partial-completion behaviour (best-effort + audit + re-drive), not a silent abort.
- **F1 linked-user erasure** — after erase, no login-resolvable email; sessions revoked.
- **Legal-hold-set** (distinct from the cron) — erase a member with multiple invoices + a credit note; assert each is eligible by its own `issue_date+10y`.
- **Redact cron** — eligible (erased + >10y) is tombstoned **and** PDF bytes purged; a 10y-old invoice of a **non-erased** member is left fully intact (no regression of the non-member arm).
- **Audit-payload free-text** — historical `member_archived` payload with PII: assert erasure does **not** modify it (append-only) and that no NEW erasure audit carries PII.
- **Idempotency / partial-failure** — force an F7 cascade failure; re-run completes the F7 portion + does not double-emit `member_erased`.
- **Cross-tenant isolation** (Principle I Review-Gate blocker) + **RBAC contract grid** for the erase route (manager/member → 404; typed-phrase mismatch → 400; idempotent re-erase → 200/no-op; + optional kill-switch).

---

## 11. Decisions (updated post-review)

- Admin-mediated, immediate + typed-phrase confirm (no state-machine; no undo window).
- Anonymise-in-place (members+contacts via **sentinels**, not NULL) — forced by FK web + NOT NULL constraints.
- **F1 linked-user erasure is net-new build** (security-sensitive), not reuse.
- Tax: **frozen snapshot already exists** (no pre-scrub materialisation) → scrub is PDF-safe; 10y redaction via the existing **`issue_date` time-predicate** (no `legal_hold_until` column) + **PDF blob-byte purge**.
- Immutability triggers (F4/F7) require **GUC-gated redaction exemptions** for the scrub.
- Audit log is **never modified** (forward-fix + documented residual); F5 has **no PII to scrub**.
- Atomic tx = members+contacts only; cross-module = **post-commit best-effort + resumable**, with a **reconciliation sweep** + completion-proof `member_erased`.
- Re-identification analysis (§3) is part of the spec; documented residuals stated in the RoPA.

---

## Constitution check (high-level)

- **I Tenant isolation** — all scrubs in `runInTenant`; mandatory cross-tenant integration test.
- **III Clean Architecture** — `eraseMember` in members/application; per-module scrub via injected ports (no schema import); F1 erasure behind an auth port; F6 fan-out behind an events port.
- **IV PCI DSS** — F5 has no cardholder data; no scrub needed (SAQ-A reinforced).
- **II Test-First** — TDD; tax-retention regression + the DB-level per-table oracle authored before the scrub.
- **Security gate** — the F1 linked-user erasure + the immutability-trigger migrations are auth/PII/DB-guard surfaces → **≥2 reviewers + security-checklist sign-off**.
- **Compliance / retention** — honours §87/3 (tax 10y, redact snapshot **and** PDF after), append-only audit, Art. 21 suppression; sub-processor propagation (Resend/Stripe).

---

## Known limitations / deferred (US2a /code-review)

Three findings surfaced during the US2a /code-review were judged correct-but-deferred. Recorded here so US2b–d / US3 can address them — none block US2a ship.

1. **`user_erased` audit is tenant-NULL** (F1 identity-event convention). The F1 linked-login erasure emits its `user_erased` audit row WITHOUT a `tenant_id` (users are cross-tenant identities — the F1 convention), whereas `member_erased` IS tenant-scoped. Consequence: a per-tenant DPO Art.17-evidence query (`WHERE tenant_id = <slug>`) sees the `member_erased` proof but NOT the linked `user_erased` row — the F1 erasure is discoverable only by `target_user_id`. **Action (US3):** the DPO-evidence-log work should join the two by `target_user_id`, or the F9/GDPR-audit readers should UNION the linked users' tenant-NULL `user_erased` rows into a per-tenant evidence view.

2. **L1 outbox residual — stale-address mail not cancelled.** The L1 outbox-cancel set is `live-contact-emails ∪ login-email ∪ token-emails`. A pending `notifications_outbox` row whose frozen `to_email` is an ALREADY-removed contact's email (or an F4 buyer-snapshot address) falls OUTSIDE that set and is therefore NOT cancelled → a possible post-erasure mail to a stale address. This is the deliberately-safer side of the trade-off: cancelling on a removed contact's (ambiguously-owned) email could delete a peer member's legitimate pending mail (the cross-member over-delete). **Action (US3):** revisit only if widening the cancel scope — accept the residual for now.

3. **No US2d reconciler yet — failed F1 erasure strands until US2d.** A FAILED F1 linked-login erasure correctly WITHHOLDS `member_erased` (so completion is not falsely claimed), but there is NO automated re-drive on this branch — the failed login strands until US2d ships. Interim closure is a MANUAL operator re-drive of the idempotent `eraseMember` (safe to re-run; sentinels are id-derived). The stuck state is alerted via `authMetrics.eraseCascadeOutcome('failed' | 'last_admin' | 'threw')`. **Action (US2d):** build the automated reconciler keyed on the absence of `member_erased` for an erasure-initiated member.

### US2b /code-review — F7 broadcast-content erasure residuals

Four further findings surfaced during the US2b (F7 content scrub + deliveries tombstone) /code-review. All judged correct-but-accepted as documented residuals — none block US2b ship.

4. **Cross-author custom-recipient residual (US2b /code-review #5 + #11).** `scrubContentForMemberInTx` scrubs only the broadcasts the erased member AUTHORED (`WHERE requested_by_member_id = <member>`), and `tombstoneDeliveriesForMemberInTx` tombstones only deliveries addressed TO the member (matched by `recipient_email_lower`). Neither touches a DIFFERENT member's `broadcasts.custom_recipient_emails` to-list. So if the erased member's email appears in another member's custom send-list, that plaintext copy SURVIVES the erasure — the same "exclude-erased sweep is incomplete" class as the H4 finding (a write/peer-row path the authored/received scoping does not cover). This is an accepted residual under the design's authored-OR-received scoping: scrubbing every tenant-wide `custom_recipient_emails` array on each erasure is an unbounded fan-out the per-member path deliberately avoids. **Document in the RoPA** (the erased member's address may persist inside peer members' custom lists). **Action (US3, only if material):** a tenant-wide fan-out could scrub `custom_recipient_emails` arrays (and any other free-text address columns) wherever they contain the erased member's email — measure prevalence in real tenant data before building it.

5. **Sentinel-vocabulary divergence (US2b /code-review #7).** F7 broadcast content is scrubbed to the literal `'[redacted]'` (chosen by the F7 scrub for "this content was removed"), whereas F1/F3 member/user scrubs use `'[erased]'` (`src/modules/members/domain/erasure-sentinels.ts` → `ERASED_SENTINEL`). Two UNLINKED redaction vocabularies now coexist: a single-token PII-oracle grep (e.g. "find any row still holding real PII by looking for the absence of the sentinel") that checks for one token will MISS the other module's redacted rows. This is intentional (F7 deliberately chose `'[redacted]'`), but is recorded so any cross-module PII-oracle / erasure-completeness audit checks for BOTH tokens. **Clean Architecture note:** F7 (broadcasts) importing F3's `ERASED_SENTINEL` domain const would be a cross-context Domain import (forbidden by the `no-restricted-imports` barrel rule); a shared *kernel* const (e.g. in `src/modules/tenants/` or a `src/lib/` constant) would be the proper DRY fix IF this divergence ever becomes load-bearing. Deferred — no action unless a unified PII-oracle is built.

6. **`marketing_unsubscribes` is never-erased — `setMemberIdNull` is unwired (US2b /code-review #13).** The COMP-1 design decides `marketing_unsubscribes` rows are **retained whole on member-erasure** — including the plaintext `email_lower` — so the regulatory suppression invariant ("we will never contact this email again", GDPR Art.21 / PDPA §32) keeps working after the member is erased. The `marketing_unsubscribes.email_lower` plaintext is therefore an **intentional, documented residual**, NOT a severed/tombstoned column. The legacy `setMemberIdNull` repo method (whose port doc historically called it "the Art.17 cascade hook called by F3") is currently **unwired** — no production code calls it — and the erasure path does NOT sever `member_id`. **Deferred (US3) decision:** whether to sever `marketing_unsubscribes.member_id` (the member-FK back-reference) while RETAINING `email_lower` (so suppression survives) is an open US3 question; until then the row is retained intact and `setMemberIdNull` stays unwired (do not delete it — US3 may adopt it for the member-FK sever). The stale "SET NULL on Art.17" comments on the schema + port were reconciled to this never-erase decision on the US2b branch.

7. **Email-change / removed-contact delivery residual (US2b 2nd /code-review #2).** The `broadcast_deliveries` tombstone (`tombstoneDeliveriesForMemberInTx`) matches on the member's **LIVE-contact emails captured in-tx (pre-scrub)** (the live-contact address set `eraseMember` reads inside the atomic scrub tx, before the contacts' `removed_at` scrub — the linked-login axis was dropped to avoid a cross-member over-tombstone). `recipient_email_lower` on a delivery row is a **frozen send-time snapshot** — the address the broadcast was actually sent to. So a delivery addressed to a contact email that was **changed or removed BEFORE the erasure** (the row holds the OLD address, which is no longer in the member's live set) is **NOT tombstoned** → that stale address survives as plaintext in `recipient_email_lower` (and any email embedded in `error_message`) while erasure reports COMPLETE. This is the **deliberately-safer side** of the over-scrub trade-off: matching on a removed / ambiguously-owned address could over-scrub a *peer* member's delivery that legitimately holds the same address (the same cross-member over-delete lesson as the US2a outbox residual, §2 above). **Action (US3, only if material):** a durable email-history capture (every address a member has ever held) or a delivery-id resolution (correlate the delivery to the member at send time, not by address) could close it — measure prevalence of changed/removed-contact deliveries in real tenant data before building it. **Document in the RoPA** alongside the email-change outbox residual (§2).

### US2c /code-review — F6 registration fan-out residuals

The US2c (F6 `event_registrations` fan-out) /code-review surfaced **one consequential MEDIUM defect that was FIXED, not deferred**: the fan-out factory's per-registration `eraseOne` wrapped `eraseAttendeePii` in plain `runInTenant` (which COMMITS on a resolved `Result.err` — only a THROW rolls back), so a `hardDelete` err after the `quota_credit_back_archive` emit (step 4, before step 5) committed the credit-back audit while leaving the row alive → a US2d re-drive re-emitted it = forensic DOUBLE credit-back (and a completion-audit err after `hardDelete` left `pii_erasure_completed` permanently missing). Fixed by reusing the exported `runEraseAttendeePii` (wraps `runInTenantWithRollbackOnErr` — a `Result.err` now ROLLS BACK), commits `a3545f3a` (RED) → `c34cca80` (GREEN), security re-signed. The Task-5 sign-off had missed it because the "no double-credit" reasoning leaned on `eraseAttendeePii`'s `findPriorErasureCompletion` idempotency probe, which only fires when the row was DELETED (findById null) — not the partial-commit case where the row SURVIVES. **Generalizable lesson:** plain `runInTenant` COMMITS on a resolved `Result.err`; any fan-out reusing a use-case that emits audits BEFORE its terminal mutation MUST use `runInTenantWithRollbackOnErr` (same class as the F6 wave-5 CRIT-1).

The following five findings were judged correct-but-deferred — none block US2c ship.

8. **No member-level serialization on the F6 post-commit fan-out (US2c /code-review #5).** The F6 cascade is a POST-COMMIT best-effort fan-out (outside the scrub tx's `FOR UPDATE`) with no per-`(tenant, member)` lock, and `eraseAttendeePii` takes its `eventcreate-quota:` advisory lock ONLY on quota-COUNTED registrations (`(wasPartnership || wasCultural) && memberId !== null`). So two concurrent `eraseMember` passes for the same member (an admin double-submit, OR a US2d reconciler re-drive racing an original in-flight cascade) can each enumerate the same UNCOUNTED registration and both emit `pii_erasure_requested` before either `hardDelete` commits — duplicating that DPO "erasure requested" audit row; the second `hardDelete` then 404s as `invariant_violation` → `failedCount` → one spurious extra reconciler pass. Self-healing (idempotent; quota correctness preserved — quota is recomputed-on-read from live registration-row counts, not audit-derived) and rare (admin-initiated erasure ~0-2/yr). **Accepted residual.** **Action (US2d / US3, only if material):** a per-`(tenant, member)` advisory lock around the F6 fan-out (or treating the `invariant_violation`-on-already-deleted as `alreadyErased`, not `failed`) would remove the duplicate-`pii_erasure_requested` + the spurious `failedCount`; cross-linked into the US2d reconciler plan so it does not treat that benign `failedCount` as a hard error.

9. **`alreadyErasedCount` is a dead output (US2c /code-review #6).** `eraseAllRegistrationsForMember` tallies `{ erasedCount, alreadyErasedCount, failedCount }`, but the `EventRegistrationErasurePort` discriminated union has no arm carrying `alreadyErasedCount` and the adapter destructures only `{ erasedCount, failedCount }` (outcome decided solely by `failedCount`), so the three-way split collapses to two. Plus a narrow observability quirk: a re-drive that hits an already-erased (still-present, prior-`pii_erasure_completed`) row logs `erasedCount = 0` despite the work having succeeded. Cleanup-only, no correctness impact. **Deferred:** fold the idempotent-ok branch into a single `succeededCount` if the port is ever revised.

10. **`requestId` not threaded into the F6 per-registration audits (US2c /code-review #7).** `requestId` is plumbed `eraseMember → adapter → fan-out input` but `eraseAttendeePii` has no `requestId` slot, so the F6 `pii_erasure_requested` / `quota_credit_back_archive` / `pii_erasure_completed` audit rows (and the fan-out's per-failure logs) cannot be joined to the originating member-erasure request id — a DPO/ops correlation gap, even though every other cascade's caller-side logs in `erase-member.ts` carry `requestId`. **Action (US3, observability):** threading `requestId` into the per-registration audits touches the SHARED admin-route `EraseAttendeePiiInput` + its three audit payloads (used by the admin erasure route too), so it is a cross-cutting observability change deferred to the US3 DPO-evidence-log work (align with the tenant-NULL `user_erased` correlation gap, §1).

11. **SC-012 erasure-latency metric skewed for multi-registration members (US2c /code-review #8).** The adapter mints `occurredAt = new Date()` ONCE per fan-out and threads the same instant to every per-registration `eraseAttendeePii`, so its `completedWithinSecondsOfRequest` (the SC-012 PDPA §30 / GDPR Art.17 latency-of-erasure metric) for the 2nd..Nth registration is inflated by the fan-out's own cumulative elapsed time. **Judged by-design-acceptable:** the member-erasure request instant IS a defensible reference for all N registrations (the request is the single member-erasure), and `Math.max(0, …)` bounds it; metric skew only, the row is still hard-deleted and quota credited back. Recorded so a latency-dashboard reader knows multi-registration members read slightly high; no action unless per-registration latency precision becomes load-bearing.

12. **Checked id-branding on F6 hot-path DB reads (US2c /code-review #9, PLAUSIBLE).** The fan-out factory brands `event_registrations`-read `event_id` / `registration_id` with the strict-UUID-v4 `asEventId` / `asRegistrationId` (which throw on a non-v4 uuid) rather than the `…Unchecked` variants F6 documents for hot-path Drizzle row reads. **Safe today** (both columns are `uuid DEFAULT gen_random_uuid()` = always v4, no insert path supplies an explicit id) and **non-actionable-in-place** (the `…Unchecked` variants are ESLint-banned outside `infrastructure/**`, so the barrel factory cannot use them anyway). Latent: a future migration/import/MTA data path that ever stores a non-v4 uuid would make `eraseOne` throw → `failedCount` → that member's erasure never completes (re-throws on every reconciler re-drive). Recorded as a robustness/convention note; revisit only if a non-v4 uuid source is ever introduced.

### US2d /code-review — reconciler residuals

The US2d (reconciliation sweep) /code-review surfaced 15 findings, **0 CRITICAL/0 HIGH** (the reconciler is a thin re-driver over the already-reviewed idempotent `eraseMember`). Three were **FIXED on the branch** (not deferred): `#15` the candidate query `ORDER BY erased_at DESC`→`ASC` (oldest-erasure-first, so the rows nearest the Art.12 one-month deadline are reconciled first under a backlog — commit `f9bd7a60`); `#12` the partial index `members_erased_at_idx ON members (erased_at) WHERE erased_at IS NOT NULL` that migration 0221 promised the sweep would add (delivered as migration 0226, commit `59b3fea2`); and `#8/#9/#10` route cleanups (redundant `asMemberId` cast, re-spelled `stuck` type, derivable `processed` counter — `f9bd7a60`). The headline `#1` was closed **operationally** (see item 13). The remaining seven are correct-but-deferred residuals — none block US2d ship.

13. **Concurrent-tick double `member_erased` + double `reconciled` metric (US2d /code-review #1 MEDIUM / #5 / #7).** The reconciler has no single-flight guard: the candidate-select's `FOR UPDATE OF m SKIP LOCKED` member-row lock is released when that tx commits, BEFORE the per-member re-drive loop, and `eraseMember`'s `member_erased` completion emit (its own tx, after the slow post-commit cascades) has no compare-and-set / `NOT EXISTS` guard. So two OVERLAPPING reconciler ticks can both re-select a still-stuck member (its `member_erased` not yet landed) and both re-drive it → a duplicate `member_erased` append-only completion-proof row + a double `reconciled` count/metric. **Closed OPERATIONALLY (the conventional cron single-flight control):** the cron-job.org HTTP **timeout is set = the route `maxDuration` (300s)** (`docs/runbooks/cron-jobs.md` § Members — reconcile-erasures), so cron-job.org WAITS for the function to return (Vercel hard-kills at 300s) and a retry-ON 500 only ever fires AFTER the prior tick returned — sequential, by which point the completed members' `member_erased` rows have landed and the anti-join (`NOT EXISTS member_erased`) excludes them. No PII survival / data loss / crash; the residual is a rare extra append-only audit row + a metric over-count (admin-initiated erasure ~0-2/yr). **Deferred defense-in-depth (US3, only if the operational control proves insufficient):** a code-level exactly-once guarantee on the completion proof — either a partial unique index on `audit_log (tenant_id, payload->>'member_id') WHERE event_type='member_erased'` with `ON CONFLICT DO NOTHING`, or a `pg_advisory_xact_lock(tenant, member)` + `NOT EXISTS` check inside the `member_erased` emit tx. NOT done now because it changes the security-signed US1-core `eraseMember` emit semantics + a shared append-only table, and the design already documents append-only re-emit as benign (`erase-member.ts:480-482`).

14. **`members.erased_at` is rewritten to a fresh `now()` on every re-drive (US2d /code-review #2).** `scrubPiiInTx` unconditionally sets `erased_at = opts.erasedAt`, and `eraseMember` passes a fresh `clock.now()` each pass (the `alreadyErased` flag gates only the `member_erasure_requested` re-emit, not the scrub). So a permanently-stuck member's `erased_at` is re-bumped each tick. Consequence: (a) it sorts to the head under the new `ORDER BY erased_at ASC`... actually it sorts toward the TAIL (newest), so it does NOT starve older rows — but (b) `erased_at` is no longer a faithful "first erasure time" for a naive forensic read. **Mitigated by design:** the authoritative Art.12 clock-start is the `member_erasure_requested` audit (emitted ONCE, never re-bumped), which is where DPO/forensic queries should read the erasure time — `members.erased_at` is an operational "scrub committed" marker, not the legal timestamp. **Deferred (US3, optional):** make `scrubPiiInTx` preserve an existing `erased_at` (`COALESCE(erased_at, opts.erasedAt)`) so it's stable; touches US1-core.

15. **Mixed `still_pending` + `error` tick retries the `still_pending` members too (US2d /code-review #3).** A tick where member A throws (`error`) AND member B is `still_pending` returns 500 (because `summary.error > 0`) → cron-job.org retries the WHOLE tick → B is re-driven again within the retry backoff instead of waiting the 30-min cadence, re-running its full scrub + cascades (multiple Neon txs). NOT a correctness bug (the `alreadyErased` pre-flight skips the duplicate `member_erasure_requested`, `member_erased` stays gated on `allCascadesClean`) — only amplified DB work on the already-failing transient window. Bounded by `MAX_PER_TICK=50` + ~0-2 erasures/yr. **Deferred (US3, only if material):** a per-member retry throttle (`last_reconcile_attempt_at` cooldown), or returning 200 for a mixed tick and relying on the next scheduled tick. Accepted for now.

16. **Read-path `reason` has no symmetric validation — an unknown reason silently coerces to `gdpr_erasure_request` (US2d /code-review #4 PLAUSIBLE / #11).** `findStuckErasuresInTx` reads `payload->>'reason'` from the `member_erasure_requested` audit and maps `r.reason === 'pdpa_deletion_request' ? 'pdpa_deletion_request' : 'gdpr_erasure_request'` — any OTHER value silently becomes `gdpr_erasure_request`, with no log/metric, and is then stamped into the re-driven `member_erased` completion payload (wrong legal basis). **Not reachable today:** the only production writer is `eraseMember`, which validates `reason` against the strict `z.enum(['gdpr_erasure_request','pdpa_deletion_request'])` before emitting — so only the two literals can ever be stored. **Latent hazard:** a FUTURE third erasure reason added to the write enum WITHOUT updating this read-path map would be silently mislabelled. **Deferred (US3):** when/if a third reason is added, replace the ternary with `r.reason as EraseMemberInput['reason']` and let the downstream `eraseMember` zod enum reject an unexpected value (surfaces as `invalid_body`) instead of relabelling it.

17. **F1 cascade re-emits `user_erased` on every re-drive of a member stuck on a NON-F1 cascade (US2d /code-review #6).** `eraseMember`'s F1 loop iterates the UNFILTERED linked-user work-list (the deliberate Critical-US2a fix, so a previously-FAILED login is re-attempted) and calls the idempotent `eraseUser`, which appends a fresh `user_erased` audit row on every successful pass — there is no per-user "already erased, skip" short-circuit (the single `allCascadesClean` flag re-runs the whole F1 loop even when F1 itself is already clean). A member stuck for an extended window on, e.g., a transient F7 content-scrub outage is re-driven every 30 min → ~48 duplicate `user_erased` rows/day per linked login (up to ~1440 over the one-month clock). Append-only audit BLOAT, not correctness/leak. The "rare re-drive ⇒ acceptable audit noise" justification (`erase-member.ts:631-634`) weakens once the reconciler makes re-drives routine. **Deferred (US3, only if material):** a per-user already-erased skip that PRESERVES the unfiltered re-read for genuinely-failed logins (non-trivial — must not regress the US2a Critical re-drive-stability fix). Bounded by ~0-2 erasures/yr + typically 1 login/member.

18. **Full atomic scrub tx re-runs on every re-drive (US2d /code-review #13).** The reconciler only ever feeds already-erased members, yet each `eraseMember` re-drive re-executes the entire scrub tx (re-scrub sentinel members + contacts, re-revoke sessions, re-invalidate tokens, re-cancel outbox, re-run the delivery tombstone over an empty live-email set) before reaching the one post-commit cascade that actually needs retrying — all byte-identical no-ops. This is the DELIBERATELY idempotent design (heavily justified to survive the I-1 / Critical Task-6 / delivery-tombstone hazards), so a naive short-circuit would be unsafe. Per-member wasted work on a rare path (~0-2 erasures/yr, ≤50/tick). **Deferred (US3, only if material):** a guarded scrub skip that preserves the unfiltered linked-user re-read; the cheap fix is non-trivial. Accepted.

19. **No grace/min-age window — the reconciler can re-drive an IN-FLIGHT (not-yet-stuck) erasure (US2d /code-review #14).** The stuck-detection predicate (`erased_at IS NOT NULL AND NOT EXISTS member_erased`) has no min-age filter, so during a NORMAL admin erasure's few-second post-commit cascade window (scrub tx committed → `erased_at` set + row-lock released, but `member_erased` not yet emitted) a reconciler tick that fires in that window sees the member as "stuck" and re-drives it concurrently with the still-running original. Cascades are idempotent (no corruption); the residual is the same benign duplicate `member_erased` + redundant cascade work as item 13. Extremely rare (a few-second window vs the 30-min cadence × ~0-2 erasures/yr). **Deferred (US3, only if material):** a min-age filter (`erased_at < now() - INTERVAL '15 min'`) so `NOT EXISTS` means "cascade FAILED" rather than "cascade may still be RUNNING" — note this interacts with item 14 (the `erased_at` re-bump), so the grace window should key on the never-re-bumped `member_erasure_requested` audit timestamp, or item 14 must be fixed first. Accepted for now (the operational single-flight in item 13 + idempotency cover the practical risk).
