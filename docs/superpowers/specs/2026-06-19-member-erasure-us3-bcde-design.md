# COMP-1 US3 (B / C / D / E) — Design

**Status:** Design approved 2026-06-19. Sub-projects **B, C, D, E** of COMP-1 US3 (the final phase). US3-**A** (admin erase route + UI) has its own doc (`2026-06-19-member-erasure-us3a-admin-ui-design.md`). Complements the master design `2026-06-16-member-erasure-design.md`. **Implementation is SEQUENCED** (one sub-project at a time, each its own branch + plan + review — NOT parallel built), to avoid worktree/migration/`eraseMember`-conflict complexity. Suggested order: **A → C → B → D → E** (A+C share `eraseMember` so do them adjacent; B/D are independent; E documents the rest).

---

## US3-B — 10-year member-invoice tax redaction (new sibling cron)

**Decision:** a **new sibling cron** `redact-expired-member-invoices`, reusing the redaction core extracted from the existing event-buyer cron.

**Purpose (Thai RD §87/3 + §86/4):** when a member is erased, their F4 tax-document buyer snapshot (`member_identity_snapshot`: legal name / address / tax_id / contact) is RETAINED under the statutory tax-retention exception — then **redacted after the 10-year window elapses** (DB snapshot **and** the PDF blob bytes). This completes the Art.17 erasure for the tax-document copy once the legal hold lifts.

**Reuse (the whole mechanism already exists):** `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts` already does GUC bypass (`SET LOCAL app.allow_pii_redaction='true'`), the 5-field `jsonb_build_object` snapshot tombstone, the **post-commit PDF blob-byte purge** (`vercelBlobAdapter.delete`), the `pii_blob_purged_at` retry marker, and `FOR UPDATE SKIP LOCKED`. The immutability trigger (migrations 0205/0206) already permits ONLY `member_identity_snapshot` + `pii_blob_purged_at` under the GUC. The PDF re-renders from the frozen snapshot, so a redacted snapshot → a redacted PDF.

