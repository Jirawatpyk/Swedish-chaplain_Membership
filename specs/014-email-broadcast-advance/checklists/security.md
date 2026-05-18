# Security Requirements Quality Checklist: F7.1a — Email Broadcast Advanced

**Purpose**: Validate that security requirements for US1 (Pagination + advisory locks), US2 (Image embedding + ClamAV + allowlist), and US7 (Multi-template + variable substitution) are complete, clear, consistent, measurable, and consistent with Constitution v1.4.0 Principle I (NON-NEGOTIABLE — Data Privacy & Security + Tenant Isolation).
**Created**: 2026-05-18
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [contracts/](../contracts/)
**Scope**: Pre-implementation requirements quality gate (Standard depth, ~30 items)

**Note**: This checklist tests REQUIREMENTS QUALITY, not implementation behavior. Use during `/speckit.tasks` review or before merging the F7.1a feature branch.

## Tenant Isolation (Principle I sub-clauses 1-5)

- [x] CHK001 Are tenant isolation requirements explicitly defined for ALL 3 new tables (`broadcast_batch_manifests`, `tenant_image_source_allowlist`, `broadcast_templates`)? [Coverage, Spec §Dependencies + data-model § 5]
- [x] CHK002 Is the `runInTenant(ctx, fn)` wrapper requirement explicitly stated for every new use-case? [Completeness, Spec §plan.md Constitution Check I]
- [x] CHK003 Are RLS + FORCE policy requirements consistent with the F2 pattern used by other Chamber-OS modules? [Consistency, data-model § 5]
- [x] CHK004 Are cross-tenant probe test requirements specified per US (US1 + US2 + US7 = 3 probe test files)? [Coverage, plan.md tests/ tree]
- [x] CHK005 Is the `broadcast_cross_tenant_probe` audit event requirement specified for every cross-tenant access attempt? [Completeness, data-model § 7]
- [ ] CHK006 Are cross-member-within-tenant guards specified for member-portal routes that could leak across members (e.g., draft snapshot)? [Coverage, Gap — F7.1a doesn't introduce member-portal-draft-bridging but document the invariant]

## XSS / Injection Prevention (US7 variable substitution + US2 image embedding)

- [x] CHK007 Is the `{{chamber_name}}` HTML-escape requirement explicitly stated with the exact escape function reference (`escapeHtml` from F7 MVP)? [Clarity, contracts/broadcast-template.md § 5.1]
- [x] CHK008 Are XSS test fixtures for `tenant.display_name = '<script>alert(1)</script>'` specified in the test plan? [Measurability, contracts/broadcast-template.md § 5.4]
- [x] CHK009 Is the policy for unresolved `{{var}}` placeholders defined (literal pass-through vs error vs empty string)? [Clarity, contracts/broadcast-template.md § 5.1 "WHAT (if missing)"]
- [x] CHK010 Are sanitiser invocation requirements consistent at template-SAVE time AND at broadcast-SUBMIT time (defence in depth)? [Consistency, Spec FR-017 + FR-019]
- [x] CHK011 Are `<img>` `src` URI scheme restrictions explicitly listed (forbidden: data:, javascript:, file:, vbscript:)? [Completeness, Spec FR-014]
- [x] CHK012 Are inline-event-handler stripping requirements consistent between member-authored body and admin-authored template body? [Consistency, Spec FR-014 + FR-017]
- [x] CHK013 Is the image-filename sanitisation requirement (strip HTML/JS-meta characters; max length 255) specified? [Completeness, Spec FR-013 + critique E6]
- [x] CHK014 Is the base64-data-URI bypass attack defence (re-enforcement at submit per sanitiser pass) explicitly required? [Clarity, Spec FR-012 "defence in depth"]

## Image-Source Allowlist Integrity (US2)

- [x] CHK015 Are the 2 default allowlist entries (chamber asset domain + Resend CDN) specified as non-removable? [Clarity, Spec FR-010 + research § 4]
- [x] CHK016 Is the wildcard-rejection requirement explicit (no `*.example.com` patterns)? [Clarity, Spec FR-010]
- [x] CHK017 Is the hostname-format CHECK constraint (RFC 1035) specified at the database layer in addition to application validation? [Consistency, data-model § 2.5]
- [x] CHK018 Is the audit-event requirement for allowlist mutations explicitly specified with before/after value capture? [Completeness, Spec FR-015]

## ClamAV Trust Boundary (US2)

- [x] CHK019 Is the requirement for ClamAV scan to BLOCK upload on `verdict='infected'` explicitly stated (not silent-log-and-allow)? [Clarity, Spec FR-013]
- [ ] CHK020 Is the requirement for ClamAV scan latency timeout behaviour specified (5-min timeout → conservative `error` verdict per FR-027)? [Edge Case, Spec FR-013 — F7.1a uses FR-013 for images; FR-027 is F7.1b carry — verify alignment]
- [x] CHK021 Is the signature-database freshness SLO (`clamav_signature_age_hours <48h`) defined with monitoring + alert requirements? [Measurability, plan.md Principle VII]
- [x] CHK022 Are requirements for ClamAV-daemon-down UX (member-facing banner, scan-pending state, auto-retry on daemon return) specified? [Coverage, spec edge case + critique P10]
- [ ] CHK023 Is the requirement that NO bytes of uploaded content reach Vercel Blob BEFORE scan-clean verdict explicitly stated? [Completeness, Gap — Spec implies via FR-013 pipeline order but doesn't enforce]

## Advisory Lock Correctness (US1)

- [x] CHK024 Are the two new advisory-lock namespaces (`broadcasts-batch:` + `broadcasts-retry:`) specified as disjoint from the F7 MVP `broadcasts:` namespace? [Consistency, research § 2]
- [x] CHK025 Is the per-broadcast retry-serialisation lock requirement (`broadcasts-retry:`) explicitly tied to FR-008d (concurrent admin retry race protection)? [Traceability, Spec FR-008d + critique E4]
- [x] CHK026 Is the lock-release semantics requirement specified (auto-release at tx-end vs explicit release)? [Clarity, contracts/batch-dispatch.md § 1.2 — uses `pg_advisory_xact_lock` which auto-releases; verify documented]
- [x] CHK027 Are requirements specified for lock-acquisition failure paths (e.g., `ALREADY_RETRYING_IN_PROGRESS` error code)? [Completeness, contracts/batch-dispatch.md § 2]

## RBAC + Member Ownership (US1 + US2 + US7)

- [x] CHK028 Are admin-role requirements explicitly specified for ALL admin-only routes (templates CRUD, allowlist mutations, retry/accept-partial)? [Coverage, contracts § auth fields]
- [x] CHK029 Are member-ownership-of-draft requirements specified for member-side actions (template snapshot, image upload to draft)? [Completeness, contracts/broadcast-template.md § 1.4]
- [ ] CHK030 Is the consent-withdrawability invariant preserved (admin CANNOT toggle on behalf of a member for any future US3 carryover)? [Consistency, Gap — F7.1a doesn't include US3 contact opt-in but document the invariant for F7.1b promotion]

## Audit Trail Coverage (Principle I sub-clause 4)

- [x] CHK031 Are all 10 new audit-event types specified with severity class (INFO/WARN/CRITICAL)? [Completeness, data-model § 7]
- [x] CHK032 Are audit events for security-relevant actions (allowlist mutations, template deletions, retry attempts) tagged with actor + before/after values where applicable? [Clarity, Spec FR-008b + FR-015 + FR-021]
- [x] CHK033 Is the 5-year retention requirement explicit for ALL 10 new event types? [Consistency, data-model § 7]
- [x] CHK034 Is the `broadcast_template_seed_skipped_existing_name` operator-level audit signal specified for migration-time idempotency conflicts? [Completeness, Spec FR-020]

## OWASP Top 10 + DPIA

- [x] CHK035 Are OWASP risks mapped to F7.1a surfaces (XSS, SSRF, broken-access-control, injection, insecure-deserialisation)? [Coverage, plan.md Constitution Check I]
- [ ] CHK036 Is the DPIA addendum scope for F7.1a documented (US2 image uploads = member-content processing surface; US7 template authoring = admin-content surface)? [Completeness, plan.md Constitution Check I — DPIA addendum mentioned but content unspecified]
- [x] CHK037 Is the SSRF defence for US2 image upload (NEVER fetch external `<img src>` server-side; only upload to chamber bucket) explicitly stated? [Clarity, plan.md Constitution Check I + Spec FR-012]

## Notes

- Items marked `[Gap]` indicate missing requirements; items marked `[Spec §...]` reference existing requirements being validated for quality.
- Each item asks about REQUIREMENT QUALITY (Are they written? Are they clear? Are they consistent?) — NOT implementation behaviour.
- Total: 37 items across 7 categories.
- Pass criteria for `/speckit.tasks` gate: ≥95% of items either ✓ (requirement well-specified) or actioned with a follow-up task in tasks.md.
- Cross-reference: every `[Gap]` finding should produce a discrete polish task in Phase 6 of tasks.md.
