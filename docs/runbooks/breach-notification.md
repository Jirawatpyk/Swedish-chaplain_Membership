# Runbook — Breach Notification (PDPA §37 + GDPR Art. 33)

**Owner**: Chamber DPO + chamber legal-counsel (escalate to platform on-call for technical containment)
**Severity**: critical (regulatory clock — 24h PDPA, 72h GDPR)
**Source signal**: SECURITY EVENT — manual escalation triggered by detection of unauthorised data access, exfiltration, deletion, or alteration affecting member PII
**Audit events**: ANY `*_cross_tenant_probe` event ≥ threshold rate · `webhook_signature_rejected` sustained spike · unexplained `marketing_unsubscribes` deletion attempts · F1 `password_reset_failed` mass rate
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding — cross-cutting F1+F4+F5+F7)
**Status**: SPEC — cross-cutting playbook references emit sites across all F-stack features. F7-specific signals land Phase 3+ (T036+).

---

## Symptom

A reportable data breach is suspected or confirmed. Possible triggers:

- **Cross-tenant data leak**: a member of tenant A views/edits/deletes data belonging to tenant B (RLS bypass — should be impossible per Constitution v1.4.0 Principle I clause 3, but the cross-tenant probe audit events catch attempted leaks).
- **Credential compromise**: F1 admin or member account credentials leaked or guessed (sustained `password_reset_failed` from same IP without throttling, OR external party reports having credentials).
- **Recipient list exfiltration**: F7 broadcast `custom` segment includes members of OTHER tenants (FR-015d validation should prevent this — escalate if observed).
- **Unauthorised audit-log mutation**: append-only triggers should make this impossible; investigate if observed.
- **Webhook signature compromise**: sustained `webhook_signature_rejected` from non-Stripe / non-Resend IPs suggests probing.

## Why this matters

**Regulatory clocks** (NON-NEGOTIABLE):

- **PDPA §37**: notify Office of the Personal Data Protection Committee (PDPC) within **24 hours** of awareness if breach risks rights/freedoms of data subjects. Materially affected data subjects MUST also be notified without undue delay.
- **GDPR Art. 33**: notify supervisory authority within **72 hours** of awareness for EU data subjects (Swedish/EU members in SweCham per Constitution Hosting deviation).
- **GDPR Art. 34**: data subjects must be notified directly when breach is "likely to result in a high risk".

Failure to notify within these windows triggers regulatory fines + reputational damage. The clock starts at `awareness`, NOT confirmation — err on the side of opening the clock early.

---

## Triage steps (in order)

1. **CONTAINMENT FIRST** — don't investigate yet, stop the bleed.
   - Suspected RLS bypass or app-layer auth bypass: set `READ_ONLY_MODE=true` in Vercel env (3-line redeploy; CLAUDE.md § Emergency write freeze) — blocks all state-changing routes globally; sign-in + reads remain alive.
   - Suspected F7-specific issue: flip `FEATURE_F7_BROADCASTS=false` to halt all marketing dispatch + new submissions.
   - Suspected F1 credential compromise: revoke all sessions for affected user(s) via `DELETE FROM sessions WHERE user_id = $compromised;` + force password reset.

2. **Open the regulatory clock** — call DPO + legal-counsel within 1h of first signal. Document:
   - Time of awareness (UTC + local TH/SE timezones).
   - Nature of suspected breach (cross-tenant / credential / list / audit / other).
   - Initial scope estimate (number of data subjects affected, rough categories of personal data).
   - Containment actions taken.

3. **Forensic preservation**.
   - Snapshot relevant audit_log rows BEFORE any cleanup: `pg_dump --table audit_log --where "emitted_at > $window_start" > /tmp/breach-audit-$timestamp.sql`.
   - Capture Vercel access logs + Sentry traces for the relevant time window (Vercel Logs export is 7-day retention max — pull within 24h of awareness).
   - Capture Neon query logs (separate retention from app logs).

4. **Scope determination** (run AFTER containment + within 4h):
   - Cross-tenant probe attempts: `SELECT * FROM audit_log WHERE event_type LIKE '%cross_tenant_probe' AND emitted_at > $window_start;` — verify NONE succeeded (RLS denial returns 0 rows; probe audit fires regardless).
   - Credential compromise: `SELECT user_id, count(*) FROM audit_log WHERE event_type IN ('password_reset_failed', 'sign_in_failed') AND emitted_at > $window_start GROUP BY user_id ORDER BY count DESC;`
   - F7 list exposure: `SELECT broadcast_id, custom_recipient_emails FROM broadcasts WHERE tenant_id = $tenant AND segment_type = 'custom' AND submitted_at > $window_start;` — cross-check each email against tenant member graph.

5. **Notification drafting** (DPO-led).
   - Use PDPC + EU supervisory authority breach-notification templates (chamber legal-counsel maintains).
   - Required elements per GDPR Art. 33(3): nature of breach, categories + approximate number of data subjects, contact point, likely consequences, measures taken or proposed.
   - PDPA §37 has similar requirements + a PDPC-published form.

---

## Escalation

- **Confirmed breach with identified data subjects** → DPO notifies PDPC + EU supervisory authority within respective windows; chamber legal-counsel drafts data-subject notifications per Art. 34 if risk level warrants.
- **Suspected but unconfirmed** → still open the clock + investigate; document the `awareness time` for legal record.
- **Credential compromise affects super-admin role** → engage chamber legal-counsel + immediately rotate ALL secrets (see [credential-compromise.md](./credential-compromise.md)).

---

## Recovery

After regulatory notification submitted + technical containment in place:

1. Root-cause analysis → file P0 issue + retrospective in `specs/<feature>/retrospective.md`.
2. Patch deployment → standard Spec Kit gate flow (`/speckit.plan` → `/speckit.implement` → `/speckit.verify`).
3. Re-enable disabled features (`READ_ONLY_MODE=false`, `FEATURE_F7_BROADCASTS=true`) ONLY after RCA + fix shipped + 24h soak window.
4. Document in chamber-of-commerce annual data-protection report (PDPA §37 mandates record of breach + actions taken even when notification was not required).

---

## Prevention

- Quarterly RLS coverage test review (`tests/integration/rls-coverage.test.ts` covers all F-stack tenant-scoped tables; T021 added 4 F7 tables).
- Cross-tenant integration tests are Review-Gate blockers (Constitution v1.4.0 Principle I clause 3) — every F-stack feature ships one.
- Audit-log append-only triggers prevent forensic-evidence tampering at the DB layer.
- Secret rotation policy: quarterly minimum + immediate on personnel change (see [credential-compromise.md](./credential-compromise.md)).
- Annual tabletop breach-response drill with chamber DPO + legal-counsel.
