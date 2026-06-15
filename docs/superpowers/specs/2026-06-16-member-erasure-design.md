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
| **members** | Anonymise-in-place: `company_name → '[erased]'`; `tax_id`, `address_*`, `city`, `province`, `postal_code`, `description`, `notes`, `website`, **`turnover_thb`**, **`founded_year`** → NULL. Keep `member_id`, `member_number`, `plan_*`, dates. **Add `erased_at` column** (new migration). | atomic tx |
| **contacts** | Anonymise-in-place with **sentinels** (cols are NOT NULL): `first_name/last_name → '[erased]'`, `email →` per-row non-PII sentinel, `phone/date_of_birth/role_title/preferred_language` → NULL. **Set `removed_at`** so the row leaves the `lower(email) WHERE removed_at IS NULL` partial unique index (avoids sentinel-email collision across erased members). | atomic tx |
| **audit_log** | **Never UPDATE/DELETE** (append-only). Erasure emits only non-PII audit. Legacy free-text PII = documented residual (§3/§6). | — |
| **F1 users (linked)** | **Build** the erasure (see §4): anonymise email/password/name + revoke sessions + `user_erased` audit. | post-commit cascade |
| **F4 invoices / credit-notes** | **Keep** the document/number/amounts/VAT. Buyer identity is **already snapshot-frozen** (`member_identity_snapshot` jsonb; PDF bytes frozen on Blob) — **CONFIRMED**, so the member scrub **cannot corrupt** the tax PDF. **No `legal_hold_until` column** — the 10y redaction is a time-predicate concern (`issue_date < now() - interval '10 years'`). | (deferred, §9 US3) |
| **F5 payments / refunds / processor_events** | **No action** — no buyer PII (cardholder data at Stripe, SAQ-A; `card_last4`/brand/exp are tokenised; `processor_events` stores `payload_sha256` only). `member_id` linkage is pseudonymised by the members scrub. *(Strengthens the SAQ-A story.)* | — |
| **F6 event_registrations** (matched) | **Hard-delete** each registration where `matched_member_id = member` (reuse `eraseAttendeePii` semantics + quota credit-back + advisory lock), via a new `eraseAllRegistrationsForMember` fan-out. Idempotent (re-run finds 0). | post-commit cascade |
| **F7 broadcasts** | Scrub `subject`, `body_html`, `from_name`, `reply_to_email`, `custom_recipient_emails` — **under a new `app.allow_broadcast_redaction` GUC + an amended immutability trigger** that whitelists only these PII columns. Tombstone `broadcast_deliveries.recipient_email_lower` **and** `broadcast_batch_delivery_events` recipient data for the member (insert-only tables → GUC-gated update). Cancel in-flight (existing hook). | post-commit cascade (GUC scope) |
| **F8 renewal_cycles** | Cancel in-flight (existing hook); scrub member-linked PII references (verify which columns at spec time). | post-commit cascade |
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
