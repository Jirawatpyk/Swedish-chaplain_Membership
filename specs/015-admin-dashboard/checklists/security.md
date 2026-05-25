# Security & Privacy Requirements Quality Checklist: F9 — Admin Dashboard + Directory + Timeline + Audit

**Purpose**: Validate that F9's **security & privacy requirements** (tenant isolation,
RBAC/redaction, GDPR export, PII-read auditing, private delivery, audit integrity) are
complete, clear, consistent, and measurable — *before* implementation. This is the
Review-Gate security checklist for a feature that reads **all member PII** (≥2-reviewer /
solo-maintainer-substitute co-sign applies).
**Created**: 2026-05-25
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · constitution v1.4.2 (Principle I, IV)
**Depth**: Formal release gate · **Audience**: reviewer + security co-signer

> These items test the **requirements**, not the code. "Is X specified?" not "Does X work?"

## Tenant Isolation (Constitution Principle I — NON-NEGOTIABLE)

- [x] CHK001 Is two-layer tenant isolation (application **and** database) required explicitly for every F9 surface (dashboard, audit, timeline, directory, export)? [Completeness, Spec §FR-033, Plan Constitution I] → VERIFIED 2026-05-25: FR-033 + plan Constitution I (RLS+FORCE every table + runInTenant).
- [x] CHK002 Is the requirement that all access threads `tx` via `runInTenant` (never the global `db`) stated for every new repo? [Clarity, Plan §Constitution I, CLAUDE.md gotcha] → VERIFIED 2026-05-25: data-model §intro + plan Constitution I.
- [x] CHK003 Is RLS + FORCE required on every new tenant-scoped table (`dashboard_metrics_cache`, `smart_insight_dismissals`, `directory_listings`, `export_jobs`)? [Completeness, data-model §1–4] → VERIFIED 2026-05-25: data-model §1–4 each declares RLS+FORCE.
- [x] CHK004 Is the `member_timeline_v` view's `security_invoker = on` requirement stated, with a rationale for why base-table RLS must apply inside the view? [Clarity, data-model §5, research R4] → VERIFIED 2026-05-25: data-model §5 + research R4.
- [x] CHK005 Is the mandatory cross-tenant integration test (two tenants, read **and** write both directions, zero visibility) defined as a Review-Gate blocker? [Completeness, Plan Constitution I] → VERIFIED 2026-05-25: plan Constitution I + tasks T019/T102.
- [x] CHK006 Is the `insights_cross_tenant_probe` audit event defined as high-severity, and is "what counts as a probe" specified? [Clarity, data-model §7] → VERIFIED 2026-05-25: data-model §7 + contracts (probe reaching a guard → emit, return empty/forbidden).
- [x] CHK007 Is the security-invoker requirement testable via a CI schema guard (`check-f9-schema`)? [Measurability, data-model §9] → VERIFIED 2026-05-25: data-model §9 + tasks T018.

## RBAC & Role Redaction

- [x] CHK008 Are the three role projections (admin full / manager finance-redacted / member own-only) defined for the dashboard, audit viewer, and timeline individually? [Completeness, Spec §FR-007, §FR-011, §FR-017] → VERIFIED 2026-05-25: FR-007 (dashboard), FR-011 (audit), FR-017 (timeline).
- [x] CHK009 Is "sensitive payload fields" defined/enumerated precisely enough that payload redaction is objectively testable? [Spec §FR-011] → RESOLVED 2026-05-25: FR-011 now defines a per-event-type redaction map + the two sensitive categories (internal annotations; third-party PII).
- [x] CHK010 Is the decision that **actor identity is visible to managers** (while payload PII is redacted) stated unambiguously and consistently between FR-011 and the clarifications log? [Consistency, Spec §FR-011, §Clarifications] → VERIFIED 2026-05-25: FR-011 + Clarifications E5 agree.
- [x] CHK011 Is the rule that members can access only their **own** timeline/benefits/export specified, with a defined refusal behaviour for others' data? [Completeness, Spec §FR-017, §FR-022, §FR-032] → VERIFIED 2026-05-25: FR-017/022/032 + contracts (`forbidden` variant).
- [x] CHK012 Is the staff-only scope of the Engagement Score (not shown to members) explicit? [Clarity, Spec §FR-007a] → VERIFIED 2026-05-25: FR-007a "staff-facing (not shown to members)".
- [x] CHK013 Is access to `/admin` surfaces by a member required to be denied (not merely hidden)? [Coverage, Spec §FR-007, US1 AS-5] → VERIFIED 2026-05-25: FR-007 + US1 AS-5 + contracts (member → forbidden/redirect).

## GDPR / PDPA Export (Constitution Principle I, IV)

