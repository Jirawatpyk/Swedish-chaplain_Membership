# Runbook — Credential Compromise (Cross-cutting F1+F4+F5+F7)

**Owner**: Platform on-call (escalate to chamber DPO if any data subject impact)
**Severity**: critical (potential unauthorised access to all chamber data)
**Source signal**: external party reports having credentials · F1 mass `password_reset_failed` from same IP · GitHub gitleaks hit · Vercel env-var leaked in deploy log · Stripe/Resend dashboard shows API key in unexpected location
**Audit events**: F1 `password_reset_failed`, `sign_in_failed`, `session_invalidated`; F5 `webhook_signature_rejected`; F7 `broadcast_webhook_signature_rejected`
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding — cross-cutting F1+F4+F5+F7)
**Status**: SPEC — secret-rotation procedure stable; runbook codifies the playbook for all secrets in use.

---

## Symptom

A secret used by Chamber-OS is suspected or confirmed to be compromised. Possible categories:

1. **F1 user credentials** (admin/manager/member account password): leaked database, password-reuse harvest, phishing.
2. **F1 cookie-signing secret** (`AUTH_COOKIE_SIGNING_SECRET`): committed to git accidentally, leaked in deploy log.
3. **F4 `BLOB_READ_WRITE_TOKEN`**: Vercel Blob token allowing PDF read/write.
4. **F4/F5/F7 `CRON_SECRET`**: shared bearer token for cron-job.org external triggers.
5. **F5 Stripe keys**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` (the last one is browser-public; not a secret but tracked here for completeness).
6. **F1+F4+F7 Resend keys**: `RESEND_API_KEY` (transactional), `RESEND_BROADCASTS_API_KEY` (Broadcasts API), `RESEND_WEBHOOK_SIGNING_SECRET`, `RESEND_BROADCASTS_WEBHOOK_SECRET`.
7. **F7 `UNSUBSCRIBE_TOKEN_SECRET`**: HMAC secret for one-click unsubscribe tokens.
8. **F7 Tenant DB role credentials** (`chamber_app`): RLS-bypass-impossible role; compromise could still allow tenant-scoped CRUD.

## Why this matters

A compromised secret may grant an attacker read/write access to:

- All session cookies (cookie-signing secret).
- All PDF documents in F4 (Blob token).
- Ability to forge cron-driven dispatches (CRON_SECRET).
- Ability to issue/refund payments on behalf of the chamber (Stripe key).
- Ability to send marketing emails as the chamber (Resend keys — domain-reputation-poisoning vector).
- Ability to forge unsubscribe tokens for arbitrary recipients (`UNSUBSCRIBE_TOKEN_SECRET` — would let attacker mass-unsubscribe legitimate recipients).

This is a **breach** under PDPA §37 + GDPR Art. 33 if any data subject's data was accessed. See [breach-notification.md](./breach-notification.md) for the regulatory-clock playbook.

---

## Triage steps (in order)

1. **CONTAINMENT** — rotate the secret IMMEDIATELY before any investigation (don't wait for forensics; minutes matter).
   - **F1 user credentials**: invalidate all sessions for the user (`DELETE FROM sessions WHERE user_id = $compromised;`) + force password reset on next sign-in (`UPDATE users SET requires_password_reset = true WHERE id = $compromised;`).
   - **F1 cookie-signing secret**: rotate `AUTH_COOKIE_SIGNING_SECRET` via `vercel env add` + redeploy. ALL sessions invalidated globally.
   - **CRON_SECRET**: see "Secret rotation procedure" below + update cron-job.org headers.
   - **Stripe keys**: rotate via Stripe Dashboard → Developers → API keys → "Roll" + update Vercel env + redeploy.
   - **Resend keys**: rotate via Resend Dashboard → API Keys → revoke + create new + update Vercel env + redeploy.
   - **UNSUBSCRIBE_TOKEN_SECRET**: rotate via `openssl rand -base64 48` + `vercel env add` + redeploy. **Existing unsubscribe links are invalidated** — recipients clicking old links get 401. Per `docs/runbooks/cron-jobs.md` § Secret rotation, this is acceptable since recipients clicking an old link can re-unsubscribe via Resend's native unsubscribe footer or by replying to a future broadcast.
   - **chamber_app DB role**: rotate via Neon Console → Roles → reset password + update Vercel `DATABASE_URL` env + redeploy.

2. **Verify the rotation took effect**.
   - For F1 cookie-signing rotation: try to use a pre-rotation cookie → should return 401.
   - For Stripe/Resend rotation: trigger a test event (Stripe CLI `stripe trigger payment_intent.succeeded` for F5; Resend Dashboard "Resend test event" for F1+F7).
   - For DB role rotation: `psql $DATABASE_URL -c "SELECT current_user;"` → confirms new credentials work.

3. **Open the regulatory clock** if any data subject impact is plausible. Cross-cutting [breach-notification.md](./breach-notification.md).

4. **Forensic preservation**.
   - Snapshot Vercel access logs + Stripe/Resend delivery logs for the suspected exposure window.
   - Snapshot audit_log: `SELECT * FROM audit_log WHERE "timestamp" > $window_start ORDER BY "timestamp" DESC;`.
   - Identify timestamp of secret first exposure (e.g., git-commit time for accidental commit, deploy-log timestamp for leaked deploy log).

5. **Scope determination**.
   - For each compromised secret, enumerate what an attacker could have done with it:
     - F4 Blob token → could have downloaded any tenant's PDF documents (10y retention!) — query `audit_log WHERE event_type = 'invoice_pdf_resent' OR event_type LIKE 'pdf_*' AND "timestamp" BETWEEN $exposure_start AND $rotation`.
     - Stripe key → could have created refunds, paid fictitious invoices. Cross-check Stripe Dashboard against `payments` + `refunds` tables.
     - Resend keys → could have sent emails impersonating the chamber. Cross-check Resend Dashboard sent log against `broadcasts` (F7) + F1 transactional outbox.
     - Etc.

---

## Secret rotation procedure (zero-downtime where possible)

For non-DB secrets:

1. Generate the new secret value (provider-specific or `openssl rand -base64 48` for HMAC secrets).
2. Add to Vercel env across all envs that need it: `vercel env add <KEY> <env>`.
3. Redeploy production: `vercel --prod` or trigger from CI.
4. Verify new value is in effect (step 2 of triage above).
5. **Old value remains accepted briefly** for some secrets (e.g., Stripe — both old + new keys work for 24h after rotation by default). Use this window to update any out-of-band references (cron-job.org headers, monitoring tools).
6. After all references updated + soak window passed, the old value can be considered fully retired.

For F1 cookie-signing secret rotation:
- Old sessions are NOT preserved across rotation — every signed-in user is logged out. Communicate proactively if rotation is planned (NOT applicable in compromise scenario; rotate immediately + accept the user impact).

For DB role rotation:
- Generate new password via Neon Console (don't use psql `ALTER USER` — Neon has a managed role lifecycle).
- Update `DATABASE_URL` + `DATABASE_URL_UNPOOLED` Vercel env.
- Redeploy. Vercel briefly serves with old + new connections in flight; expect ~30s elevated 5xx rate during deploy.

---

## Escalation

- **Active exploitation observed** (e.g., audit_log shows successful access from IP outside normal range during exposure window) → engage chamber DPO + legal-counsel immediately + open PDPA §37 / GDPR Art. 33 clock.
- **Multiple secrets compromised in same incident** → assume widespread compromise; rotate ALL secrets (full re-issuance per [stripe-best-practices.md](#) checklist if applicable) + force-reset all admin sessions.
- **Suspected supply-chain compromise** (deps changed without commit, lockfile diverged) → engage platform engineer + roll back to last known clean commit + open security review.

---

## Recovery

After rotation + RCA:

1. Document the incident in chamber-of-commerce data-protection log.
2. Update [breach-notification.md](./breach-notification.md) checklist if regulatory notification was triggered.
3. Re-attest SAQ-A for F5 (Stripe) per `specs/009-online-payment/saq-a-attestation.md` if Stripe key was rotated.
4. Schedule post-mortem within 7 days: identify root cause, document remediation, update Spec Kit checklists.
5. Verify no residual sessions / API keys remain valid: spot-check by attempting old credentials on each surface.

---

## Prevention

- gitleaks scan in CI (blocks commits with `re_*`, `sk_*`, `whsec_*`, `eyJ*` token shapes).
- Vercel env vars are the ONLY production source — `.env.local` is gitignored.
- Quarterly secret rotation calendar (recurring scheduled task — chamber DPO calendar).
- Review Vercel deploy logs weekly for secret leakage in build output.
- 1Password vault for secret distribution (no email/Slack/screenshot of secrets).
