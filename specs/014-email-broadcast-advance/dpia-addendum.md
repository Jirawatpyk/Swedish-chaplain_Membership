# F7.1a Data Protection Impact Assessment Addendum

**Parent DPIA**: F7 MVP DPIA (`specs/010-email-broadcast/dpia.md`)
**Scope**: F7.1a Email Broadcast Advanced (US1 Pagination + US2 Image Embedding + US7 Multi-Template Library)
**Author**: F7.1a maintainer (`specs/014-email-broadcast-advance/`)
**Last reviewed**: 2026-05-21 (T153 — Phase 6 polish, CHK036 closure)
**Status**: Addendum to the F7 MVP DPIA. The parent DPIA covers the broadcast machinery itself (marketing-consent, suppression list, recipient PII); this addendum covers ONLY the F7.1a-specific surfaces (US1 batch-manifest processing, US2 image upload + ClamAV scan, US7 admin-authored templates).

---

## 1. Scope of new processing

F7.1a introduces three new processing surfaces. Each is assessed independently below.

### 1.1 US1 — Per-batch dispatch (pagination)

**New personal data**: NONE. Batch manifests carry `(tenant_id, broadcast_id, batch_index, recipient_count, idempotency_key, status)`. No recipient identifiers persisted in `broadcast_batch_manifests`. The recipient list itself stays in `broadcast_deliveries` (existing F7 MVP table).

**Processing**: dispatch-side fan-out (split a recipient list into batches; serialise per-batch Resend audience creation; track per-batch delivered/bounced/complained counts).

**Risk delta vs F7 MVP**: NONE. Same data classes; same retention; same RLS+FORCE policies; same audit-trail integrity.

### 1.2 US2 — Inline image embedding + ClamAV scan

**New personal data**: image bytes uploaded by members. May contain PII (photos of people, screenshots with personal information). Stored at Vercel Blob with content-hash addressing.

**New sub-processor**: self-hosted ClamAV on Fly.io `sin` region VM (the daemon is provider-controlled infrastructure but the scan is invoked by F7.1a application code; the daemon does NOT persist scanned bytes).

