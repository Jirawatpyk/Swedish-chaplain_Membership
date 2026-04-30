# Security Requirements Quality Checklist: F7 — Email Broadcast (E-Blast)

**Purpose**: Validate the **security requirements** in F7's spec/plan are complete, clear, consistent, measurable, and traceable — before /speckit.tasks. Tests the requirements themselves (unit tests for English), not the implementation.
**Created**: 2026-04-29
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [data-model.md](../data-model.md)
**Depth**: Formal release gate (Constitution Gate 4 expectation for sensitive features; mandatory ≥2-reviewer co-sign per Principle IX)
**Audience**: Reviewer at PR / staff-review (Principle IX ≥2 reviewers; one signs the security checklist)
**Threat-model frame**: OWASP Top 10 (2021) · Constitution Principle I (data privacy + tenant isolation NON-NEGOTIABLE) · Principle III (Clean Architecture boundaries) · Principle IX (code quality + security review)
**Companion**: [privacy.md](./privacy.md) (privacy/compliance) — security findings that overlap (e.g., CHK024 token-pepper) are tracked there too

## Authentication & Authorization (RBAC)

- [ ] CHK001 Are the **role permissions** for each F7 endpoint (submit / approve / reject / cancel / proxy / clear-halt / view-queue / view-broadcast / unsubscribe) explicitly enumerated for each of `member`, `admin`, `manager` roles? [Completeness, Spec § FR-002 / FR-010 / FR-011 / FR-012 / FR-014 / FR-029 / Q12]
- [ ] CHK002 Are the **member-self ownership checks** (a member can only submit / cancel / view their own broadcasts) explicitly required at the application layer in addition to RLS? [Coverage, Spec § FR-001 + US3 AS5]
- [ ] CHK003 Is the **manager read-only constraint** specified for every mutating F7 endpoint with explicit 403 response on direct API attempts? [Consistency, Spec § FR-014 + US2 AS5 + Q14 clear-halt note]
- [ ] CHK004 Is the **cross-member URL-guessing defence** specified — i.e., 404-not-403 on probe attempts to leak existence? [Clarity, Spec § US3 AS5 + FR-037]
- [ ] CHK005 Is the **admin-on-behalf-of-member proxy** authorisation (Q12) specified to ensure admin cannot bypass any member-side validation (quota, tier, primary-contact)? [Coverage, Spec § Q12 + FR-005 dual-actor + US1 AS9]
- [ ] CHK006 Is the **F1 RBAC inheritance** (member/admin/manager roles) documented as the source of truth for F7 — i.e., F7 does NOT introduce new auth scheme? [Traceability, Plan § Constitution Check Principle I > Audit-log access controls]

## HTML Sanitisation — Member-Authored Content (FR-002a)

- [ ] CHK007 Is the **allowed-tags allowlist** explicitly enumerated and consistent across spec FR-002a + research.md DOMPurify config + Tiptap extension config? [Consistency, Spec § FR-002a + Research § 2 + § 3]
- [ ] CHK008 Are the **forbidden tags** (`script`, `style`, `iframe`, `form`, `link`, `meta`, `base`, `object`, `embed`, `svg`, `img`) explicitly enumerated with each documented as a specific attack vector? [Completeness, Spec § FR-002a]
- [ ] CHK009 Is the **`<img>` tag forbidden state** (Round 1 critique E9/X3) consistently reflected across FR-002a + research.md DOMPurify config + Tiptap Image extension disabled state + plan project structure (no image-upload button)? [Consistency, Spec § FR-002a + Research § 2 + Round 1+2 critique reports]
- [ ] CHK010 Are the **forbidden attributes** (all `on*` event handlers, inline `style`, all `data-*` except documented allowlist, `javascript:` / `data:` URI schemes) explicitly enumerated? [Completeness, Spec § FR-002a]
- [ ] CHK011 Is the **`a[href]` URL scheme allowlist** (`http://`, `https://`, `mailto:`) explicitly specified with rejection of `javascript:`, `data:`, `file:`, `vbscript:`? [Clarity, Spec § FR-002a]
- [ ] CHK012 Is the **server-side enforcement boundary** (Application layer is the source of truth; Tiptap client-side filtering is best-effort UX) explicitly stated as the security guarantee? [Clarity, Spec § FR-002a + Round 2 R2-NEW-2]
- [ ] CHK013 Is the **deterministic output requirement** for the sanitiser (snapshot-tested in unit tests) specified to defend against version-bump regressions? [Measurability, Spec § FR-002a + Plan § Testing fast-check property test recommendation]
- [ ] CHK014 Is the **size cap for body HTML** (≤200 KB after sanitisation) enforced both client-side AND server-side, with explicit defence-in-depth rationale? [Coverage, Spec § FR-002 precondition `f` + FR-002a]

