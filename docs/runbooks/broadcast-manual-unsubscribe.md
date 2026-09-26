# Runbook — E-Blast opt-outs: manual removals, Resend mirror, one-click checks

**Owner**: Chamber office / DPO inbox (manual removals) · Platform on-call (mirror + header checks)
**Lawful basis**: E-Blasts rely on **legitimate interest** (GDPR Art. 6(1)(f) / PDPA §24(5)), not consent. Objections must be honoured, **free** and **easy** (GDPR Art. 21(2)-(3), Art. 12(2)-(3); PDPA §32).
**Scope of an opt-out**: **tenant + email** — one row in `marketing_unsubscribes` stops every E-Blast from that tenant to that address, including E-Blasts sent on behalf of other members.
**Audit events**: `broadcast_unsubscribed` + `broadcast_suppression_applied` (both carry `payload.channel`) · `broadcast_unsubscribe_token_invalid` · `broadcast_webhook_signature_rejected` with `reason: 'unknown_resend_audience_id'`
**Last reviewed**: 2026-09-26

---

## How opt-outs reach `marketing_unsubscribes`

Every path goes through the same `unsubscribeRecipient` use-case, so the row and the two audit events are identical. Only `payload.channel` differs:

| Channel | Where the recipient objected | Entry point |
|---|---|---|
| `resend_hosted` | Resend's hosted unsubscribe page (the link in every E-Blast footer, `{{{RESEND_UNSUBSCRIBE_URL}}}`), or the one-click **List-Unsubscribe** button Resend adds to every broadcast | Resend `contact.updated {unsubscribed:true}` → `/api/webhooks/resend-broadcasts` → `applyResendHostedUnsubscribe` |
| `page_get` | Our signed link `/unsubscribe/<token>` (GET) | `src/app/unsubscribe/[token]/page.tsx` |
| `one_click_post` | RFC 8058 POST to `/unsubscribe/<token>` | proxy rewrite → `src/app/api/unsubscribe/[token]/route.ts` |
| `manual` | Emailed the privacy inbox (`TENANT_PRIVACY_CONTACT_EMAIL`) | `scripts/manual-unsubscribe.ts` (this runbook) |

> Resend's Broadcasts API cannot carry our own `List-Unsubscribe` header (no `headers` field), so today's E-Blasts carry **Resend's** headers; our signed header + POST route are ready for a per-recipient send path.

---

## 1. Manual removal (recipient emailed the privacy inbox)

The unsubscribe page promises: *"email us at <privacy inbox> and we will remove this address from all {tenant} E-Blasts within **2 business days**. This is free of charge."*

1. **Log the request** in the office ticket system on the day it arrives (ticket ref, date received, the address). Do not ask the person to justify the objection or to log in — an objection to marketing needs no reason (GDPR Art. 21(3)).
2. **Dry run** against production (read-only; shows current status):
   ```bash
   TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
     scripts/manual-unsubscribe.ts --email=person@example.com \
     --operator=you@swecham.com --ticket=PRIV-123
   ```
   If it prints `ALREADY opted out`, skip to step 4.
3. **Apply** — same command plus `--confirm`. This writes the `marketing_unsubscribes` row (reason `recipient_initiated`) and both audit events with `channel: 'manual'`, `operator`, and the ticket in `reason_text`. **Never** hand-INSERT the row: a raw INSERT writes no audit.
4. **Reply** to the person confirming removal (no charge, effective for all E-Blasts from the tenant; service emails such as invoices, receipts, renewal reminders and password resets continue). Close the ticket within **2 business days** of receipt.
5. If the person asks to be **re-subscribed** later, that is a new, explicit request — raise it with the DPO; do not delete suppression rows ad hoc.

## 2. Resend `contact.updated` must be enabled (one-time, and after any webhook change)

Opt-outs on Resend's hosted page and via Resend's List-Unsubscribe header only flip the Resend contact. Without the `contact.updated` event they never reach `marketing_unsubscribes`, and because every E-Blast builds a **fresh** Resend audience, the next E-Blast would reach the person again.

1. Resend dashboard → Webhooks → the broadcasts endpoint (`/api/webhooks/resend-broadcasts`) → events: make sure **`contact.updated`** is selected alongside the `email.*` events.
2. Verify: unsubscribe a test address via the footer link of a test broadcast, then
   ```sql
   SELECT reason, source_broadcast_id, unsubscribed_at
     FROM marketing_unsubscribes
    WHERE tenant_id = 'swecham' AND email_lower = '<test address>';
   ```
   and check an audit row `broadcast_unsubscribed` with `payload->>'channel' = 'resend_hosted'`.

### Unattributed Resend opt-outs

A `contact.updated` whose audience matches no broadcast (e.g. an audience created outside the app) is acknowledged and logged as `broadcasts.webhook.resend_hosted_unsubscribe_unattributed`, with a NULL-tenant audit row `broadcast_webhook_signature_rejected` / `reason: 'unknown_resend_audience_id'` (address stored only as `emailHash`). The recipient still objected: find the address in the Resend dashboard (contact marked unsubscribed) and apply it with **§ 1** (`--ticket=resend-unattributed-<date>`).

## 3. Verify List-Unsubscribe on a real broadcast (after any Resend/template change)

1. Send a test E-Blast to an internal Gmail address.
2. Gmail → ⋮ → *Show original*: confirm `List-Unsubscribe:` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` are present (Resend-generated) and that Gmail shows the *Unsubscribe* affordance next to the sender.
3. Click it and confirm § 2's SQL shows the row (`channel: resend_hosted`).

## 4. Rate-limit behaviour (for support questions)

- A recipient who clicks many links quickly from one network may see **"Please try again shortly"** (20 requests / 5 min per IP on the GET page). It reveals nothing about the link; nothing was recorded; retrying later works.
- One-click POSTs are never throttled for a valid token; only repeated **invalid** tokens from one IP get `429`.
