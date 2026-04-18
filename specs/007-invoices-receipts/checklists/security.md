# Security Requirements Quality Checklist: F4 — Membership Invoicing & Thai-Tax Receipts

**Purpose**: Validate the **quality of security/privacy requirements** in spec + plan — PII snapshot handling, RBAC + RLS + FORCE, auth + invitation-based access, logo upload (XSS/SSRF), signed-URL handling, outbox dispatch, audit completeness, threat-model coverage. "Unit tests for English" — validating whether security requirements are well-written, complete, unambiguous, NOT whether they are implemented correctly.
**Created**: 2026-04-18
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Depth**: Standard (PR review gate, pre-`/speckit.tasks`)

## Threat Model Coverage

- [ ] CHK001 Is the F4 threat list (T-01 … T-15 in research.md §13) mapped to concrete FRs or plan mitigations for every threat? [Traceability, Research §13]
- [ ] CHK002 Is each threat assigned a specific mitigation technique, not a generic "handled by RLS"? [Clarity, Research §13]
- [x] CHK003 Are threats introduced by post-critique additions (logo upload SVG XSS, bounce PII leakage, template-version pinning) included in the 15-threat list or explicitly deferred? [Completeness, Spec §FR-034, Research §8a, §12] — **RESOLVED**: research §13 now lists T-16 (admin demotion), T-17 (SVG XSS), T-18 (bounce PII), T-19 (template drift)
- [ ] CHK004 Is OWASP Top 10 coverage mapped to F4-specific attack vectors (A01-A10) with at least one concrete mitigation per relevant item? [Completeness, Plan Constitution Check I]

## Authentication & Authorization (RBAC)

- [ ] CHK005 Are the role × action permissions enumerated for every F4 mutation (issue/pay/void/credit-note/settings/logo) — not left as "admin-only" at the surface level? [Completeness, Spec §FR-012]
- [ ] CHK006 Are manager read-only constraints specified per surface (list + detail + PDF download) with explicit exclusion of mutating controls? [Clarity, Spec US1 AS4, §FR-012]
- [ ] CHK007 Are member self-service scope boundaries unambiguous — own-company invoices only, no drafts, no other tenants? [Clarity, Spec §FR-014, Research §11]
- [x] CHK008 Are role demotion scenarios (admin demoted mid-transaction) addressed in the requirements? [Coverage, Gap, Research §13 T-13] — **RESOLVED**: T-16 added with session-store-queried RBAC at start of every handler + accepted-TOCTOU-window documentation
- [ ] CHK009 Are the preconditions for settings PATCH (admin only, valid tenant context) specified to the same precision as mutation endpoints? [Consistency, Spec §FR-012, Contracts §3.2]

## Tenant Isolation (DB-layer + App-layer)

- [ ] CHK010 Is the two-layer tenant-isolation requirement (app-layer `TenantContext` + DB-layer RLS + FORCE) stated as a Domain-layer invariant, not an Infrastructure-layer default? [Clarity, Spec §FR-013, Plan Constitution Check I]
- [ ] CHK011 Are all 5 F4 tables individually listed with confirmation of RLS + FORCE + policy, with no table silently excluded? [Completeness, Data-model §2]
- [ ] CHK012 Is the cross-tenant probe response (404, never 403 or 401) specified as a security property (to avoid resource-existence disclosure)? [Clarity, Spec §FR-013]
- [ ] CHK013 Are dev-mode safety nets (`DEBUG_RLS_STATE`) specified as requirements with clear loud-failure behaviour? [Measurability, Plan Constitution Check I clause 2]

## PII Handling

- [ ] CHK014 Are the PII fields captured on snapshots enumerated (member legal name, tax_id, address) with explicit immutability + retention semantics? [Completeness, Spec §FR-011, §FR-038]
- [ ] CHK015 Are the forbidden-in-logs fields listed comprehensively including F4 additions (tax_id, member_legal_name_snapshot, member_address_snapshot, signed_url_token, PDF body)? [Completeness, Plan Technical Context — Constraints]
- [ ] CHK016 Is user-ID hashing in cross-request logs specified as a hard requirement rather than a convention? [Clarity, Plan Constitution Check VII]
- [ ] CHK017 Is the distinction between snapshotted identity (immutable on issue) and live identity (mutable via F3) documented so there is no ambiguity about which applies to each rendering path? [Clarity, Spec §FR-011, §FR-038]

## Input Validation & Injection Resistance

- [ ] CHK018 Is every mutation endpoint's zod schema boundary specified in contracts, with no "TBD" or "see schema file" placeholders? [Completeness, Contracts §7]
- [ ] CHK019 Is logo-upload validation (MIME whitelist, size cap, dimension range, EXIF strip) specified as strict-reject — not best-effort? [Clarity, Spec §FR-034]
- [ ] CHK020 Is the explicit SVG rejection stated (not just "MIME whitelist includes PNG/JPEG")? [Clarity, Spec §FR-034]
- [ ] CHK021 Is the invariant that PATCH /tenant-invoice-settings rejects raw logo binary (only accepts the upload endpoint's returned key) explicit? [Clarity, Contracts §3.3]
- [ ] CHK022 Are PDF-template data-flow rules (props-as-data, no string interpolation) specified as a design requirement, not left as implementation practice? [Clarity, Research §1]

## Cryptographic & Transport

- [ ] CHK023 Are Blob signed-URL TTLs quantified (60 s) and tied to a specific regeneration path for link expiry? [Measurability, Plan Technical Context — Storage]
- [ ] CHK024 Is signed-URL token redaction in logs stated as a hard requirement? [Clarity, Plan Technical Context — Constraints]
- [ ] CHK025 Is TLS 1.2+ + at-rest AES-256 stated for F4 or explicitly marked as inherited from F1? [Completeness, Plan Constitution Check I]

## Idempotency & Replay Safety

- [ ] CHK026 Is the `Idempotency-Key` requirement specified at the request-header level for all mutations, including logo upload and preview exemption? [Completeness, Contracts — shared headers]
- [ ] CHK027 Is the 24-hour TTL + key-collision replay behaviour specified to eliminate ambiguity about how a retry is recognised? [Clarity, Research §10]
- [ ] CHK028 Is the behaviour for repeated payment recording (FR-007 idempotent) documented with clear success-vs-conflict semantics? [Clarity, Spec §FR-007]

## Outbox Dispatch + Bounce Handling

- [ ] CHK029 Is the outbox-row-per-financial-event guarantee stated as "same transaction as the financial commit" so a reviewer can distinguish it from best-effort enqueue? [Clarity, Plan §VIII Reliability]
- [ ] CHK030 Are the per-member auto-email throttle (10/h) and bounce-handling behaviour specified so spam-storm scenarios have a defined outcome? [Measurability, Plan Technical Context — Rate limiting]

---

**Traceability summary**: 30/30 items reference spec, plan, data-model, research, or contracts. Coverage 100%.