## Webhook Signature Verification (FR-024-025)

- [ ] CHK015 Is the **Resend Svix HMAC-SHA256 verification** specified to run BEFORE any payload field is read, with 401 + audit-on-failure pattern? [Clarity, Spec § FR-024 + Contracts/resend-webhook.md § 2]
- [ ] CHK016 Are the **signature failure modes** (missing svix-* headers, skew >5min, signature mismatch, malformed JSON) each enumerated with their distinct response codes + audit events? [Completeness, Contracts/resend-webhook.md § 2]
- [ ] CHK017 Is the **5-minute timestamp skew tolerance** explicitly specified as the replay-window guard, with explicit rejection beyond? [Clarity, Contracts/resend-webhook.md § 2]
- [ ] CHK018 Is the **webhook idempotency primitive** (`broadcast_deliveries(tenant_id, resend_event_id) UNIQUE` upsert with `ON CONFLICT DO NOTHING`) specified to handle Resend retry storms safely? [Coverage, Spec § FR-025 + Data-model § 1.2]
- [ ] CHK019 Is the **webhook endpoint Node.js runtime pinning** (NOT Edge) specified with the security rationale (raw-body access for signature verification)? [Traceability, Plan § Complexity Tracking]
- [ ] CHK020 Is the requirement that **signature secret MUST NOT appear in logs at any layer** (application + Vercel platform) explicitly stated? [Coverage, Spec § FR-042 + Plan § VII Vercel platform-layer log redaction verification]

## Unsubscribe Token Security (FR-029-032)

- [ ] CHK021 Is the **HMAC-SHA256 token format** with `UNSUBSCRIBE_TOKEN_SECRET` (separate from `AUTH_COOKIE_SIGNING_SECRET`) specified, with the rotation-independence rationale? [Clarity, Research § 4 + Contracts/unsubscribe-public.md § 2]
- [ ] CHK022 Is the **timing-safe HMAC comparison** (`crypto.timingSafeEqual` per F1 pattern) specified to defend against timing-attack token enumeration? [Coverage, Research § 4 + Contracts/unsubscribe-public.md § 4]
- [x] CHK023 Is the **`tenant_id`-peppered email hash** (`eml: sha256(tenant_id + ':' + email_lower)`) specified per Round 1 critique E7 to defend against cross-tenant rainbow-table attacks? [Consistency, Research § 4 + Contracts/unsubscribe-public.md § 2 + privacy.md CHK024 cross-link → resolved 2026-04-29 inherits privacy CHK024 fix]
- [ ] CHK024 Is the **token-tampered fallback page** specified to render a bilingual error WITHOUT silently succeeding or silently failing, with audit emission `broadcast_unsubscribe_token_invalid`? [Completeness, Spec § FR-032 + Contracts/unsubscribe-public.md § 6.3]
- [ ] CHK025 Is the **idempotency requirement** for unsubscribe (replayed valid token = no duplicate suppression row + no duplicate audit event) explicitly stated? [Clarity, Spec § US4 AS3 + FR-031]
- [x] CHK026 Is the **token URL log retention risk** acknowledged with a documented mitigation (Vercel platform-layer redaction verification per Round 1 E11 / CHK048 + quarterly secret rotation fallback)? [Coverage, Plan § VII Vercel platform-layer log redaction verification → resolved 2026-04-29 inherits privacy CHK048 plan addition]
- [ ] CHK027 Is the **rate limit on `/unsubscribe/[token]`** (20 hits / 5 min per source IP) specified to defend against brute-force token enumeration? [Coverage, Plan § Storage rate-limit buckets]