**Lawful basis (GDPR Art. 6)**:
- `6(1)(b)` — performance of contract (member uses the chamber's broadcast service to communicate with other members; image embedding is part of that service).
- `6(1)(c)` — legal obligation (PDPA Section 37 incident notification — virus scan is part of the platform's "appropriate technical measures" duty).
- `6(1)(f)` — legitimate interest (preventing platform abuse via malware distribution).

**Retention**:
- Image bytes in Vercel Blob: co-terminate with the broadcast row that references them. Drafts deleted within 30 days (existing F7 MVP `prune-expired-drafts` cron extension to also delete bound images). Sent broadcasts retain images for the broadcast's retention horizon (5y default).
- ClamAV scan logs: not persisted by the application. The Fly.io VM rotates daily logs locally; no copy is retained centrally.

**Cross-border transfer**: Vercel Blob storage region `sin1` (Singapore). Fly.io VM region `sin`. Both covered by the existing F1 hosting deviation (Constitution § Compliance: Hosting & Residency). Thailand PDPA Section 28 cross-border provisions apply; Swedish/EU data subjects covered by GDPR SCCs with Vercel and Fly.io.

**Risk delta vs F7 MVP**: MODERATE.
- New attack vector: malicious image upload attempting to exploit ClamAV vulnerabilities (CVE-class). Mitigation: ClamAV signatures auto-update daily via `freshclam`; signature age >48h fires a critical alert per `docs/runbooks/clamav-signature-stale.md`.
- New data-class: image bytes (potentially PII-bearing). Mitigation: same RLS+FORCE pattern as broadcast `body_html`; only the broadcast's owning tenant can list/retrieve.
- New disposal liability: image bytes outlive draft drafts via blob references. Mitigation: `prune-expired-drafts` extended to delete bound blob entries.

### 1.3 US7 — Admin-authored multi-template library

**New personal data**: NONE. Templates carry `name`, `subject`, `body_html`, and tenant metadata. Body HTML may reference `{{chamber_name}}` (server-substituted from tenant display name — NOT personal data). Member-editable `[bracketed text]` placeholders are NOT personal data at the template level (they hold the member's input at compose time, which feeds into the broadcast body).

**Processing**: admin authoring + member preview + snapshot-to-draft (one-shot copy at compose time).

**Risk delta vs F7 MVP**: NONE. Same retention as broadcast bodies; same RLS+FORCE; same audit integrity. Snapshot semantics ensure draft drafts decouple from later template edits — eliminates a class of "stale template propagates to in-flight drafts" data-integrity bugs.

> **F7.1a Phase 1 status note**: US7 is currently deferred to a follow-up branch (`F7.1a-Phase-2`). This DPIA addendum section documents the intended processing posture; the actual implementation will land later. The processing IS in scope for F7.1a's overall DPIA narrative because it informs ROPA additions and the integrated risk model.

---

## 2. Data Subject Rights — additions

The F7 MVP DPIA documents the canonical right-handling for broadcast surfaces. F7.1a additions:

| Right | F7.1a-specific handling |
|---|---|
| Access (Art. 15) | Inline images uploaded by the member are listed via the existing F7 MVP export. New tables (`broadcast_batch_manifests`, `tenant_image_source_allowlist`, `broadcast_templates`) do NOT carry member-identifying data — no export changes needed. |
| Erasure (Art. 17) | Member deletion cascades to their broadcasts; inline images referenced by those broadcasts are removed from Vercel Blob in the same cascade. Tested via `tests/integration/broadcasts/member-erasure-cascade.test.ts` (existing F7 MVP test; verify on F7.1a ship that the cascade includes new blob refs). |
| Portability (Art. 20) | Inline images included in the existing F7 MVP `member-export.zip` (extends from broadcast body export). New tables do NOT carry member data — N/A. |
| Restriction (Art. 18) | Existing F7 MVP `halt_pending_review` member state covers F7.1a as well — halted members cannot submit new broadcasts; their existing broadcasts (and the inline images therein) remain readable by chamber admin only. |

---

## 3. Lawful basis enumeration for the F7.1a audit event additions

Per Constitution Principle I sub-clause 4 + GDPR Art. 13 / Art. 30 ROPA requirement.

**Count (reconciled 2026-05-21 post-review)**: 15 NEW event types + 2 pre-existing F7 MVP events extended with F7.1a payload shapes = 17 total in the F7.1a forensic catalogue. `audit-port.ts` is the source-of-truth; this table is derived.

| Audit event | Lawful basis | Retention | Notes |
|---|---|---|---|
| `broadcast_retry_initiated` | `6(1)(b)` contract (admin moderation surface) | 5y | US1 — manual retry |
| `broadcast_retry_completed` | `6(1)(b)` | 5y | US1 — manual retry completion |
| `broadcast_partial_delivery_accepted` | `6(1)(b)` | 5y | US1 — admin accept-partial terminal transition |
| `broadcast_concurrent_action_blocked` | `6(1)(c)` operational forensics | 5y | US1 — advisory-lock loser; SC-007 invariant |
| `broadcast_webhook_batch_missing` | `6(1)(c)` operational forensics | 5y | US1 — Resend webhook routes to a batch_manifest that doesn't resolve (BENIGN cross-tenant probe variant; emit-site split from `broadcast_cross_tenant_probe` to keep SIEM signal cleaner) |
| `broadcast_image_too_large` | `6(1)(b)` + `6(1)(c)` (PDPA §37 abuse-prevention) | 5y | US2 — upload exceeded 5 MB cap |
| `broadcast_image_unsafe` | `6(1)(c)` | 5y | US2 — ClamAV verdict ∈ {infected,error,timeout} |
| `broadcast_body_image_source_unsafe` | `6(1)(b)` + `6(1)(c)` | 5y | US2 — submit-time allowlist reject |
| `broadcast_image_allowlist_updated` | `6(1)(b)` | 5y | US2 — admin allowlist add/remove |
| `broadcast_template_created` | `6(1)(b)` | 5y | US7 — admin authoring |
| `broadcast_template_updated` | `6(1)(b)` | 5y | US7 — admin edit |
| `broadcast_template_deleted` | `6(1)(b)` | 5y | US7 — admin soft-delete |
| `broadcast_template_snapshotted` | `6(1)(b)` | 5y | US7 — member picks a template; draft populated |
| `broadcast_template_seed_skipped_existing_name` | `6(1)(c)` operational forensics | 5y | US7 — seed migration encountered same-named template; idempotency forensic signal |
| `broadcast_template_snapshot_refused_deleted` | `6(1)(b)` | 5y | US7 — member-side snapshot request on a soft-deleted template; TOCTOU forensic |
| `broadcast_cross_tenant_probe` (EXTENDED) | `6(1)(c)` + `6(1)(f)` | 5y | Pre-existing F7 MVP; F7.1a Phase 6 (T127/T128/T128b + T129) extends payload schema to cover `tenant_image_source_allowlist` (`payload.surface='tenant_image_source_allowlist'`) + `broadcast_batch_manifests` (via `retryFailedBatches` use-case) + `broadcast_templates` (`payload.resourceKind='template'`) surfaces |
| `broadcast_cross_member_probe` (EXTENDED) | `6(1)(c)` + `6(1)(f)` | 5y | Pre-existing F7 MVP; F7.1a-relevant for future F7.1b (US3 contact opt-in member-portal routes) — invariant preserved per `plan.md § Phase 6 Polish Closures § Constitution Check I` |

All 17 event types ship at 5-year retention, matching the F7 MVP default. Higher retention (10y) reserved for tax-document events under Thai RD §87/3 — no F7.1a event qualifies. `broadcast_batch_failed` (referenced by an earlier draft of this DPIA) was NOT implemented — failed-batch forensics are captured via `broadcast_partial_delivery_accepted` + per-batch row state in `broadcast_batch_manifests.last_failure_reason`, NOT as a discrete audit row. Per-batch dispatch failures are observability signals (metric `broadcasts.failed_to_dispatch.count` + log line), not audit events.

---

## 4. Record of Processing Activities (ROPA) additions

Append to the existing Chamber-OS ROPA register (`docs/ropa/swecham-ropa.yaml` — operator-maintained):

```yaml
- activity: "F7.1a Inline image embedding + virus scan (US2)"
  controller: "SweCham (TSCC) — Thailand-Swedish Chamber of Commerce"
  data_classes: ["image_bytes (may contain PII)", "content_hash", "mime_type"]
  data_subjects: ["chamber members (uploaders)", "members of the chamber (potential subjects of uploaded images)"]
  purpose: "Enable chamber members to embed images in broadcasts they send via the E-Blast platform"
  lawful_basis: ["GDPR 6(1)(b) contract", "PDPA §24 marketing-purpose with consent"]
  retention: "Co-terminate with broadcast row (5y default)"
  storage_location: "Vercel Blob (Singapore region)"
  sub_processors:
    - "Vercel Inc. (covered by SCC)"
    - "Fly.io Inc. (covered by SCC — ClamAV VM in sin region)"
  technical_safeguards:
    - "Tenant-scoped RLS+FORCE on all queries"
    - "ClamAV scan with 5-min timeout (fail-closed on error/timeout per FR-013)"
    - "Content-hash dedup prevents storage explosion"
  organisational_safeguards:
    - "Self-hosted ClamAV daemon — no external scanning service receives bytes"
    - "Image bytes never reach Blob if scan verdict ≠ clean (FR-013 pipeline-order invariant)"
```

ROPA entry for US1 dispatch fan-out is unchanged from F7 MVP (the parent ROPA covers broadcast dispatch generically).

---

## 5. Residual risks + mitigations

| Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|
| Malicious image bypasses ClamAV via 0-day exploit | Low | High | Signature age alert (>48h critical); daily auto-update via freshclam; fail-closed on timeout | Mitigated |
| Image bytes persist after broadcast deletion (orphan in Blob) | Medium | Medium | `prune-expired-drafts` cron extension deletes bound blobs; co-terminate retention | Mitigated; verify cascade test |
| Member uploads image of another person without consent | Medium | High (PDPA §19/§24) | Member-facing legal copy on compose surface ("you confirm you have the right to send this content"); admin moderation surface allows takedown | Accepted residual — same as F7 MVP body_html |
| Cross-tenant probe via batch_manifest enumeration | Low | High | DB-layer RLS+FORCE (migration 0166); application-layer probe-emit (T127); audit event for forensics | Mitigated |
| Cross-tenant probe via allowlist enumeration | Low | High | DB-layer RLS+FORCE; application-layer probe-emit on `remove not_found` (T128b); audit event | Mitigated |
| **Vercel Blob URL = capability token shared via dispatched email** (R006 Round 2 staff-review) | Medium | Medium-Low | Vercel Blob URLs embedded in dispatched broadcast emails contain a signed key fragment that grants read access to the image. Recipients can share the URL outside the chamber's control — the URL is effectively a forever-capability for as long as the Blob exists. **Mitigations**: (a) the URL path contains ONLY content-hash + MIME extension, no PII beyond the image bytes themselves; (b) the URL invalidates when the underlying Blob is deleted via the member-erasure cascade (`prune-expired-drafts` cron + retention horizon); (c) GDPR Art. 17 + PDPA §33 erasure removes the Blob → URL returns 404 within minutes; (d) content-hash + `allowOverwrite:false` prevents URL-stuffing attacks (a foreign actor cannot point the URL at different content); (e) the URL recipient is the SAME individual who already received the inline image in the broadcast — they could screenshot the content regardless of URL access. **DPO note**: this is the same posture as ALL inline-image emails on the chamber's existing communication channels (Gmail/Outlook inline imgs all use capability-token URLs). Accepted as standard email-protocol residual risk. | **Accepted residual** — documented per R006 Round 2 staff-review COND-2 closure 2026-05-21 |

---

## 6. Sign-off

This DPIA addendum is part of the F7.1a Constitution Check VI (Inclusive UX) + the privacy posture validated at the `/speckit.verify` gate. Maintainer-signed at ship-day; co-sign by DPO contact pending operator gate (T143 manual flag-flip checklist).

**Cross-references**:
- F7 MVP DPIA: `specs/010-email-broadcast/dpia.md`
- F7.1a constitution check: `specs/014-email-broadcast-advance/plan.md § Constitution Check`
- F7.1a security spec: `specs/014-email-broadcast-advance/spec.md § Functional Requirements`
- Cross-tenant probe wiring: `src/modules/broadcasts/application/use-cases/manage-image-allowlist.ts` (T128b) + `retry-failed-batches.ts` (T127)
- Audit event catalogue: `src/modules/broadcasts/application/ports/audit-port.ts`
- F7.1a observability section: `docs/observability.md § 22.9 + § 22.10`
