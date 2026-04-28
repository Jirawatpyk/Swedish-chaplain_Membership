# Runbook — `webhook_signature_rejected`

**Owner**: Solo-maintainer (escalate to Stripe support if persistent)
**Severity**: alarm (PCI-relevant abuse / misconfiguration canary)
**Source signal**: `webhook.signature_rejected_total` counter (≥ 1 / 5 min triggers alert)
**Audit event**: `webhook_signature_rejected` (retention 10y)
**Last reviewed**: 2026-04-28 (staff-review R2 R004)

---

## Symptom

Stripe webhook deliveries to `POST /api/webhooks/stripe` are returning **400** with body `webhook_signature_rejected`. Stripe Dashboard → Developers → Webhooks shows failing deliveries with red status. Application logs contain `stripe-webhook.signature.rejected` entries (no payload, no `Stripe-Signature` value — both redacted).

## Why this matters

The webhook signature is the only authentication boundary between Stripe and Chamber-OS. A signature-rejection could be:

1. **Misconfiguration** (most common): wrong `STRIPE_WEBHOOK_SECRET` env var after a key rotation or env pull.
2. **Stripe API version mismatch** triggering a different signature scheme (Stripe rotates signatures rarely but a major version cut can shift).
3. **Tampering / abuse attempt**: a third party POSTing forged events to our webhook URL. Any sustained signal here is a **PCI-relevant abuse canary**.

We MUST never process an event with a rejected signature — the route handler enforces this pre-parse.

---

## Triage steps (in order)

1. **Verify the alert source**.
   - Vercel Logs → filter on `payments.webhook` traces → check `webhook.signature_rejected_total` counter spike correlates with the alert.
   - Compare the rate against `webhook.receive.count` (total deliveries). A 100% rejection rate with no successful deliveries → misconfig (step 2). A small rejection rate with successful deliveries → abuse / scanner traffic (step 4).

2. **Check `STRIPE_WEBHOOK_SECRET` env var** (most common cause).
   - `vercel env ls` — confirm `STRIPE_WEBHOOK_SECRET` is set in the failing environment (production / preview / dev as relevant).
   - Compare against Stripe Dashboard → Developers → Webhooks → click endpoint → reveal "Signing secret" → matches?
   - If mismatched: `vercel env rm STRIPE_WEBHOOK_SECRET <env>` then `vercel env add STRIPE_WEBHOOK_SECRET <env>` with the correct value, then redeploy.

3. **Check `STRIPE_API_VERSION` env var**.
   - Compare against Stripe Dashboard → Developers → Workbench → API version.
   - If they differ AND `webhook_api_version_mismatch_total` is also alerting → see `api-version-mismatch.md` runbook.

4. **Audit-log forensic check** (for abuse signal).
   - `SELECT event_type, count(*), date_trunc('hour', emitted_at) FROM audit_log WHERE event_type='webhook_signature_rejected' AND emitted_at > now() - interval '1 hour' GROUP BY 1, 3 ORDER BY 3 DESC;`
   - If the source IP / User-Agent pattern looks scanner-like (rapid burst, no Stripe-User-Agent header), block at Vercel WAF or escalate to security review.
   - All `webhook_signature_rejected` rows are 10y retention (forensic).

5. **Rollback if recently deployed**.
   - If the alert started immediately after a deploy that touched `src/app/api/webhooks/stripe/route.ts` or `src/modules/payments/infrastructure/stripe-webhook-verifier.ts` — `vercel rollback <previous-deployment-url>` immediately.

---

## Escalation

- **No matching env var fix** + **no recent deploy** + **abuse signal pattern** → flag in security log, consider rotating `STRIPE_WEBHOOK_SECRET` (Stripe Dashboard → Webhooks → "Roll signing secret") and updating Vercel env in the same window to minimise downtime.
- **Persistent rejection after secret rotation** → open Stripe support ticket, attach a sample rejected event ID from the audit log.

---

## Recovery

After fix is deployed:

1. Stripe Dashboard → Webhooks → click endpoint → "Resend events" for the failed deliveries (Stripe retains them for 30 days).
2. Watch `webhook.receive.count` recover and `webhook.signature_rejected_total` flatten.
3. Verify no payment state was missed: `SELECT id, status FROM payments WHERE status='pending' AND initiated_at < now() - interval '1 hour' AND tenant_id = ?;` — any row here may need manual reconciliation against Stripe Dashboard.

---

## Prevention

- Documented as part of the SAQ-A re-attestation pre-deploy checklist (`specs/009-online-payment/saq-a-attestation.md` § 4): "Confirm `STRIPE_*` env vars are not committed (gitleaks scan green)".
- Vercel env-var changes for `STRIPE_WEBHOOK_SECRET` always require a redeploy — call this out in the deploy PR description.