- [x] CHK014 Is the GDPR-export audit subset precisely defined (member-performed **∪** member-targeted, third-party PII + internal annotations redacted)? [Clarity, Spec §FR-029] → VERIFIED 2026-05-25: FR-029.
- [x] CHK015 Are the archive's content categories enumerated (profile, contacts, invoices+PDFs, events, broadcasts, audit subset, README, manifest)? [Completeness, Spec §FR-029] → VERIFIED 2026-05-25: FR-029 enumerates all categories.
- [x] CHK016 Is admin-on-behalf export required to be attributed to the admin in the audit log? [Completeness, Spec §FR-031] → VERIFIED 2026-05-25: FR-031.
- [x] CHK017 Are the archived-vs-erased subject rules for export defined (archived can export; erasure reflects only lawfully-retained pseudonymised data; never resurrect erased PII)? [Coverage, Spec §FR-032a, Edge Cases] → VERIFIED 2026-05-25: FR-032a + Edge Cases.
- [x] CHK018 Is the lawful basis + retention documented per surface (legitimate interest / legal obligation / consent / Art. 20)? [Completeness, research R10] → VERIFIED 2026-05-25: research R10.
- [x] CHK019 Is a member prohibited from exporting another member's data stated as a hard rule? [Clarity, Spec §FR-032] → VERIFIED 2026-05-25: FR-032 + US6 AS-5.

## Private Artefact Delivery

- [x] CHK020 Is private (non-public) storage **required** for the E-Book and GDPR archive, with public Blob URLs explicitly disallowed? [Clarity, research R6, plan Complexity #4] → VERIFIED 2026-05-25: research R6 + plan Complexity #4.
- [x] CHK021 Are the download-proxy authorization rules defined (valid session + subject-or-admin-same-tenant + signed token + expiry)? [Completeness, contracts/http-endpoints] → VERIFIED 2026-05-25: contracts/http-endpoints download-proxy §.
- [x] CHK022 Is the download token specified as **single-use** with a bounded TTL, and is re-download behaviour defined? [Clarity, research R6, contracts/http-endpoints] → VERIFIED 2026-05-25: research R6 (E4) + contracts (single-use, ≤1h, re-mint).
- [x] CHK023 Is `EXPORT_DOWNLOAD_TOKEN_SECRET` required to be ≥32 bytes and distinct from other secrets? [Completeness, contracts/http-endpoints, research R11] → VERIFIED 2026-05-25: contracts env table + research R6/R11.
- [x] CHK024 Are the proxy's explicit failure modes (401/403/404/409/410) defined so no silent fallback can leak an artefact? [Coverage, contracts/http-endpoints] → VERIFIED 2026-05-25: contracts "Failure modes (each explicit, no silent fallback)".

## Audit Integrity & New Surfaces

- [x] CHK025 Is the audit viewer required to be strictly read-only over an append-only log (no edit/delete path)? [Clarity, Spec §FR-010, US2 AS-5] → VERIFIED 2026-05-25: FR-010 + US2 AS-5 + contracts "No mutation path exists".
- [x] CHK026 Are PII-read events (member-detail / benefit views) and every export required to be audit-logged with actor + subject + request-id (no PII payload)? [Completeness, Spec §FR-036, data-model §7] → VERIFIED 2026-05-25: FR-036 + data-model §7 + research R10.
- [x] CHK027 Are the new F9 audit event types enumerated, including read-side events (`dashboard_viewed`, `audit_log_queried`, `member_benefit_viewed`)? [Completeness, data-model §7] → VERIFIED 2026-05-25: data-model §7 (14 types incl read-side).
- [x] CHK028 Is the audit-export size guard (sync cap → async `audit_export`) specified so a large export can't bypass controls or time out? [Coverage, research R5/R2-E2] → VERIFIED 2026-05-25: research R5/R2-E2 + tasks T046.

## Input / Upload Trust Boundary

- [x] CHK029 Is the directory logo upload pipeline's security requirement defined (MIME allow-list, size/dimension caps, server re-encode + EXIF strip, original never served)? [Completeness, Spec §FR-025a] → VERIFIED 2026-05-25: FR-025a.
- [x] CHK030 Are directory free-text/website fields required to have validation (URL scheme allow-list, length caps) before publication? [Coverage, data-model §3] → VERIFIED 2026-05-25: data-model §3 validation rules.
- [x] CHK031 Is logo set/remove required to be audit-logged? [Completeness, Spec §FR-025a] → VERIFIED 2026-05-25: FR-025a "Logo set/remove actions MUST be audit-logged".

## Forbidden-Data & Logging Hygiene

- [x] CHK032 Is it required that logs/metrics for F9 carry no PII (only hashed/bounded identifiers; tenant-id label only on metrics)? [Clarity, research R12, CLAUDE.md forbidden-fields] → VERIFIED 2026-05-25: research R12 + plan VII (no PII in metric labels).
- [x] CHK033 Is the directory default-private (opt-in) requirement stated, with email default-hidden, so no member is published without consent? [Completeness, Spec §FR-025] → VERIFIED 2026-05-25: FR-025 + data-model §3 (default private, email default-hidden).

## Notes

- Solo-maintainer substitute (Principle IX) applies: this checklist is co-signed by the
  staff-review agent + maintainer using the v1.4.2 footer template at the Review gate.
- Items marked `[Gap]`/`[Ambiguity]` require a spec update before implementation of the
  affected surface.
- **Requirements-quality verification PASS (2026-05-25)**: all 33 items confirmed
  specified in spec.md / plan.md / data-model.md / research.md / contracts. No open gaps.
  (This verifies the *requirements* are present; the security co-sign of the *implementation*
  remains a Review-gate action per tasks T105.)
