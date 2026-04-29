# F7 Email Broadcast — Threat Model & Security Checklist

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Complete
**Frame**: STRIDE + OWASP Top 10 (2021) + Constitution v1.4.0 Principle I (NON-NEGOTIABLE) + Principle IX security review
**Companion docs**: [spec.md](./spec.md) · [plan.md](./plan.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [checklists/security.md](./checklists/security.md) · [checklists/privacy.md](./checklists/privacy.md)
**Convention**: Follows F1's threat-model template at `specs/001-auth-rbac/security.md` (16-threat F1 model) — F7 model is leaner because F7 inherits F1's auth + RBAC + RLS infrastructure and only introduces the broadcast-specific surfaces.

---

## 1. Trust Boundaries

| # | Boundary | Trusted side | Untrusted side | Verification at boundary |
|---|----------|--------------|-----------------|--------------------------|
| TB-1 | Member portal compose endpoint | Server (Application layer) | Member's browser | Session cookie (F1) + RBAC + zod input validation + FR-002 preconditions a-k + FR-002a sanitiser |
| TB-2 | Admin queue endpoints | Server | Admin's browser | Session cookie (F1) + RBAC `admin` role + zod |
| TB-3 | Resend Broadcasts webhook | Server (webhook handler) | Public internet (Resend service) | Svix HMAC-SHA256 signature verification BEFORE body parse; 5-min skew tolerance; idempotency on `resend_event_id` |
| TB-4 | Public unsubscribe page | Server (token handler) | Public internet (recipient + recipient's mail-server agent) | HMAC-SHA256 token verification with `UNSUBSCRIBE_TOKEN_SECRET`; timing-safe comparison; tenant-id-peppered email hash |
| TB-5 | Cron dispatch endpoint | Server (cron handler) | cron-job.org service | `Authorization: Bearer ${CRON_SECRET}` (reused F4/F5) |
| TB-6 | Database (RLS boundary) | Application connection | (potentially) buggy use cases | Postgres RLS + FORCE on every F7 table; `runInTenant(ctx, fn)` injects `app.current_tenant`; cross-tenant integration test (Constitution clause 3 Review-Gate blocker) |
| TB-7 | F3 + F2 cross-module imports | F7 bounded context | (would-be) deep imports | Public barrels + ESLint `no-restricted-imports` rule (Principle III) |

---

## 2. Threats (STRIDE) and Mitigations

### T-01 — Spoofing: Forged webhook event (Resend signing-key compromise scenario)

**Vector**: Attacker obtains Resend's signing key (Resend-side compromise — outside our control) and forges a `payment_intent.succeeded`-equivalent webhook event to mark a broadcast as `sent` without actually dispatching, OR injects a `email.complained` event to trigger another member's auto-halt.

**Likelihood**: LOW (requires Resend infrastructure compromise — SOC 2 Type II attested).
**Impact**: HIGH (could trigger spurious member halts; could mark broadcasts `sent` without delivery).

**Mitigations** (independent layers per Research § Trust Assumptions / CHK072):
1. **Audit forensics**: every webhook event recorded in `broadcast_deliveries` with `resend_event_id` + sha256(payload) — post-incident analysis cross-references against Resend's own dashboard to identify suspicious events.
2. **High-severity alerts**: `broadcast_complaint_rate_per_broadcast_breach`, `broadcast_resend_resource_missing` route to on-call admin who would notice anomalies (e.g., halt event for a broadcast that was never dispatched).
3. **Rotation cadence**: `RESEND_BROADCASTS_WEBHOOK_SECRET` rotates annually + on suspected compromise per `docs/runbooks/credential-compromise.md`.
4. **Defense-in-depth**: timestamp skew tolerance (≤5 min) limits replay window even with valid signature.

**Test**: `tests/integration/broadcasts/webhook-signature.test.ts` — 4 scenarios verify rejection of missing/malformed/tampered signatures.

---

### T-02 — Tampering: HTML sanitiser bypass via member-authored body

**Vector**: Member submits a body with crafted HTML that bypasses DOMPurify's allowlist (e.g., novel XSS payload, mutation XSS, or namespace injection) → recipients receive a malicious email that executes script in their mail client OR exfiltrates data via tracking pixel.

**Likelihood**: MEDIUM (XSS payloads evolve; DOMPurify maintainers regularly patch new vectors but version lag exists).
**Impact**: HIGH (every recipient inbox at risk; chamber sender reputation at risk; data exfiltration via crafted tracking).

**Mitigations**:
1. **Strict allowlist** (FR-002a): only 13 tags allowed; `<img>` explicitly forbidden (Round 1 critique E9/X3 closed the tracking-pixel bypass that admin review was bypass-prone for); URL schemes restricted to `http://`, `https://`, `mailto:`.
2. **Server-side enforcement** (Round 2 R2-NEW-2): sanitiser runs at Application layer; Tiptap client-side filtering is best-effort UX, not the security boundary.
3. **Pre-sanitisation paste-handler** (Round 2 R2-NEW-2): editor surfaces "this will be removed" warnings on paste so members don't accidentally trip the submit-time rejection.
4. **Snapshot determinism**: 30+ payload snapshot tests + fast-check property test on bumps (Round 1 critique E17 + R2 R2-NEW-1).
5. **Admin review gate**: human review catches anything that gets past sanitiser (defense-in-depth, NOT primary defence — admin review is bypass-prone).
6. **Renovate manual-review on `isomorphic-dompurify` bumps** (Round 1 critique E22).

**Test**: `tests/integration/broadcasts/html-sanitiser.test.ts` (30+ payloads) + fast-check property test.

---

### T-03 — Repudiation: Member denies having submitted a broadcast

**Vector**: Member claims "I never submitted that broadcast — must be a system bug or someone else." Without strong attribution, the chamber cannot defend the submission audit.

**Likelihood**: LOW (most members don't dispute; F1 session attribution is solid).
**Impact**: MEDIUM (reputational + dispute resolution cost).

**Mitigations**:
1. **F1 session attribution**: every API request carries the signed F1 session cookie; `submitted_by_user_id` (Q12 dual-actor) records the actual user who clicked Submit.
2. **Audit chain**: `broadcast_submitted` event records `member_id + user_id + actor_role + segment + estimated_count + body_html_sha256` — non-repudiable trail.
3. **Admin-proxy distinction**: when admin submits on behalf of member, `actor_role='admin_proxy'` in the audit event leaves no ambiguity about who acted.

**Test**: `tests/integration/broadcasts/submit-broadcast.test.ts` verifies dual-actor recording.

---

### T-04 — Information Disclosure: Cross-tenant data leak

**Vector**: A `swecham` member or admin attempts to read/modify a `jcc` broadcast, or query `jcc` member emails via the custom-list resolver, or unsubscribe a `jcc` recipient via a forged token.

**Likelihood**: MEDIUM (surface area is large; one buggy use case forgetting `tenantId` could leak).
**Impact**: HIGH (single cross-tenant leak destroys trust with ALL chambers per Constitution Principle I rationale; existential SaaS risk).

**Mitigations** (Constitution v1.4.0 Principle I clauses 1-5 — NON-NEGOTIABLE):
1. **Application layer**: `TenantContext` first-class Domain type (Principle III); every use case takes `TenantContext` as compile-time-required parameter.
2. **Database layer**: Postgres RLS + FORCE on every F7 table; `runInTenant(ctx, fn)` sets `app.current_tenant` per connection.
3. **Cross-feature joins** (Round 1 critique E18): custom-list validation (`FR-015d`) joins F7 against F3 `members` + `contacts` — tenant isolation MUST hold across the join.
4. **Mandatory cross-tenant integration test** (clause 3, Review-Gate blocker): `tests/integration/broadcasts/tenant-isolation.test.ts` verifies zero cross-tenant visibility on every F7 aggregate.
5. **Token tenant-pepper** (Round 1 critique E7 / CHK024): unsubscribe token email-hash is `sha256(tenant_id + ':' + email_lower)` — defends cross-tenant rainbow-table attack.
6. **404-not-403 on cross-tenant probes** (FR-037): avoid leaking existence; emit `broadcast_cross_tenant_probe` audit at high severity.

**Test**: cross-tenant integration test + `tests/integration/broadcasts/custom-recipient-validation.test.ts` cross-feature scenario + `tests/integration/broadcasts/unsubscribe-token.test.ts` cross-tenant token rejection.

---

### T-05 — Information Disclosure: Custom-list validation tenant-graph enumeration

**Vector**: Compromised member account submits `custom` segment containing many candidate emails → response distinguishes "in tenant graph" from "not in tenant graph" → attacker enumerates tenant member directory.

**Likelihood**: LOW (requires compromised account + custom-list submission).
**Impact**: MEDIUM (tenant directory information disclosure — but not a credential leak).

**Mitigations**:
1. **Rate limit** (FR-002 precondition `d`): 10 submissions/24h per member — caps enumeration speed at ~10×100 = 1,000 lookups/day per compromised account.
2. **Admin review gate**: admin sees the submission + can detect enumeration patterns (e.g., 100 sequentially-ordered email guesses).
3. **Audit alert**: high-frequency `broadcast_custom_recipient_unknown` events from same member could trigger alert (post-MVP detection rule — flagged for F7.x ops).
4. **Round 1 critique E8 mitigation** (deferred): change FR-015d to return only count of unresolved (no list); client-side validates and shows entries to submitter only. Status: NOT yet integrated — defensible because admin review is the additional gate; revisit in F7.1 if real abuse detected.

**Test**: `tests/integration/broadcasts/custom-recipient-validation.test.ts` covers happy path; rate-limit test inherits F1 pattern.

---

### T-06 — Information Disclosure: Token URL leakage in logs / proxies

**Vector**: Unsubscribe token URLs appear in mail-server logs, ISP caches, Vercel platform-layer access logs. An attacker with access to those logs can replay tokens to unsubscribe other recipients OR brute-force valid tokens.

**Likelihood**: LOW (requires log access).
**Impact**: LOW (token replay is idempotent; brute-force is rate-limited; max harm is "another recipient unsubscribed against their will" — annoying, recoverable via support).

**Mitigations**:
1. **HMAC token format** (FR-029): cryptographically-signed tokens cannot be brute-forced computationally feasibly without the secret.
2. **Vercel platform-layer redaction verification** (Round 1 critique E11 / CHK048): `/speckit.tasks` Phase 0 task to configure log-drain redaction for `/unsubscribe/v1\..*` URL pattern.
3. **Quarterly secret rotation fallback** (CHK048): if Vercel platform redaction is unavailable, rotate `UNSUBSCRIBE_TOKEN_SECRET` quarterly to bound breach window — known UX trade-off (rotates invalidate outstanding tokens; coordinate with member communication per `credential-compromise.md` runbook).
4. **Rate limit** on `/unsubscribe/[token]`: 20 hits / 5 min per IP — defends brute-force.
5. **Audit alert**: high-frequency `broadcast_unsubscribe_token_invalid` events trigger possible-enumeration alert (Plan § VII alert #3).

**Test**: `tests/integration/broadcasts/unsubscribe-token.test.ts` covers happy + tampered + rate-limit scenarios.

---

### T-07 — Denial of Service: Recipient-list cap exhaustion

**Vector**: Member submits broadcast with `all_members` segment + tenant has scaled to 5,000+ members → resolver hits cap → submission rejected. Or: malicious member spams 10 submissions/day with maximum 5,000-recipient broadcasts to exhaust Resend account quota.

**Likelihood**: MEDIUM at SaaS scale; LOW at SweCham scale.
**Impact**: MEDIUM (Resend quota exhaustion blocks all broadcasts platform-wide; suppression list bloat).

**Mitigations**:
1. **Hard cap 5,000 per broadcast** (FR-016a / Q7): enforced at submit + dispatch boundaries.
2. **Rate limit 10 submissions/24h per member** (FR-002 precondition `d`): caps single-member abuse at ~50,000 recipients/day max.
3. **Auto-halt on >5% complaint** (FR-002 precondition `k` / Q14): malicious member's first bad broadcast triggers halt; their pipeline stops within minutes.
4. **Admin queue gate**: every broadcast requires admin approval pre-dispatch — provides ~24h safety window to detect abuse.
5. **Resend account quota monitoring**: post-MVP ops dashboard monitors monthly Resend usage; quota approach triggers alert (gap — flagged for F7.x).

**Test**: `tests/integration/broadcasts/audience-cap.test.ts` covers >5000 rejection.

---

### T-08 — Denial of Service: Broadcast halt-bypass via member state changes

**Vector**: Member is halted (`broadcasts_halted_until_admin_review = true`) due to high complaint rate. Member tries to bypass: archive their account → reactivate → flag preserved per Round 3 R3-NEW-3, OR change primary contact email → flag preserved, OR plan-downgrade-then-upgrade → flag preserved.

**Likelihood**: LOW (requires admin to be tricked into reactivating without clearing halt).
**Impact**: MEDIUM (continued bad-actor broadcasts if halt bypassed).

**Mitigations**:
1. **Halt-flag lifecycle** (Round 3 R3-NEW-3 + spec § Edge Cases): flag preserved across all 6 member-state-change scenarios except Art. 17 erasure (which deletes the member entirely).
2. **Admin-only clear** (FR-014): manager + member cannot clear halt; admin clear emits `broadcast_member_dispatch_resumed` audit so reactivation events are visible.
3. **Typed-phrase confirmation** for clear-halt action: matches F4 destructive-action convention; admin must explicitly type member name to confirm.

**Test**: cross-cutting test in `tests/integration/broadcasts/halt-flag-precondition.test.ts` (covers FR-002 precondition `k` rejection); F3 + F7 alignment test for member state changes is `/speckit.tasks` discovery task per privacy CHK047.

---

### T-09 — Elevation of Privilege: Manager attempts admin action

**Vector**: User with `manager` role attempts to approve / reject / cancel / proxy-submit / clear-halt via direct API call (UI hides the buttons but API authz is the security boundary).

**Likelihood**: LOW (manager role typically held by trusted board members).
**Impact**: HIGH (manager could approve broadcasts unreviewed; clear halts inappropriately).

**Mitigations**:
1. **Server-side RBAC** (FR-014): every mutating endpoint checks `admin` role; 403 + audit on direct API attempt.
2. **No client-side trust**: UI button hiding is UX-only; API is the security boundary.
3. **Audit traceability**: every attempt + outcome recorded with actor + role.

**Test**: `tests/contract/broadcasts/post-admin-broadcasts-*.contract.test.ts` includes manager-403 scenarios.

---

### T-10 — Elevation of Privilege: Admin proxy abuse — admin sends as member without member knowledge

**Vector**: Admin proxies submission for a member (Q12) without member's consent or knowledge. Member is later confused by "their" broadcasts they never authored.

**Likelihood**: LOW (requires admin to act without operational courtesy; chamber admin team is small + accountable).
**Impact**: MEDIUM (member trust erosion; potential reputational issue if proxied content is off-tone).

**Mitigations**:
1. **Dual-actor audit** (Q12 / FR-005): every proxy submission records BOTH `requested_by_member_id` AND `submitted_by_user_id` — admin cannot hide their own involvement.
2. **Member portal visibility**: proxied broadcasts appear in member's own portal history; member can see + cancel before send (state ∈ submitted/approved per FR-004a).
3. **Audit alert**: high-frequency proxy submissions for same member could be flagged for chamber-board review (post-MVP detection rule — flagged for F7.x ops).
4. **Member notification email** (US1 AS9 + plan § Reliability): admin proxy submission still sends the standard "your broadcast was submitted/approved" notification to the member.

**Test**: `tests/e2e/broadcast-compose-and-submit.spec.ts` AS9 covers admin-proxy with dual-actor audit verification.

---

### T-11 — Cryptographic / Secret Compromise: Local secret leak via repo or CI

**Vector**: Developer accidentally commits `RESEND_BROADCASTS_API_KEY` or `UNSUBSCRIBE_TOKEN_SECRET` to git, or CI logs leak the secret.

**Likelihood**: LOW (CLAUDE.md secrets convention + CI lint rule + Vercel env-var-only commitment).
**Impact**: HIGH (Resend account hijack; mass unsubscribe replay; reputational).

**Mitigations**:
1. **Vercel env vars only** (CLAUDE.md Secrets section): never `.env` in git.
2. **CI lint rule**: blocks common mistakes (secret patterns in source files).
3. **Git-history scan**: `gitleaks` or equivalent in CI per F1 pattern.
4. **`src/lib/env.ts` zod validation at boot**: fails fast if env var missing/malformed (catches "I forgot to add it to staging" but not pre-emptively prevents commit).
5. **Rotation runbook** (`credential-compromise.md` per CHK041): documented zero-downtime rotation procedure for every secret; "rotate immediately + audit window" response on any suspected leak.

**Test**: CI lint rule + `pnpm audit` blocking + gitleaks pre-commit hook.

---

## 3. F1+F4+F5 Threats Inherited (NOT re-enumerated)

These threats are documented in F1's `specs/001-auth-rbac/security.md` and apply transitively to F7 because F7 builds on F1's auth + session + RBAC + audit + RLS infrastructure:

- T-F1-01 Credential stuffing → F1 mitigates
- T-F1-02 Brute-force password → F1 mitigates
- T-F1-03 Session fixation / hijack → F1 mitigates (HSTS + secure cookies)
- T-F1-04 CSRF on state-changing endpoints → F1 mitigates (Origin allow-list per `middleware.ts`); F7 inherits — Round 1 critique E10 noted contracts/broadcasts-api.md should cross-reference; deferred to /speckit.tasks task
- T-F1-05 Password-reset token replay → not applicable to F7 (no password reset surface)
- T-F1-06 Audit log tampering → F1 mitigates (append-only audit_log table + per-row hash chain if F1 implements; F7 audit events inherit)
- T-F1-07 through T-F1-16 → see F1 security.md

---

## 4. Security Checklist Mapping

This threat model is the source of truth for `checklists/security.md`. Mapping:

| Threat | Checklist items |
|--------|-----------------|
| T-01 (forged webhook) | CHK015-020 (webhook signature) + CHK072 (Resend signing-key compromise assumption) |
| T-02 (sanitiser bypass) | CHK007-014 (HTML sanitisation) |
| T-03 (member repudiation) | CHK001-006 (RBAC) + CHK050 (audit hashing) |
| T-04 (cross-tenant leak) | CHK023 (token pepper) + CHK028-032 (tenant isolation) + CHK029 (cross-tenant integration test) |
| T-05 (custom-list enumeration) | CHK034-036 (input validation) + CHK037 (rate limits) |
| T-06 (token URL leakage) | CHK022 (timing-safe) + CHK026 (Vercel redaction) + CHK027 (rate limit) |
| T-07 (DoS recipient-list) | CHK034 (size cap) + CHK037 (rate limits) + CHK051 (kill switch) |
| T-08 (halt-bypass) | CHK054-057 (halt-flag) |
| T-09 (manager privilege) | CHK001-006 (RBAC enumeration) |
| T-10 (admin proxy abuse) | CHK005 (admin-proxy authz) + CHK050 (audit hashing) |
| T-11 (secret leak) | CHK039-043 (secrets handling) |

---

## 5. Sign-off (per Constitution Principle IX)

**This threat model + security.md checklist + privacy.md checklist co-sign requirement**:

F7 is a **security-sensitive feature** (⚠ PII + ⚠ Marketing-consent + Constitution Principle I NON-NEGOTIABLE tenant isolation). Per Principle IX: **≥2 reviewers, one signs the security checklist**.

Solo-maintainer substitute (per Principle IX v1.3.0 + this F7 plan § Complexity Tracking):
- Multiple `/speckit.review` passes (≥3 with decreasing severity)
- `/speckit.staff-review` round (correctness + security + tests agents)
- `pdpa-gdpr-compliance-officer` agent pass (privacy.md co-sign)
- `security-threat-modeler` agent pass (this document + security.md co-sign)
- DB-level + Application-level + sanitiser defence-in-depth verified
- Post-remediation `/speckit.verify` pass

**Sign-off mechanism**:

```
Threat Model Reviewed: ___________________________ (reviewer name + date)
Security Checklist Co-signed: _____________________ (reviewer name + date)
Privacy Checklist Co-signed: ______________________ (reviewer name + date)
Solo-maintainer substitute applied: [ ] yes [ ] no    (if yes, agent reports linked)
```

---

## 6. References

- F1 threat model: `specs/001-auth-rbac/security.md` (16-threat baseline)
- F4 + F5 threat models: respective `specs/*/security.md` (inherited)
- Critique reports: `specs/010-email-broadcast/critiques/*.md` (4 rounds with findings cross-referenced)
- Constitution v1.4.0: `.specify/memory/constitution.md` Principle I + IV + IX
- OWASP Top 10 (2021): `https://owasp.org/Top10/`
- Resend security: `https://resend.com/security` + Svix webhook signing scheme
