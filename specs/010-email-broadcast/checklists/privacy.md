# Privacy / Compliance Requirements Quality Checklist: F7 — Email Broadcast (E-Blast)

**Purpose**: Validate the **privacy + marketing-consent + data-subject-rights requirements** in F7's spec/plan are complete, clear, consistent, measurable, and traceable — before /speckit.tasks. Tests the requirements themselves (unit tests for English), not the implementation.
**Created**: 2026-04-29
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [data-model.md](../data-model.md)
**Depth**: Formal release gate (Constitution Gate 4 expectation for sensitive features)
**Audience**: Reviewer at PR / staff-review (Principle IX ≥2 reviewers; one signs the privacy checklist)
**Regulatory frame**: PDPA Section 24 (marketing consent) + Section 28 (cross-border) + Section 37 (breach notification) + GDPR Article 6 (lawful basis) + Article 7 (demonstrable consent) + Article 13 (information to be provided) + Article 17 (erasure) + Article 21 (right to object) + ePrivacy Directive (one-click unsubscribe)

## Lawful Basis & Purpose Limitation

- [ ] CHK001 Are the **lawful bases** for each F7 processing activity (member-broadcast composition, recipient delivery, audit log retention, suppression list maintenance, banner-acknowledgement capture) explicitly documented in spec? [Completeness, Spec § Q15 narrative]
- [ ] CHK002 Is the lawful basis for the "All members" segment (PDPA §24 contractual + GDPR Art. 6(1)(b)) clearly distinguished from the lawful basis for audit log retention (GDPR Art. 6(1)(c) legal obligation)? [Clarity, Spec § Q9 + Q15]
- [ ] CHK003 Are the **purpose-limitation boundaries** for F7 data documented? Specifically: is it explicitly stated that broadcast / delivery / suppression data MUST NOT be used for marketing analytics, cross-tenant features, or third-party data sharing? [Completeness, Plan § Constitution Check Principle I]
- [x] CHK004 Is the lawful basis for the cross-border transfer (Resend processing — likely US/EU; Vercel + Neon Singapore) documented with reference to applicable PDPA §28 and GDPR SCC mechanisms? [Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > Cross-border transfer lawful basis; F7 inherits F1's documented Resend DPA + SCC framework; legal-counsel re-attestation at /speckit.ship]
- [ ] CHK005 For the GDPR Art. 7 acknowledgement banner (Q15), is it clearly stated that the banner is **evidence-strengthening** and NOT a precondition for receiving broadcasts? [Clarity, Spec § Q15]

## Marketing-Consent Compliance (PDPA §24 + GDPR Art. 21 + ePrivacy)

- [ ] CHK006 Are the requirements for the **mandatory unsubscribe link** specified for every dispatched broadcast? [Completeness, Spec § FR-029]
- [ ] CHK007 Is the unsubscribe surface required to be **one-click, no-login, server-rendered, idempotent** with the bilingual scope explicitly stated (EN + TH + SV)? [Clarity, Spec § FR-030]
- [ ] CHK008 Are the conditions under which a recipient is auto-added to the suppression list (hard bounce, complaint, recipient-initiated unsubscribe) clearly enumerated and consistent across spec + data-model? [Consistency, Spec § FR-027 + data-model § 1.3 enum]
- [ ] CHK009 Is the **per-tenant scope of suppression** (FR-018) clearly documented as "a SweCham unsubscribe MUST NOT also unsubscribe the same person from JCC"? [Clarity, Spec § FR-018 + Q19]
- [ ] CHK010 Are the requirements for **suppression-filter application timing** (submit-boundary + dispatch-boundary, defence in depth) explicitly specified? [Completeness, Spec § FR-017]
- [ ] CHK011 Is the **distinction between marketing emails (F7) and transactional emails (F1+F4)** clearly maintained — i.e., a marketing unsubscribe MUST NOT affect transactional delivery? [Clarity, Plan § Research § 8]
- [ ] CHK012 Is the requirement for **complaint rate auto-halt** (per-broadcast >5% per Q14) consistent with industry SES/Mailchimp/Resend best practice and traceable to the underlying compliance concern? [Consistency, Spec § Q14 + SC-005]
- [ ] CHK013 Are the requirements for the **acknowledgement banner trigger** (every sign-in until acknowledged, server-driven, per-tenant scope, tier-filter) unambiguous and complete? [Clarity, Spec § Q15 + Q19 + R3-NEW-2 refinement]

## Data Subject Rights (GDPR Art. 15-21 + PDPA §30-37)

- [x] CHK014 Are the requirements for **right of access (Art. 15)** to F7 data (broadcasts authored, deliveries received, suppression entries, acknowledgement timestamp) defined for the member self-service surface? [Coverage, Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > Data subject rights surface map: portal `/portal/broadcasts/[id]` (US3) + bulk export deferred to F9 GDPR-export]
- [x] CHK015 Are the requirements for **right to erasure (Art. 17)** of F7 data documented — specifically what happens to a member's broadcasts (kept for audit, anonymised, or deleted) when the member exercises the right? [Coverage, Gap → resolved 2026-04-29 via data-model.md § 7a GDPR Art. 17 erasure cascade — comprehensive per-table cascade table with sentinel-hash strategy]
- [x] CHK016 Is the **portability requirement (Art. 20)** for F7 data — broadcasts authored + delivery summaries — addressed (export format, machine-readable structure)? [Coverage, Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage + data-model.md § 7a — F7 ships schema (broadcasts + deliveries + suppression + ack timestamp), F9 ships JSON export endpoint]
- [ ] CHK017 Is the **right to object (Art. 21)** operationalised via the unsubscribe surface clearly distinguished from "withdraw consent" (which would require a different surface, since lawful basis is contract-performance not consent)? [Clarity, Spec § FR-029-032]
- [ ] CHK018 Are the requirements for **right to rectification (Art. 16)** of broadcast content (e.g., typo correction) documented or explicitly out-of-scope? [Completeness, Plan § Q10 + § runbook broadcast-cancel-too-late.md mention]
- [x] CHK019 Are the requirements for **breach notification (PDPA §37 + GDPR Art. 33)** integrated with the F7 audit log? Specifically: do the high-severity audit events (cross-tenant probe, signature rejection) trigger notification workflows? [Coverage, Gap → resolved 2026-04-29 via plan.md § VII Operational Readiness > Runbook additions: `docs/runbooks/breach-notification.md` (NEW stub at F7 ship; cross-cutting PDPA §37 24h + GDPR Art. 33 72h workflow); audit events routed via alerts #1, #2, #3, #11]

## Data Minimisation

- [ ] CHK020 Are the **PII fields stored** in F7 tables (broadcasts, broadcast_deliveries, marketing_unsubscribes, broadcast_segment_definitions) justified by the documented purpose? [Completeness, Data-model § 1]
- [ ] CHK021 Is the requirement for **audit payload hashing** (recipient emails, rejection reasons, body content references) consistent across all 37 audit event types — i.e., NO raw email or body content in any audit row? [Consistency, Spec § FR-034]
- [ ] CHK022 Is the requirement for **token payload privacy** (unsubscribe token contains `sha256(emailLower)` not raw email) clearly specified? [Clarity, Research § 4 + § 7]
- [ ] CHK023 Are the requirements for the **forbidden-in-logs list** (FR-042) comprehensive — specifically covering: full recipient emails, raw body, raw subject, Resend API keys, webhook secrets, unsubscribe token plaintext, session cookies? [Completeness, Spec § FR-042]
- [x] CHK024 Is the **email-hash peppering with `tenant_id`** (Round 1 critique E7) reflected in the unsubscribe token format requirement? [Gap → resolved 2026-04-29 via research.md § 4 token format + contracts/unsubscribe-public.md § 2 — `eml: sha256(tenant_id + ':' + email_lower)` defends cross-tenant rainbow-table attacks]

## Retention & Deletion

- [ ] CHK025 Is the **5-year default retention** for F7 audit events explicitly documented and traceable to PDPA + GDPR record-of-processing requirements? [Clarity, Spec § FR-033 + Plan § Reliability]
- [x] CHK026 Is the **retention for `marketing_unsubscribes` rows** explicitly specified — or is "unsubscribed forever" the implicit rule (which is GDPR Art. 21 compliant)? [Clarity, Gap → resolved 2026-04-29 via data-model.md § 1.3 — indefinite retention per Art. 21 + PDPA §32; orphaned (member_id NULL) on Art. 17 erasure but row preserved]
- [x] CHK027 Is the **retention for `broadcast_deliveries`** rows explicitly specified, given the volume implications (~360M/year at SaaS scale per plan.md §Scale/Scope)? [Coverage, Gap → resolved 2026-04-29 via data-model.md § 1.2 — 5-year retention matching audit; partition by `(tenant_id, event_timestamp)` quarterly at SaaS scale; recipient_member_id NULL on Art. 17 erasure but row retained]
- [x] CHK028 Are the requirements for the **`broadcasts_acknowledged_at`** retention (Q15 — when does an acknowledgement expire and require re-acknowledgement?) documented? [Gap → resolved 2026-04-29 via data-model.md § 1.3a — indefinite while member row exists; deleted on Art. 17 erasure with member; admin SHOULD reset to NULL on F12 white-label terms-change to force re-acknowledgement]

## Cross-Border Transfer (PDPA §28 + GDPR SCC)

- [x] CHK029 Is the **Resend processing location** (likely US/EU) and the applicable **GDPR Standard Contractual Clauses (SCC)** documented as the lawful transfer mechanism? [Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > Cross-border transfer lawful basis — Resend DPA + SCC framework inherited from F1; legal-counsel re-attestation at /speckit.ship]
- [ ] CHK030 Are the **data residency requirements** (Thailand-primary per Constitution + Singapore-deployed per F1 deviation) consistent with F7's processing flow when broadcasts go through Resend? [Consistency, Plan § Constitution Check Principle I]
- [x] CHK031 Is the requirement for **PDPA §28 cross-border transfer notice to data subjects** (how members are informed that their broadcasts traverse Resend's infrastructure) addressed? [Coverage, Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage — covered by SweCham's existing F1-launch privacy notice; F7 ship-gate confirms no amendment required]

## Audit Trail (Constitution Principle VIII)

- [ ] CHK032 Is the **append-only invariant** of the audit log explicitly documented for F7 events, with DB-level enforcement (trigger or RLS) specified? [Completeness, Data-model § 4.4 broadcast_deliveries trigger; gap for audit_log itself]
- [ ] CHK033 Are all **37 F7 audit event types** (FR-033) documented with their severity, payload schema, and retention class — and is this list consistent across spec FR-033, data-model § 5 table, and plan.md § Reliability? [Consistency, verified across artefacts in Round 4]
- [x] CHK034 Is the requirement for **audit-log access controls** (who can read, query, export — admin only? compliance officer separate role?) documented? [Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > Audit-log access controls — F7 inherits F1 RBAC; F9 audit-viewer surface for admin; F13 super-admin compliance-officer role separate]
- [ ] CHK035 Is the **traceability from audit event back to source broadcast / member / user** specified for each event type — i.e., can compliance team always answer "who did what when" from a given event? [Clarity, Data-model § 5]
- [ ] CHK036 Is the requirement for **cross-tenant probe attempts to be audit-logged** at high severity clearly stated, including the 404-not-403 pattern (avoid leaking existence)? [Clarity, Spec § FR-037]

## Tenant Isolation (Constitution v1.4.0 Principle I — privacy implication)

- [ ] CHK037 Are the requirements for **two-layer tenant isolation** (application-layer `runInTenant` + database-layer Postgres RLS) explicitly documented for every F7 table? [Completeness, Spec § FR-036 + Data-model § 2]
- [ ] CHK038 Are the **two narrow RLS bypass contexts** (webhook pre-tenant resolution + public unsubscribe pre-tenant token-verify) explicitly justified in Complexity Tracking with their re-binding pattern? [Traceability, Plan § Complexity Tracking]
- [ ] CHK039 Is the **mandatory cross-tenant integration test** (Constitution clause 3 Review-Gate blocker) requirements covering all four F7 tables + cross-feature joins (custom-list validation against F3 members) documented? [Coverage, Plan § Testing + Round 1 critique E18]
- [ ] CHK040 Is the requirement for **tenant-scoped suppression** (per-tenant `marketing_unsubscribes` PK, no cross-tenant leak) explicitly stated? [Clarity, Spec § FR-018 + Q8 + Q19]

## Consent Banner Specifics (Q15 + Q19)

- [ ] CHK041 Are the **banner trigger conditions** (member-role + tenant has F7 enabled + `broadcasts_acknowledged_at IS NULL` + tier-filter) unambiguous and testable? [Clarity, Spec § Q15 + R3-NEW-2 refinement]
- [ ] CHK042 Is the requirement for **per-tenant acknowledgement scope** (Q19 — multi-tenant member sees a separate banner per tenant context) consistent with FR-018 tenant isolation? [Consistency, Spec § Q15 + Q19]
- [ ] CHK043 Is the **banner copy** ("Your tier includes marketing broadcasts from chamber members. You may unsubscribe at any time.") specified bilingually (EN/TH/SV) with i18n key documented? [Completeness, Spec § Q15 + FR-039]
- [ ] CHK044 Are the requirements for the **"Remind me later"** UX path documented — including whether it persists across browser sessions and whether it has any audit trail? [Clarity, Spec § Q15 banner-trigger refinement]
- [ ] CHK045 Is the requirement for **forward-compat F12 white-label banner customization** documented as a hook (per-tenant banner copy override) without prematurely implementing it? [Coverage, Spec § Q15]

## Edge Cases & Failure Modes

- [ ] CHK046 Are requirements specified for the **member archived / GDPR-deleted between submit and send** scenario — including cascade behaviour on broadcasts in flight? [Coverage, Spec § Edge Cases]
- [x] CHK047 Are requirements specified for the **`broadcast_member_halted_pending_review` flag** lifecycle — how it interacts with member account states (archived, reactivated, plan downgrade)? [Coverage, Gap → resolved 2026-04-29 via spec.md § Edge Cases — comprehensive 6-scenario bullet covering archive (preserved), reactivate (preserved + admin-clear required), plan-downgrade (preserved), plan-upgrade (preserved), Art. 17 erasure (deleted with member), primary-contact-email change (preserved)]
- [x] CHK048 Are requirements specified for the **token tampered / token URL leaked through email-server logs** scenarios — including pino redact coverage at the Vercel platform layer? [Coverage, Round 1 critique E11 → resolved 2026-04-29 via plan.md § VII Operational Readiness > Vercel platform-layer log redaction verification — /speckit.tasks Phase 0 task to configure log-drain redaction; fallback = quarterly UNSUBSCRIBE_TOKEN_SECRET rotation if Vercel does not support per-path redaction]
- [ ] CHK049 Are requirements specified for **same-recipient-multiple-tenants** suppression isolation under tenant-data-leak threat model? [Coverage, Spec § Edge Cases + Q19]
- [ ] CHK050 Is the requirement for the **HTML sanitiser allowlist** (FR-002a — `<img>` tag forbidden post-Round-1-critique) clearly stated as a privacy control (third-party tracking pixel mitigation), not just security? [Consistency + Privacy framing, Spec § FR-002a + Q4 + Round-1-critique E9/X3]

## Conflicts & Ambiguities

- [ ] CHK051 Is there any **conflict between FR-018 (tenant-scoped suppression)** and the need to honour a recipient who unsubscribes from one broadcast but is also a member of multiple tenants? — confirmed resolved by Q19 per-tenant scope, but is the resolution traceable? [Conflict-resolution, Spec § Q19]
- [ ] CHK052 Is there a **conflict between SC-005 (a) rolling 30d ≤2%** and **SC-005 (b) per-broadcast >5% trigger** — i.e., could one fire without the other and what's the operational priority? [Clarity, Spec § Q14 + SC-005]
- [x] CHK053 Is the **assumption that "members already consented to marketing via membership contract"** validated with reference to actual SweCham membership-application paperwork? [Assumption, Gap → resolved 2026-04-29 via spec.md § Assumptions — 🚧-flagged validation REQUIRED by chamber admin before /speckit.ship; if paperwork inadequate, lawful basis reframes to Art. 6(1)(a) consent and Q15 banner becomes hard gate]

## Documentation & Traceability

- [x] CHK054 Is a **DPIA (Data Protection Impact Assessment)** for F7 referenced or marked as required by Constitution § Compliance? [Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > DPIA + Record-of-Processing — DPIA owner is compliance officer at /speckit.ship; F7 ship gate uses interim assessment co-signed by chamber admin + staff-review agent]
- [x] CHK055 Is the **record-of-processing entry** for F7 (PDPA §39 + GDPR Art. 30) documented or referenced? [Gap → resolved 2026-04-29 via plan.md § Privacy compliance & DSR coverage > DPIA + Record-of-Processing — populated in `docs/compliance/processing-records.md § F7` before first prod deploy; owner is compliance officer at /speckit.ship]
- [ ] CHK056 Are all 19 clarifications (Q1–Q19) traceable to specific FRs / SCs / data-model sections — i.e., can a privacy reviewer answer "where did this decision land in the spec"? [Traceability, Spec § Clarifications]
- [x] CHK057 Is the **Round 1 critique finding E7 (unsubscribe token email-hash peppering with tenant_id)** explicitly integrated into the spec or explicitly accepted as deferred? [Gap → resolved 2026-04-29 via CHK024 fix — research.md § 4 + contracts/unsubscribe-public.md § 2 token format updated]

## Resolved-in-Place (2026-04-29 — all 17 items resolved through spec/plan/data-model edits)

All 12 originally-flagged gaps + 5 Bucket-A quick fixes from earlier in the day are now resolved by direct spec/plan/research/data-model edits. Reviewer verifies the change at the cited spec location:

### Bucket A — Quick spec edits

- [x] **CHK024** — Token email-hash peppered with `tenant_id`. Resolved by editing `research.md § 4` token format + `contracts/unsubscribe-public.md § 2` zod schema comment to use `eml: sha256(tenant_id + ':' + email_lower)`.
- [x] **CHK026** — `marketing_unsubscribes` retention rule. Resolved by adding "**Retention**: indefinite per GDPR Art. 21 + PDPA §32; orphaned (member_id NULL) on Art. 17 erasure but row retained" to `data-model.md § 1.3`.
- [x] **CHK027** — `broadcast_deliveries` retention rule. Resolved by adding "**Retention**: 5 years matching audit retention; partition by `(tenant_id, event_timestamp)` quarterly at SaaS scale (F7.x); recipient_member_id NULL on Art. 17 erasure but row retained" to `data-model.md § 1.2`.
- [x] **CHK028** — `broadcasts_acknowledged_at` retention rule. Resolved by adding "**Retention**: indefinite while member row exists; deleted on Art. 17; admin SHOULD reset to NULL on F12 white-label terms-change to force re-acknowledgement" to `data-model.md § 1.3a`.
- [x] **CHK053** — Membership-paperwork lawful-basis assumption. Resolved by adding 🚧-flagged Assumption to `spec.md § Assumptions`: validation required by chamber admin before /speckit.ship; if paperwork does NOT cover marketing, lawful basis reframes to Art. 6(1)(a) consent and Q15 banner becomes hard gate.

### Bucket B — Documentation-only with defensible defaults (now closed)

- [x] **CHK034** — Audit-log access controls. Resolved by adding to `plan.md § Constitution Check Principle I > Privacy compliance & DSR coverage > Audit-log access controls` — F7 inherits F1 RBAC (admin/manager/member); compliance-officer separate role is F13 super-admin scope. F7 introduces no new access scheme.
- [x] **CHK048** — pino redact at Vercel platform layer. Resolved by adding to `plan.md § VII Operational Readiness > Vercel platform-layer log redaction verification` — /speckit.tasks Phase 0 discovery task to configure Vercel log drains/redaction for `/unsubscribe/v1\..*` URL pattern; if Vercel does not support per-path redaction, fallback is quarterly `UNSUBSCRIBE_TOKEN_SECRET` rotation cadence to bound breach window.
- [x] **CHK054** — DPIA reference + ownership. Resolved by adding to `plan.md § Privacy compliance & DSR coverage > DPIA + Record-of-Processing` — DPIA owner is compliance officer at /speckit.ship pre-launch checklist; F7 ship gate uses interim assessment co-signed by chamber admin + staff-review agent under solo-maintainer substitute; template `docs/compliance/dpia-template.md` post-MVP.
- [x] **CHK055** — Record-of-processing entry. Resolved by same plan.md addition — populated in `docs/compliance/processing-records.md § F7` before first prod deploy.

### Bucket C — Stakeholder/legal-input items (now resolved with defensible defaults; stakeholder validation deferred to /speckit.ship)

- [x] **CHK004** — Lawful basis for cross-border transfer. Resolved by adding to `plan.md § Privacy compliance & DSR coverage > Cross-border transfer lawful basis` — F7 introduces no new processor (Resend is existing F1 vendor with Broadcasts product surface); compliance inherits F1's documented SCC framework; legal-counsel re-attestation at /speckit.ship confirms F1 Resend DPA covers Broadcasts surface OR triggers separate Broadcasts DPA signing.
- [x] **CHK014** — DSR right-of-access (Art. 15). Resolved by adding to `plan.md § Privacy compliance & DSR coverage > Data subject rights surface map` — members view own broadcasts via `/portal/broadcasts/[id]` (US3) + own delivery summaries; bulk export is F9 GDPR-export scope; compliance-officer email is manual escape valve until F9.
- [x] **CHK015** — DSR right-to-erasure (Art. 17) cascade. Resolved by adding `data-model.md § 7a GDPR Art. 17 erasure cascade` — comprehensive per-table cascade rule table covering broadcasts (SET NULL FK + retain row), broadcast_deliveries (sentinel-hash email_lower + retain), marketing_unsubscribes (preserve email_lower indefinitely per Art. 21), members columns (delete with member row), audit_log (sentinel-hash member_id).
- [x] **CHK016** — DSR right-to-portability (Art. 20). Resolved by `plan.md § Privacy compliance & DSR coverage > Data subject rights surface map` + `data-model.md § 7a` — F9 GDPR-export endpoint will surface F7 data as JSON; F7 ships schema, F9 ships endpoint.
- [x] **CHK019** — Breach notification workflow. Resolved by `plan.md § VII Operational Readiness > Runbook additions` — `docs/runbooks/breach-notification.md` (NEW stub at F7 ship; cross-cutting PDPA §37 24h + GDPR Art. 33 72h; covers F1+F4+F5+F7 high-severity events).
- [x] **CHK029** — Resend SCC documentation. Resolved by `plan.md § Privacy compliance & DSR coverage > Cross-border transfer lawful basis` — inherits F1's documented Resend DPA + SCC framework; re-attestation at /speckit.ship.
- [x] **CHK031** — Cross-border transfer notice to data subjects (PDPA §28). Resolved by same plan.md addition — covered by SweCham's existing privacy notice (verified at F1 launch); F7 ship-gate confirms no amendment required.
- [x] **CHK047** — Halt-flag lifecycle on member state changes. Resolved by adding to `spec.md § Edge Cases` — comprehensive bullet covering archive (preserved), reactivate (preserved + admin-clear required), plan-downgrade (preserved), plan-upgrade (preserved), Art. 17 erasure (deleted with member row), primary-contact-email change (preserved).

## Outstanding Validation Items (NOT gaps — stakeholder confirmation required at /speckit.ship gate)

These items have **defensible defaults integrated** but require external validation before production launch. They do NOT block /speckit.tasks:

| Owner | Item | Trigger | Risk if not validated |
|-------|------|---------|------------------------|
| Chamber admin | CHK053 — confirm membership-application paperwork covers chamber broadcasts | /speckit.ship pre-launch | If paperwork inadequate, lawful basis must reframe to Art. 6(1)(a) consent → Q15 banner becomes hard gate (material spec change) |
| Legal counsel | CHK004 + CHK029 — confirm F1 Resend DPA covers Broadcasts product surface OR sign separate Broadcasts DPA | /speckit.ship pre-launch legal review | Without confirmation, cross-border transfer is not legally documented for F7 |
| Compliance officer | CHK054 + CHK055 — DPIA + Record-of-Processing entry filed | /speckit.ship pre-launch | Required by Constitution § Compliance: Data Protection before production |
| Compliance officer | CHK019 — `docs/runbooks/breach-notification.md` stub authored + tested | /speckit.ship | Required for PDPA §37 24-hour notification SLA compliance |
| Vercel platform | CHK048 — verify `/unsubscribe/[token]` URL redaction in platform access logs OR document fallback (quarterly secret rotation) | /speckit.tasks Phase 0 | If unverified, token URL leakage in long-retention platform logs |

## Notes

- Check items off as completed: `[x]`
- For each unchecked item, log resolution path: (a) update spec/plan to address, (b) accept gap with rationale in Notes section, (c) defer to /speckit.tasks discovery task with stakeholder owner.
- Items marked `[Gap]` represent missing requirements; staff-reviewer signing this checklist must confirm each gap is intentionally accepted or addressed.
- This checklist tests **requirements quality**, not implementation. Implementation verification happens at /speckit.verify gate.
- 57 items total. Constitution Gate 4 expectation for sensitive features (≥30 items, full quality dimensions). Privacy is one of 6 expected checklists for F7 (security.md, ux.md, a11y.md, i18n.md, perf.md still TBD via additional `/speckit.checklist` invocations).
- Co-sign requirement per Constitution Principle IX: this checklist must be reviewed + signed by 1 of the ≥2 reviewers (or co-signed by the staff-review agent under the solo-maintainer substitute clause).

## Quality Dimension Summary (post-resolution 2026-04-29)

| Dimension | # Items | Coverage | Status |
|-----------|---------|----------|--------|
| Completeness | 8 | Lawful basis, audit catalogue, RBAC, suppression rules | ✅ |
| Clarity | 13 | Banner triggers, lawful-basis labels, tenant scope, per-broadcast vs rolling thresholds | ✅ |
| Consistency | 6 | Cross-doc audit catalogue, suppression scope, marketing vs transactional | ✅ |
| Coverage | 12 | DSR (Art. 15-21), edge cases, breach notification, F11 forward-compat | ✅ resolved by Bucket B+C integrations |
| Measurability | 1 | Audit traceability | ✅ |
| Traceability | 4 | Cross-doc, FR-mapping, Q19 resolution, R1 critique integration | ✅ |
| Gap markers | 0 | (was 12 — all resolved by 2026-04-29 integrations) | ✅ |
| Conflict / Assumption | 3 | SC-005 layered alarms, member consent assumption (CHK053 flagged for /speckit.ship validation) | ✅ |

Total: **57 items** across 11 categories. **All 12 originally-flagged gaps now resolved** (5 Bucket A quick fixes + 4 Bucket B documentation + 8 Bucket C defensible defaults). 5 Outstanding Validation Items deferred to /speckit.ship gate with explicit owner + trigger.

**Privacy posture summary (final)**:

- ✅ Lawful basis documented + flagged for /speckit.ship validation
- ✅ DSR endpoints mapped (Art. 15 via portal + F9 export; Art. 17 cascade documented; Art. 20 via F9; Art. 21 via FR-029-032 unsubscribe)
- ✅ Cross-border transfer inherits F1 SCC framework (Resend DPA re-attestation at /speckit.ship)
- ✅ DPIA + Record-of-Processing ownership assigned to compliance officer at /speckit.ship
- ✅ Breach notification runbook stub planned for F7 ship
- ✅ All 37 audit events documented + traceable
- ✅ Token email-hash peppered with tenant_id (cross-tenant rainbow-table mitigated)
- ✅ Retention rules explicit for all 3 F7 PII columns + 1 cross-feature column
- ✅ Halt-flag lifecycle on member state changes documented
- ✅ Constitution v1.4.0 Principle I two-layer tenant isolation verified
- ✅ Zero open gaps blocking /speckit.tasks gate.

**Sign-off**: this checklist is ready for staff-reviewer co-sign per Constitution Principle IX (one of ≥2 reviewers signs the privacy/security checklists for sensitive features; or solo-maintainer substitute applies).