## Tenant Isolation (Constitution v1.4.0 Principle I — NON-NEGOTIABLE)

- [ ] CHK028 Are the **two-layer tenant isolation requirements** (Application layer `runInTenant` + Database layer Postgres RLS + FORCE) specified for every F7 table? [Completeness, Spec § FR-036 + Constitution clause 1-2]
- [ ] CHK029 Is the **mandatory cross-tenant integration test** (Constitution clause 3 Review-Gate blocker) covering all 4 F7 tables + cross-feature joins (custom-list validation against F3 members) specified? [Coverage, Spec § FR-038 + Plan § Testing + Round 1 critique E18]
- [ ] CHK030 Are the **two narrow RLS bypass contexts** (webhook signature-verify pre-tenant-resolution + public unsubscribe pre-tenant-token-verify) explicitly justified with their re-binding pattern in Complexity Tracking? [Traceability, Plan § Complexity Tracking + Data-model § 2]
- [ ] CHK031 Is the **cross-tenant probe response** (404, NOT 403, with `broadcast_cross_tenant_probe` audit event at high severity) specified consistently across FR-037 + audit catalogue? [Consistency, Spec § FR-037 + Data-model § 5 row 25]
- [ ] CHK032 Is the **TenantContext as a first-class Domain type** (per Constitution Principle III + clause 1) specified to prevent string-typed tenant IDs as implicit parameters? [Clarity, Plan § Constitution Check Principle III]

## Input Validation & Injection Defences (OWASP A03)

- [ ] CHK033 Are the **zod validation requirements** at every API boundary enumerated, with explicit rejection patterns for malformed input? [Completeness, Plan § Architecture]
- [ ] CHK034 Is the **size-cap defence** (subject ≤200 chars / body ≤200 KB / custom-list ≤100 entries / recipient ≤5,000) enforced both client-side AND server-side with bilingual error codes? [Coverage, Spec § FR-002 + FR-015 + FR-016a]
- [ ] CHK035 Is the **custom-list email-format validation** (RFC-5321 via `email-validator`) specified to reject malformed inputs before tenant-graph resolution? [Clarity, Spec § FR-015d + Plan § email-validator dep]
- [ ] CHK036 Is the **custom-list tenant-graph membership requirement** (every entry resolves to a known member/contact/event-attendee email — Q9) specified to defend against using chamber sender reputation for arbitrary external blasts? [Coverage, Spec § FR-015d + Q9]
- [ ] CHK037 Is the **rate-limit catalogue** (10 submissions/24h, 60 drafts/5min, 30 admin actions/5min, 600 webhook events/min, 20 unsubscribe hits/5min) specified with explicit per-actor scoping? [Completeness, Plan § Storage rate-limit buckets]
- [ ] CHK038 Are the **Drizzle parameterised query requirements** (no string concatenation in SQL, no dynamic SQL in webhook handler) specified as the primary OWASP A03 defence? [Coverage, Plan § Constitution Check Principle I OWASP A03]

## Secrets Handling & Key Management

