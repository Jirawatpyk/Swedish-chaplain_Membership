# Runbook — `broadcasts_webhook_attack`

**Owner**: Platform on-call (escalate to chamber DPO if PDPA §37 awareness opened)
**Severity**: page (PDPA-relevant abuse signal — same severity tier as F5 webhook signature rejection)
**Source signal**: `broadcasts.webhook_signature_rejected_total` counter (≥ 5 / 5 min triggers page) · sustained `broadcast_webhook_signature_rejected` audit emit at high rate
**Audit events**: `broadcast_webhook_signature_rejected` (Status: SPEC, emit lands Phase 3+ T160 / webhook handler)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites land Phase 3+ (T160 webhook handler); operational triage assumes the route + audit emission exist.

---

## Symptom

The Resend Broadcasts webhook endpoint at `POST /api/webhooks/resend-broadcasts` is returning 401 with body `webhook_signature_rejected` at elevated rate. Resend Dashboard → Webhooks shows failing deliveries with red status. App logs contain `broadcasts.webhook.signature.rejected` entries (no payload, no `Svix-Signature` value — both redacted per `docs/observability.md § 22 redact list`).

## Why this matters

The webhook signature is the only authentication boundary between Resend and Chamber-OS for broadcast delivery events. A signature-rejection could be:

1. **Misconfiguration** (most common): wrong `RESEND_BROADCASTS_WEBHOOK_SECRET` env var after a key rotation or env pull.
2. **Resend account or Broadcasts product re-issued the signing secret** (rare; Resend support would coordinate, but mistakes happen).
3. **Tampering / abuse attempt**: a third party POSTing forged events to our webhook URL. Sustained signal here is a **PDPA-relevant abuse canary**.

We MUST never process an event with a rejected signature — the route handler enforces this pre-parse (raw-body access required + Node runtime pinned).

The mid-tier severity is identical to F5's webhook attack — both involve recipient PII (delivery / bounce / complaint events tied to email addresses).

---

## Triage steps (in order)

1. **Verify the alert source**.
   - Vercel Logs → filter on `broadcasts.webhook` traces → check `broadcasts.webhook_signature_rejected_total` counter spike correlates with the alert.
   - Compare against `broadcasts.webhook_receive_total` (total deliveries). 100% rejection rate with no successful deliveries → misconfig (step 2). Small rejection rate alongside successful deliveries → abuse / scanner traffic (step 4).

2. **Check `RESEND_BROADCASTS_WEBHOOK_SECRET` env var** (most common cause).
   - `vercel env ls` — confirm `RESEND_BROADCASTS_WEBHOOK_SECRET` is set in the failing environment (production / preview / dev).
   - Compare against Resend Dashboard → Webhooks → click endpoint → reveal "Signing secret" → matches?
   - If mismatched: `vercel env rm RESEND_BROADCASTS_WEBHOOK_SECRET <env>` then `vercel env add RESEND_BROADCASTS_WEBHOOK_SECRET <env>` with the correct value, then redeploy.

3. **Check Resend Broadcasts product configuration**.
   - Resend Dashboard → Broadcasts → Webhooks → endpoint URL must be `https://swecham.zyncdata.app/api/webhooks/resend-broadcasts`.
   - If URL has been changed or webhook deleted → re-add + paste the signing secret into Vercel env.

4. **Audit-log forensic check** (for abuse signal).
   ```sql
   SELECT count(*) AS attempts, date_trunc('hour', "timestamp") AS hour
     FROM audit_log
    WHERE event_type='broadcast_webhook_signature_rejected'
      AND "timestamp" > now() - interval '1 hour'
    GROUP BY 2
    ORDER BY 2 DESC;
   ```
   - If the source IP / User-Agent pattern looks scanner-like (rapid burst, no Svix headers) → block at Vercel WAF or escalate to security review.
   - All `broadcast_webhook_signature_rejected` rows are 5y retention (forensic).

5. **Rollback if recently deployed**.
   - If the alert started immediately after a deploy that touched `src/app/api/webhooks/resend-broadcasts/route.ts` or `src/modules/broadcasts/infrastructure/resend/resend-webhook-verifier.ts` (Phase 3+) → roll back via `vercel rollback <previous-deployment-url>` immediately.

---

## Escalation

- **No matching env var fix** + **no recent deploy** + **abuse signal pattern** → flag in security log; consider rotating `RESEND_BROADCASTS_WEBHOOK_SECRET` (Resend Dashboard → Webhooks → "Roll signing secret") + update Vercel env in same window. Engage chamber DPO if abuse patterns suggest targeted attack.
- **Persistent rejection after secret rotation** → open Resend support ticket; attach a sample rejected event id from audit log.
- **Concurrent signal across F1 transactional webhook** (`webhook_signature_rejected` from F1) AND F7 webhook → suggests Resend platform-wide signature scheme issue; engage Resend support + chamber DPO simultaneously.

---

## Recovery

After fix is deployed:

1. Resend Dashboard → Webhooks → click endpoint → "Resend events" for the failed deliveries (Resend retains them for 30 days).
2. Watch `broadcasts.webhook_receive_total` recover and `broadcasts.webhook_signature_rejected_total` flatten.
3. Verify no broadcast state was missed: query stuck-`sending` per [broadcasts-stuck-sending.md](./broadcasts-stuck-sending.md).
4. Reconcile via T161 cron (Phase 3+) within 24h SLA.

---

## Prevention

- Documented as part of pre-deploy checklist: "Confirm `RESEND_BROADCASTS_*` env vars are not committed (gitleaks scan green)".
- Vercel env-var changes for `RESEND_BROADCASTS_WEBHOOK_SECRET` always require a redeploy — call out in deploy PR description.
- Annual webhook-security review per Spec Kit `/speckit.review` security checklist.
- Webhook handler runtime pinned to Node.js (raw-body access for HMAC-SHA256 verification — Edge runtime mangles raw bodies across framework versions).
