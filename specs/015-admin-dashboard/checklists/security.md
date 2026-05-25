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

- [ ] CHK001 Is two-layer tenant isolation (application **and** database) required explicitly for every F9 surface (dashboard, audit, timeline, directory, export)? [Completeness, Spec §FR-033, Plan Constitution I]
- [ ] CHK002 Is the requirement that all access threads `tx` via `runInTenant` (never the global `db`) stated for every new repo? [Clarity, Plan §Constitution I, CLAUDE.md gotcha]
- [ ] CHK003 Is RLS + FORCE required on every new tenant-scoped table (`dashboard_metrics_cache`, `smart_insight_dismissals`, `directory_listings`, `export_jobs`)? [Completeness, data-model §1–4]
- [ ] CHK004 Is the `member_timeline_v` view's `security_invoker = on` requirement stated, with a rationale for why base-table RLS must apply inside the view? [Clarity, data-model §5, research R4]
- [ ] CHK005 Is the mandatory cross-tenant integration test (two tenants, read **and** write both directions, zero visibility) defined as a Review-Gate blocker? [Completeness, Plan Constitution I]
- [ ] CHK006 Is the `insights_cross_tenant_probe` audit event defined as high-severity, and is "what counts as a probe" specified? [Clarity, data-model §7]
- [ ] CHK007 Is the security-invoker requirement testable via a CI schema guard (`check-f9-schema`)? [Measurability, data-model §9]

## RBAC & Role Redaction

- [ ] CHK008 Are the three role projections (admin full / manager finance-redacted / member own-only) defined for the dashboard, audit viewer, and timeline individually? [Completeness, Spec §FR-007, §FR-011, §FR-017]
- [x] CHK009 Is "sensitive payload fields" defined/enumerated precisely enough that payload redaction is objectively testable? [Spec §FR-011] → RESOLVED 2026-05-25: FR-011 now defines a per-event-type redaction map + the two sensitive categories (internal annotations; third-party PII).
- [ ] CHK010 Is the decision that **actor identity is visible to managers** (while payload PII is redacted) stated unambiguously and consistently between FR-011 and the clarifications log? [Consistency, Spec §FR-011, §Clarifications]
- [ ] CHK011 Is the rule that members can access only their **own** timeline/benefits/export specified, with a defined refusal behaviour for others' data? [Completeness, Spec §FR-017, §FR-022, §FR-032]
- [ ] CHK012 Is the staff-only scope of the Engagement Score (not shown to members) explicit? [Clarity, Spec §FR-007a]
- [ ] CHK013 Is access to `/admin` surfaces by a member required to be denied (not merely hidden)? [Coverage, Spec §FR-007, US1 AS-5]

## GDPR / PDPA Export (Constitution Principle I, IV)

- [ ] CHK014 Is the GDPR-export audit subset precisely defined (member-performed **∪** member-targeted, third-party PII + internal annotations redacted)? [Clarity, Spec §FR-029]
- [ ] CHK015 Are the archive's content categories enumerated (profile, contacts, invoices+PDFs, events, broadcasts, audit subset, README, manifest)? [Completeness, Spec §FR-029]
- [ ] CHK016 Is admin-on-behalf export required to be attributed to the admin in the audit log? [Completeness, Spec §FR-031]
- [ ] CHK017 Are the archived-vs-erased subject rules for export defined (archived can export; erasure reflects only lawfully-retained pseudonymised data; never resurrect erased PII)? [Coverage, Spec §FR-032a, Edge Cases]
- [ ] CHK018 Is the lawful basis + retention documented per surface (legitimate interest / legal obligation / consent / Art. 20)? [Completeness, research R10]
- [ ] CHK019 Is a member prohibited from exporting another member's data stated as a hard rule? [Clarity, Spec §FR-032]

## Private Artefact Delivery

- [ ] CHK020 Is private (non-public) storage **required** for the E-Book and GDPR archive, with public Blob URLs explicitly disallowed? [Clarity, research R6, plan Complexity #4]
- [ ] CHK021 Are the download-proxy authorization rules defined (valid session + subject-or-admin-same-tenant + signed token + expiry)? [Completeness, contracts/http-endpoints]
- [ ] CHK022 Is the download token specified as **single-use** with a bounded TTL, and is re-download behaviour defined? [Clarity, research R6, contracts/http-endpoints]
- [ ] CHK023 Is `EXPORT_DOWNLOAD_TOKEN_SECRET` required to be ≥32 bytes and distinct from other secrets? [Completeness, contracts/http-endpoints, research R11]
- [ ] CHK024 Are the proxy's explicit failure modes (401/403/404/409/410) defined so no silent fallback can leak an artefact? [Coverage, contracts/http-endpoints]

## Audit Integrity & New Surfaces

- [ ] CHK025 Is the audit viewer required to be strictly read-only over an append-only log (no edit/delete path)? [Clarity, Spec §FR-010, US2 AS-5]
- [ ] CHK026 Are PII-read events (member-detail / benefit views) and every export required to be audit-logged with actor + subject + request-id (no PII payload)? [Completeness, Spec §FR-036, data-model §7]
- [ ] CHK027 Are the new F9 audit event types enumerated, including read-side events (`dashboard_viewed`, `audit_log_queried`, `member_benefit_viewed`)? [Completeness, data-model §7]
- [ ] CHK028 Is the audit-export size guard (sync cap → async `audit_export`) specified so a large export can't bypass controls or time out? [Coverage, research R5/R2-E2]

## Input / Upload Trust Boundary

- [ ] CHK029 Is the directory logo upload pipeline's security requirement defined (MIME allow-list, size/dimension caps, server re-encode + EXIF strip, original never served)? [Completeness, Spec §FR-025a]
- [ ] CHK030 Are directory free-text/website fields required to have validation (URL scheme allow-list, length caps) before publication? [Coverage, data-model §3]
- [ ] CHK031 Is logo set/remove required to be audit-logged? [Completeness, Spec §FR-025a]

## Forbidden-Data & Logging Hygiene

- [ ] CHK032 Is it required that logs/metrics for F9 carry no PII (only hashed/bounded identifiers; tenant-id label only on metrics)? [Clarity, research R12, CLAUDE.md forbidden-fields]
- [ ] CHK033 Is the directory default-private (opt-in) requirement stated, with email default-hidden, so no member is published without consent? [Completeness, Spec §FR-025]

## Notes

- Solo-maintainer substitute (Principle IX) applies: this checklist is co-signed by the
  staff-review agent + maintainer using the v1.4.2 footer template at the Review gate.
- Items marked `[Gap]`/`[Ambiguity]` require a spec update before implementation of the
  affected surface.