- [ ] CHK039 Are all **F7 secret env vars** (`RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, reused `CRON_SECRET`) enumerated with documented rotation cadence + responsibility? [Completeness, Plan § Constraints + Quickstart § 4]
- [ ] CHK040 Is the **separation between `UNSUBSCRIBE_TOKEN_SECRET` and `AUTH_COOKIE_SIGNING_SECRET`** explicitly justified (independent rotation; compromise containment; different lifetimes)? [Traceability, Research § 4]
- [x] CHK041 Is the **secret-rotation procedure** (zero-downtime, per Vercel env var update + redeploy) documented or referenced? [Gap → resolved 2026-04-29 via plan.md § VII Operational Readiness > Secret-rotation procedure — table for all 4 F7 secrets (RESEND_BROADCASTS_API_KEY, RESEND_BROADCASTS_WEBHOOK_SECRET, UNSUBSCRIBE_TOKEN_SECRET, CRON_SECRET) with cadence + zero-downtime steps + compromise response; runbook stub `docs/runbooks/credential-compromise.md` cross-cutting F1+F4+F5+F7]
- [ ] CHK042 Is the **secret-leak detection** (CI lint rule + git-history scan + Vercel env-var-only commitment) specified to catch accidental commits? [Coverage, CLAUDE.md Secrets section]
- [ ] CHK043 Are the **forbidden-in-logs items** (FR-042) comprehensive — covering all secrets, raw bodies, raw tokens, raw recipient emails? [Completeness, Spec § FR-042]

## Idempotency & Replay Defences

- [ ] CHK044 Is the **stable Resend dispatch idempotency key** (`broadcast-{tenantId}-{broadcastId}` — no attempt counter per Round 1 E2/X2) specified to prevent duplicate Resend broadcast resources under cross-tx-failure retry? [Clarity, Spec § FR-020 + Plan § Reliability cross-tx-failure-recovery]
- [ ] CHK045 Is the **cron dispatch idempotency** via `SELECT FOR UPDATE SKIP LOCKED` + per-`(tenant_id, broadcast_id)` `pg_advisory_xact_lock` specified with the namespace `broadcasts:` disjoint from F4 `invoicing:` and F5 `payments:`? [Coverage, Research § 6]
- [ ] CHK046 Is the **concurrent-admin-action blocking** (US2 AS6 — second approve attempt returns 409 + `broadcast_concurrent_action_blocked` audit) specified to prevent double-dispatch race conditions? [Clarity, Spec § US2 AS6]
- [ ] CHK047 Is the **stuck-`sending` reconciliation** (Round 2 R2-NEW-3 — at 24h timeout, query Resend `broadcasts.retrieve` before consuming quota) specified with the failure-mode rationale (manual Resend dashboard deletion)? [Coverage, Plan § Reliability + Spec § FR-033 audit `broadcast_resend_resource_missing`]

## Content & Sender Identity Security

- [ ] CHK048 Is the **from-name impersonation prevention** (locked format `<member display name> via <tenant display name>`, non-editable in MVP) specified? [Clarity, Spec § Edge Cases "Sender identity / from-name conflict"]
- [ ] CHK049 Is the **reply-to validation** (FR-002 precondition `j` blocks submission if `primary_contact_email IS NULL` — Q11) specified to prevent broadcasts with no valid reply-to? [Coverage, Spec § FR-002 precondition `j`]
- [ ] CHK050 Are the **audit payload PII-hashing requirements** (sha256 of recipient emails + rejection reasons + body content references; raw values stay in owning tables) specified across all 37 audit event types? [Consistency, Spec § FR-034 + Data-model § 5]

## Operational Security & Kill Switches

- [ ] CHK051 Is the **`FEATURE_F7_BROADCASTS=false` kill-switch** specified with documented behaviour (compose surface returns 503; cron handler skips; member sees fallback UI)? [Completeness, Plan § Constraints + Spec § Edge Cases tenant-disable]
- [ ] CHK052 Is the **`READ_ONLY_MODE=true` global emergency switch** (inherited from F1) documented as applicable to F7 mutating endpoints? [Coverage, Quickstart § 11]
- [ ] CHK053 Is the **CSP nonce mechanism reuse** (no new directives required for Tiptap; no external script CDN) specified to prevent inadvertent CSP weakening? [Clarity, Plan § Constraints CSP]

## Halt-Flag & Account Security

- [ ] CHK054 Is the **`broadcasts_halted_until_admin_review` flag** specified to be settable ONLY by F7 webhook handler (auto-halt on >5% complaint) and clearable ONLY by admin (NOT manager NOT member)? [Clarity, Spec § Q14 + FR-014 + R3-NEW-3]
- [ ] CHK055 Is the **clear-halt UI single-source-of-truth** (F7 admin queue page only; F3 members list shows badge but no clear-action) specified to prevent dual-control-point ambiguity? [Consistency, Spec § Q14 clear-halt UI section + Round 3 R3-NEW-3]
- [ ] CHK056 Is the **typed-phrase confirmation pattern** (matches F4 destructive-action convention) specified for Clear-halt action to prevent accidental restore? [Coverage, Spec § Q14]
- [x] CHK057 Is the **halt-flag lifecycle on member state changes** (archive / reactivate / plan-up/down / Art. 17 erasure / email-change) specified to prevent halt-bypass via state-change exploits? [Coverage, Spec § Edge Cases + privacy.md CHK047 cross-link → resolved 2026-04-29 inherits privacy CHK047 spec edge case]

## Audit Trail Integrity (Constitution Principle VIII — security view)

- [ ] CHK058 Is the **append-only audit log invariant** specified at DB level (trigger preventing UPDATE/DELETE) for `broadcast_deliveries` (data-model § 4.4) AND inherited from F1 for `audit_log` table? [Completeness, Data-model § 4.4]
- [ ] CHK059 Are the **high-severity audit events** (cross-tenant probe, signature rejection, complaint-rate breach, token-invalid, suppression-applied, complaint-received, halt-flag set) flagged with explicit alert-routing requirements? [Coverage, Spec § FR-033 + Plan § VII alerts #1-11]
- [ ] CHK060 Is the **traceability from audit event back to actor + target** specified for every event type to support forensic analysis? [Clarity, Data-model § 5 payload column]

## OWASP Top 10 Coverage

- [ ] CHK061 Is **OWASP A01 Broken Access Control** explicitly mapped to F7 surfaces with mitigations enumerated (RBAC + RLS + member-self-ownership + webhook-signature + token-signing)? [Coverage, Plan § Constitution Check Principle I OWASP A01]
- [ ] CHK062 Is **OWASP A02 Cryptographic Failures** addressed with explicit mitigations (TLS 1.2+, AES-256 at rest, HMAC for tokens + webhook signatures, secret-management)? [Coverage, Plan § Constitution Check Principle I OWASP A02]
- [ ] CHK063 Is **OWASP A03 Injection** addressed for HTML (DOMPurify allowlist) AND SQL (Drizzle parameterised) AND webhook payloads (SDK-parsed)? [Coverage, Plan § Constitution Check Principle I OWASP A03]
- [ ] CHK064 Is **OWASP A05 Security Misconfiguration** addressed with `FEATURE_F7_BROADCASTS` env flag gating + Resend test-vs-live key segregation + CSP allowlist? [Coverage, Plan § Constitution Check Principle I OWASP A05]
- [ ] CHK065 Is **OWASP A06 Vulnerable & Outdated Components** addressed with pinned deps (Tiptap @^3, isomorphic-dompurify @^2, email-validator @^2) + Renovate manual-review on sanitiser bumps + CI `pnpm audit` blocking? [Coverage, Plan § Constitution Check Principle I OWASP A06 + Round 1 critique E22]
- [ ] CHK066 Is **OWASP A07 Identification & Authentication Failures** addressed for webhook (signature-only authz) + unsubscribe (token-only authz with explicit failure paths)? [Coverage, Plan § Constitution Check Principle I OWASP A07]
- [ ] CHK067 Is **OWASP A09 Security Logging & Monitoring Failures** addressed with the high-severity audit events + alert routing per FR-033 + plan § VII alerts? [Coverage, Plan § Constitution Check Principle I OWASP A09]
- [ ] CHK068 Is **OWASP A10 SSRF** addressed — no outbound HTTP to user-controlled URLs (Resend SDK is only outbound; endpoint URL pinned to `api.resend.com`)? [Coverage, Plan § Constitution Check Principle I OWASP A10]

## Conflicts & Ambiguities

- [ ] CHK069 Is there any **conflict between FR-002a sanitiser allowlist and Tiptap toolbar** that could allow a member to insert a tag the editor permits but the sanitiser strips? — confirmed resolved by Round 2 R2-NEW-1 (Tiptap Image extension disabled). [Conflict-resolution, Spec § FR-002a + Round 2 critique R2-NEW-1]
- [ ] CHK070 Is there any **conflict between webhook idempotency primitive and orphan-event handling**? — orphan events (broadcast_id not in our DB) return 200 + log-only — verified consistent. [Consistency, Contracts/resend-webhook.md § 5]
- [ ] CHK071 Is the **assumption that "Tiptap client-side filtering is best-effort, not security boundary"** explicitly stated to prevent reviewers from over-trusting the editor? [Assumption, Spec § FR-002a]
- [x] CHK072 Is the **assumption that "Resend's webhook signature is non-repudiable evidence"** acknowledged or qualified — i.e., what happens if Resend's signing key is itself compromised? [Assumption, Gap → resolved 2026-04-29 via research.md § 1 Trust Assumptions — explicit acknowledgment of signing-key compromise scenario + 3 independent mitigations (audit forensics + high-severity alerts + rotation cadence) + reference to Resend SOC 2 Type II attestation]

## Documentation & Traceability

- [x] CHK073 Is the **F7 threat model** explicitly documented (or referenced from a shared threat-model doc) covering: token forgery, sanitiser bypass, signature replay, cross-tenant leakage, secret leakage, halt-bypass, idempotency violation, Resend account compromise? [Traceability, Gap → resolved 2026-04-29 via NEW `specs/010-email-broadcast/security.md` — STRIDE-mapped 11-threat model (T-01 through T-11) covering all listed scenarios + F1+F4+F5 inherited threats + checklist-mapping table + Principle IX sign-off mechanism]
- [ ] CHK074 Are all **Round 1 + Round 2 + Round 3 critique findings** with security relevance (E2/X2, E7, E9/X3, E10, E11, E25, R3-NEW-1) traceable to specific FRs / spec sections / resolution status? [Traceability, Critique reports under critiques/]
- [ ] CHK075 Is a **security review sign-off** required by Constitution Principle IX (≥2 reviewers; one signs the security checklist) explicitly noted as a Review-Gate prerequisite for F7? [Completeness, Constitution § Principle IX + Plan § Constitution Check Principle IX]

## Notes

- Check items off as completed: `[x]`
- For each unchecked item, log resolution path: (a) update spec/plan to address, (b) accept gap with rationale in Notes section, (c) defer to /speckit.tasks discovery task with stakeholder owner.
- Items marked `[Gap]` represent missing requirements; staff-reviewer signing this checklist must confirm each gap is intentionally accepted or addressed.
- This checklist tests **requirements quality**, not implementation. Implementation verification happens at /speckit.verify gate.
- 75 items total (CHK001–CHK075). Constitution Gate 4 expectation for sensitive features (≥30 items, full quality dimensions). Security is the 2nd of 6 expected checklists for F7 (privacy.md done; ux.md, a11y.md, i18n.md, perf.md still TBD).
- **Cross-references with privacy.md**: CHK023 (token pepper) overlaps privacy CHK024; CHK026 (token URL redaction) overlaps privacy CHK048; CHK057 (halt-flag lifecycle) overlaps privacy CHK047. These items resolve together.
- Co-sign requirement per Constitution Principle IX: this checklist must be reviewed + signed by 1 of the ≥2 reviewers (or co-signed by the staff-review agent under the solo-maintainer substitute clause). Unlike privacy.md, this is a HARD prerequisite for F7 ship gate per Principle IX security-sensitive review.

## Resolved-in-Place (2026-04-29 — all 6 flagged items resolved through spec/plan/research/threat-model edits)

The following items were resolved by direct artefact edits on 2026-04-29 — reviewer verifies the change at the cited spec location:

- [x] **CHK023** — Token email-hash peppered with `tenant_id`. Inherits privacy CHK024 fix → resolved via `research.md § 4 Trust Assumptions section + § 4 token format` + `contracts/unsubscribe-public.md § 2`.
- [x] **CHK026** — Vercel platform-layer log redaction. Inherits privacy CHK048 fix → resolved via `plan.md § VII Operational Readiness > Vercel platform-layer log redaction verification`.
- [x] **CHK041** — Secret-rotation procedure. Resolved via `plan.md § VII Operational Readiness > Secret-rotation procedure` — comprehensive table for all 4 F7 secrets + zero-downtime steps + compromise response. Cross-cutting runbook `docs/runbooks/credential-compromise.md` (NEW stub) covers F1/F4/F5/F7.
- [x] **CHK057** — Halt-flag lifecycle on member state changes. Inherits privacy CHK047 fix → resolved via `spec.md § Edge Cases` 6-scenario bullet.
- [x] **CHK072** — Resend signing-key compromise assumption. Resolved via `research.md § Trust Assumptions` — explicit acknowledgment + 3 independent mitigations (audit forensics + high-severity alerts + rotation cadence) + Resend SOC 2 Type II reference.
- [x] **CHK073** — F7 threat model document. Resolved via NEW `specs/010-email-broadcast/security.md` — STRIDE-mapped 11-threat model covering all listed scenarios + F1+F4+F5 inherited threats + checklist-mapping table + Principle IX sign-off mechanism.

## Cross-references with privacy.md

| Security CHK | Privacy CHK | Status |
|--------------|-------------|--------|
| CHK023 (token pepper) | CHK024 | ✅ resolved together |
| CHK026 (Vercel redaction) | CHK048 | ✅ resolved together |
| CHK057 (halt lifecycle) | CHK047 | ✅ resolved together |

## Quality Dimension Summary (post-resolution 2026-04-29)

| Dimension | # Items | Coverage | Status |
|-----------|---------|----------|--------|
| Completeness | 11 | RBAC enumeration, forbidden tags/attrs, signature failure modes, secret catalogue, audit events, OWASP coverage | ✅ |
| Clarity | 12 | URL scheme allowlist, signature verify timing, idempotency key shape, RBAC role boundaries, sender identity locking | ✅ |
| Consistency | 8 | Sanitiser allowlist cross-doc, RBAC across endpoints, audit catalogue, halt-flag UI single source, img-tag forbidden state | ✅ |
| Coverage | 21 | Member-self ownership, replay defence, rate limits, OWASP Top 10 mapping, kill switches, halt-flag lifecycle, idempotency primitives | ✅ |
| Measurability | 1 | Sanitiser deterministic snapshot test | ✅ |
| Traceability | 7 | F1 RBAC inheritance, Critique findings → FRs, threat model reference, security review sign-off | ✅ |
| Conflict-resolution | 2 | FR-002a vs Tiptap toolbar (resolved Round 2), idempotency vs orphan (resolved Round 2) | ✅ |
| Assumption | 2 | Tiptap client-side filtering is UX not security; Resend signing-key non-repudiation (CHK072 resolved) | ✅ |
| Gap markers | **0** | (was 3 explicit + 1 implicit — all resolved by 2026-04-29 integrations) | ✅ |

**Security posture summary (final)**:

- ✅ RBAC + tenant isolation specified at both Application + Database layers
- ✅ HTML sanitiser allowlist + Tiptap config consistent (Round 1 E9/X3 + Round 2 R2-NEW-1 closed)
- ✅ Webhook signature verification with Svix HMAC + 5-min skew + idempotency primitive
- ✅ Unsubscribe token HMAC + tenant_id pepper + timing-safe + Vercel platform redaction verification path
- ✅ Stable Resend idempotency key (Round 1 E2/X2 closed)
- ✅ Halt-flag lifecycle across 6 member-state-change scenarios
- ✅ Secret-rotation procedure for all 4 F7 secrets + cross-cutting runbook
- ✅ Resend signing-key compromise threat acknowledged with 3 mitigation layers
- ✅ F7 threat model document authored (STRIDE 11-threat + F1+F4+F5 inheritance)
- ✅ OWASP Top 10 explicit mapping (8 items)
- ✅ Constitution Principle I/III/IX touch points all addressed
- ✅ Zero open gaps blocking /speckit.tasks gate

Total: **75 items** across 14 categories + 6 Resolved-in-Place. Aligns with Gate 4 "formal release gate" depth expectation. **0 open gaps**. 

**Sign-off**: ready for ≥2-reviewer co-sign per Constitution Principle IX (one reviewer signs the security checklist + threat model — solo-maintainer substitute applies if no second human reviewer available, with the 6-stack agent verification documented in `plan.md` § Constitution Check Principle IX).