**What the member arm adds (predicate + an erasure gate — NOT pure "predicate change"):**
- Eligibility: **`member_id IS NOT NULL`** `AND issue_date < (now() - interval '10 years')::date AND status <> 'draft'` **joined to `members` where `members.erased_at IS NOT NULL`** (only an ERASED member's invoice is redacted — a non-erased member's old invoice is retained, the relationship is live), plus the same idempotency arm as the event cron (`legal_name <> '[REDACTED]'` OR redacted-but-`pii_blob_purged_at IS NULL` with a blob key present), `FOR UPDATE SKIP LOCKED`. **Gate on `member_id IS NOT NULL`, NOT `invoice_subject='membership'`** (thai-tax review HIGH): a **matched-member EVENT invoice** (`invoice_subject='event' AND member_id IS NOT NULL`) carries the member's buyer PII too and would otherwise fall in the GAP between the two crons (the event-buyer cron only handles `member_id IS NULL`).
- The redaction STEP is identical → **extract it into a shared invoicing application use-case** that both crons call; refactor the event-buyer cron to call the helper (no behaviour change — covered by its existing tests). If extraction proves too invasive, mirror the inline logic (documented duplication) — prefer extraction.
- **CREDIT NOTES ARE IN SCOPE (thai-tax review BLOCKER — NOT a follow-up).** Credit notes (`credit_notes`) print the SAME buyer PII on their DB snapshot + PDF and carry the SAME 10-year §87/3 retention, but the reused mechanism does NOT cover them: the credit-notes immutability trigger (migration 0027) has NO `app.allow_pii_redaction` GUC arm (a redaction UPDATE would RAISE), `credit_notes` has NO `pii_blob_purged_at` marker, and NO `member_id` (it joins to the member via its original invoice). Shipping invoices-only = an INCOMPLETE Art.17/§33 erasure. So US3-B MUST ALSO: (a) add a `app.allow_pii_redaction` GUC arm to the credit-notes immutability trigger (mirror migration 0205/0206) + a `pii_blob_purged_at` marker column on `credit_notes`; (b) find an erased member's >10y credit notes by joining `credit_notes → original invoice → member_id` (+ the credit-note's own issue/date for the 10y anchor — confirm whether the clock is the credit note's date or the original invoice's during the plan); (c) tombstone the credit-note buyer snapshot + purge its PDF blob via the same shared helper. **This adds a migration to US3-B** (the credit_notes GUC arm + marker).
- **Audit:** reuse the event cron's existing redaction audit event (e.g. `invoice_buyer_pii_redacted` — confirm the exact type) with a member discriminator in the payload; **no new audit type if reusable**. The invoice redaction reuses the GUC/columns/trigger (no migration); only the **credit-notes** arm needs the GUC-arm + marker migration above.
- **No live trigger for ~10 years** (SweCham's earliest invoices are 2026); ships for correctness, fires from ~2036.

**Tests:** integration on live Neon — an erased member's >10y invoice (membership AND matched-member event) is tombstoned **and** its PDF blob purged; **the member's >10y credit notes are likewise redacted + purged**; a **non-erased** member's >10y invoice is left fully intact (no regression of the active-member case); a <10y erased member's invoice is left; idempotent re-run; the **tax-retention regression** (re-render the PDF before redaction → buyer snapshot intact; after → redacted — proving the frozen snapshot, not the live scrubbed member, drives the PDF) for BOTH invoices and credit notes; the §87 no-gaps integrity (the row + number + amounts + seller identity survive; only buyer PII is tombstoned). Confirm the event-buyer cron stays green after the helper extraction.

**Scope:** in — the member-invoice + matched-member-event-invoice + **credit-note** redaction cron + the shared-helper extraction + the credit-notes GUC-arm/marker migration. Out — anything touching the event-buyer (`member_id IS NULL`) eligibility; the redaction of any tax-relevant non-PII field (seller, amounts, number, VAT — all PRESERVED for the tax record's integrity).

---

## US3-C — Sub-processor erasure propagation (best-effort cascade)

**Decision:** build a **best-effort cascade** (`SubprocessorErasurePort`) for compliance completeness + future-proofing — even though grounding shows the present-day reality is near-empty (no Stripe customers; ephemeral Resend audiences). Wired into `eraseMember` as a post-commit cascade.

**Grounding realities (shape the design):**
- **Stripe:** members have **no customer object** (`stripe_customer_id` does not exist; payments are ad-hoc Payment Intents). → the Stripe arm is a **defensive no-op**: the adapter checks for a customer (none today) and returns `ok` with nothing done; future-proof if a member↔customer model is ever introduced.
- **Resend:** audiences are **ephemeral, created per-broadcast** from our recipient list (which already excludes erased/suppressed members via the H4 sweep); there is **no clean per-contact removal API in the current gateway**, and the suppression list (`marketing_unsubscribes`) lives in OUR DB and is **retained** (memberId→NULL, never deleted). The Resend arm is therefore a bounded best-effort over the audiences we can DERIVE from the member's broadcast history.

**Design:**
- New port `SubprocessorErasurePort` (members/application) + adapter (members/infrastructure), wired in `buildEraseMemberDeps` and called in `eraseMember` **after the F6 fan-out (≈ erase-member.ts:781), before the `allCascadesClean → member_erased` gating (≈:786)** — mirroring the F1/F6/F7/F8 cascades (try/catch, any non-`ok` flips `allCascadesClean`, the US2d reconciler re-drives on failure). The adapter reaches the broadcasts **Resend gateway via its public barrel** (`resendBroadcastsGateway`, extended with a `removeContactFromAudience` wrapper). **This is the cascade that shares `eraseMember` with US3-A → sequence A then C.**
- **Pre-scrub email capture:** the member's live contact emails are already read inside the atomic scrub tx for the delivery tombstone (`listLiveEmailsForMemberInTx`); thread that SAME captured email set into the post-commit subprocessor cascade input (the contacts are sentinel-scrubbed by the time the cascade runs, so the cascade must NOT re-read them).
- **Resend arm:** add a `removeContactFromAudience(audienceId, email)` wrapper to the broadcasts Resend gateway (it isn't wrapped today). The adapter derives the member's audiences from the member's broadcast-delivery history (delivery → broadcast → `resend_audience_id`), and best-effort `contacts.remove` for each captured email × audience. A removal of an already-absent contact is treated as `ok` (404→ok); a transient failure → `partial`/`failed` → reconciler retries. **The suppression entry is NEVER removed.** Audiences we cannot enumerate are a **documented residual** (RoPA, US3-E).
- **Stripe arm:** a **PURE no-op that touches ZERO payments symbols** (architect review S1 — the `payments` barrel exports no Stripe client, and there is no member↔customer model to reach). The adapter checks for a member↔Stripe-customer link (none exists today) and returns `ok` with nothing done — it does NOT import the payments Stripe client. **Future-proofing path (when/if a member↔customer model is added):** add a `customerErasure` use-case INSIDE the `payments` module and export it from the payments barrel; the members adapter calls THAT — never import payments infrastructure into members infrastructure (Principle III). Make this an explicit US3-C plan Task-1 note.
- **New audit type** `subprocessor_erasure_propagated` — 4-place registration (members audit-port union **31→32** + the shared pgEnum + BOTH count tests `f3-audit-event-type-count` AND the integration completeness count) + a **migration** (`ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS`). Payload: `{ member_id, reason, resend_outcome, resend_contacts_removed_count, stripe_outcome }` — **no erased PII** (ids + outcomes only). This is the ONLY US3 migration (sequenced, no collision).
- **Idempotent + reconciler-safe:** re-running the cascade (a reconciler re-drive) is a no-op for already-removed contacts + the no-op Stripe arm.

**Tests:** unit (Stripe no-op returns `ok`; Resend best-effort + a transient failure → `partial` flips `allCascadesClean`; an already-removed contact → `ok`); integration (the cascade runs post-commit, emits `subprocessor_erasure_propagated`, the reconciler re-drives a failed propagation to completion). The new audit type's 4-place registration verified by the count tests. **Security review** (touches US1-core `eraseMember` + a new external-API surface).

**Scope:** in — the subprocessor cascade (Resend best-effort + Stripe no-op + audit). Out — a full provider-side audit/reconciliation of all historical Resend data (documented residual); any Stripe customer model (none exists).

---

## US3-D — DPO erasure-evidence log (dedicated admin page)

**Decision:** a new **dedicated read-only page** `/admin/compliance/erasure-log`, grouped by erased member, with full Art.17 evidence + half-run detection.

**Purpose:** give the DPO a single accountable view of every erasure and its evidence — to answer "is this member's erasure complete, and where is the proof?" and to surface incomplete (stuck) erasures.

**The crux (US2a /code-review #1 — the tenant-NULL join):** `member_erasure_requested` + `member_erased` are tenant-scoped (`payload->>'member_id'`), but the linked `user_erased` rows are written **tenant-NULL** (F1 identity convention) with `target_user_id`. The existing F9 readers (`audit-query-repo.ts`, `gdpr-audit-subset-repo.ts`) apply `WHERE tenant_id = ctx.slug`, which **excludes** the tenant-NULL `user_erased` rows. So a per-tenant evidence query MISSES the user-erasure proof unless it UNIONs them in.

**Design:**
- A **dedicated `erasureEvidenceReadAdapter`** (architect review N1 — do NOT bolt a third arm onto `gdprAuditSubsetReadAdapter`/`audit-query-repo`, whose `WHERE tenant_id = ctx.slug` predicate is the documented app-layer half of two-layer isolation; a deliberate tenant-NULL read inside it would make that contract ambiguous. The exception lives in ONE file the security review can point at). Its query:
  ```sql
  WHERE (
    tenant_id = ${slug} AND event_type IN ('member_erasure_requested','member_erased') AND payload->>'member_id' = ${memberId}
  ) OR (
    tenant_id IS NULL AND event_type = 'user_erased' AND target_user_id = ANY(${memberLinkedUserIds})
  )
  ```
  The member's linked user ids come from `listAllLinkedUserIdsForMemberInTx` (survives the erasure scrub — `linked_user_id` is deliberately not nulled). This **deliberately breaks the base reader's tenant-exclusion for the single `user_erased` event**, scoped strictly to the member's own linked users.
- **⚠️ SECURITY-CRITICAL (security review FIX-1) — `audit_log` RLS is PERMISSIVE** (`tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')`, migration 0007), so tenant-NULL `user_erased` rows are visible to EVERY tenant context at the DB layer — the ONLY cross-tenant wall for them is the app-layer tenant filter that this adapter removes. Therefore: **when the member has NO linked login (`memberLinkedUserIds` is empty), the `user_erased` arm MUST be DROPPED ENTIRELY** — there must be NO code path that emits `tenant_id IS NULL AND event_type='user_erased'` without a NON-EMPTY `target_user_id = ANY(...)` bound (an empty `ANY('{}')` or an unbounded arm would leak EVERY tenant's `user_erased` rows). A unit test MUST pin this empty-set behaviour.
- **The page** lists erasures grouped by erased member, each row showing: requested-at + reason + the US3-A Art.12 attestation + note · erased-at (completion) + the cascade outcomes · the linked `user_erased` proof(s) · **the US3-B tax-redaction outcome + the US3-C sub-processor-propagation outcome** (compliance review M-3 — the evidence record must show the full lifecycle, not just the core scrub) · a **half-run flag** (`member_erasure_requested` present but `member_erased` absent → incomplete; cross-link the US2d reconciler / the `members_erasure_outcome_total{still_pending}` signal). Admin-only (+ the DPO role if distinct — confirm in plan); read-only.
- **No migration** (read-only). i18n (EN/TH/SV) for the page. Reuses the F9 audit-viewer page shell + keyset pagination.

**Tests:** integration on live Neon — the evidence query returns the member's full evidence INCLUDING the tenant-NULL `user_erased` (the load-bearing union); a half-run member (requested, no erased) is flagged; **empty linked-users** (a member with no linked login) returns the tenant-scoped evidence with the `user_erased` arm DROPPED (security FIX-1 — and a unit test proving no unbounded tenant-NULL read is issued); **cross-tenant isolation (Principle-I gate blocker)** including the **adversarial SHARED-`user_id` case (security review FIX-2):** an erased user who is a contact of a member in BOTH tenant A and tenant B — assert tenant A's DPO sees that user's tenant-NULL `user_erased` (correct, the user is A's member's linked login) but CANNOT see tenant B's tenant-SCOPED erasure events for B's member. E2E (`@a11y`/`@i18n`).

**Scope:** in — the evidence page + the union reader + half-run detection. Out — a CSV/PDF export of the evidence (follow-up if the DPO needs a portable artifact — note in plan); editing/acting on erasures (read-only).

---

## US3-E — RoPA + member-erasure runbook (docs)

**Decision:** straightforward docs per master design §118-119; absorbs the US3-C sub-processor residual.

- **`docs/compliance/processing-records.md`** — the F3 members **RoPA** (currently TODO), satisfying GDPR Art.30 (compliance review H-2 — make these EXPLICIT, as a checklist): processing activities; PII categories (incl. the business quasi-identifiers `turnover_thb`/`founded_year`); lawful basis; retention (incl. the **10-year tax legal hold**, US3-B); **recipients / sub-processors with the cross-border transfer basis (Art.30(1)(e)):** Resend + Stripe + Vercel + Neon, the **Singapore (`sin1` / `ap-southeast-1`) hosting** under PDPA §28 + GDPR SCCs (per the master hosting deviation), with the US3-C best-effort propagation + the documented Resend historical-audience residual; data-subject rights; and an explicit **documented-residuals checklist** — master §3/§48 + the C sub-processor residual + the US2b email-change/removed-contact delivery residual + already-downloaded F9 export ZIPs + **backup / PITR snapshots (re-erased on any restore)** + NULL-`matched_member_id` event registrations.
- **`docs/runbook/member-erasure.md`** — the DPO/admin operational procedure: receive request → **verify identity (Art.12 → the US3-A attestation)** → execute (the US3-A UI) → completeness checklist (per the master §5 matrix) → the **10-year tax legal-hold** note (US3-B) → the **sub-processor propagation + residual** note (US3-C) → the **"already-downloaded export / backups are out of reach"** statement → the **half-run / reconciler** note (US2d) → point to the **erasure-evidence log** (US3-D) for proof.
- **Scope:** docs only; pairs with whichever sub-projects ship. Should be the LAST sub-project (it documents A-D).

---

## Cross-cutting (all of B/C/D/E)

- **Tenant isolation (Principle I):** B (cron under per-tenant context, member-scoped invoice redaction); C (cascade under the member's tenant context, the external calls scoped to the member's own data); D (the deliberate tenant-NULL `user_erased` read is the ONE careful exception — scoped to the member's own linked users + a cross-tenant gate-blocker test). All three need their cross-tenant integration test.
- **Audit & migrations:** only **C** adds a new audit *type* (`subprocessor_erasure_propagated`, 31→32, + an `ALTER TYPE` migration). **B** adds a migration too — NOT a new audit type, but the **credit-notes GUC arm + `pii_blob_purged_at` marker** (thai-tax BLOCKER); it reuses the existing redaction audit. D is read-only; E is docs. Implementation is sequenced (A→C→B→D→E), so the two migrations get consecutive numbers with no collision.
- **Test-First** (Principle II): every sub-project's acceptance tests authored before implementation; live-Neon integration for B/C/D.
- **Security review** (PII/erasure surface, ≥2 reviewers): C (US1-core + external APIs), D (the tenant-NULL read), B (the GUC redaction path). E reviewed for accuracy.
- **Sequencing:** A → C (share `eraseMember`) → B (invoicing, independent) → D (insights/audit read, independent) → E (docs, last). Each its own branch + plan + PR.

## Constitution check (all)
- **I tenant isolation (NON-NEG):** per-sub-project cross-tenant test; D's tenant-NULL read is the one audited exception (scoped + tested). ✓
- **II Test-First (NON-NEG):** acceptance tests first. ✓
- **III Clean Architecture (NON-NEG):** C's port/adapter in members, reaching broadcasts/payments only via barrels; D's reader in the audit/insights infra; B's shared helper in invoicing. ✓
- **Data Privacy & Security (NON-NEG):** the whole of US3 completes the Art.17/§33 lifecycle (the 10y tax hold, sub-processor propagation, the DPO evidence log, the RoPA). Security sign-off per surface. ✓
- **IV PCI DSS (NON-NEG):** C's Stripe arm touches no card data (Payment Intents / SAQ-A preserved; the no-op customer arm holds only email/name PII, none today). ✓
- No deviation requiring a Complexity-Tracking entry.
