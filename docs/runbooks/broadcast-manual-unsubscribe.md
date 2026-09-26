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

**Who does what** — the script needs production database credentials, which the office does not hold:

| Step | Owner | Deadline |
|---|---|---|
| Log the request, acknowledge receipt | Chamber office (backup: DPO) | Same business day |
| Hand the ticket to platform on-call | Chamber office | By the next business day |
| Apply the removal (steps 2–3) | Platform on-call (backup: second on-call) | Within 2 business days of receipt |
| Confirm to the person, close the ticket | Chamber office | Within 2 business days of receipt |

A weekly check of open privacy tickets (office + DPO) catches anything stuck. Keep privacy tickets for the same period as the objection evidence they support (at least as long as the ticket system's standard retention; the `marketing_unsubscribes` row and its audit events are the durable record).

1. **Log the request** in the office ticket system on the day it arrives (ticket ref, date received, the address). Do not ask the person to justify the objection or to log in — an objection to marketing needs no reason (GDPR Art. 21(3)).
2. **Dry run** against production (read-only; shows current status):
   ```bash
   TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
     scripts/manual-unsubscribe.ts --email=person@example.com \
     --operator=you@swecham.com --ticket=PRIV-123
   ```
   If it prints `ALREADY opted out`, skip to step 4.
3. **Apply** — same command plus `--confirm`. `--ticket` must be a reference (e.g. `PRIV-123`) and `--operator` a staff email or id — never paste the requester's message or address there; both are stored in audit rows. This writes the `marketing_unsubscribes` row (reason `recipient_initiated`) and both audit events with `channel: 'manual'`, `operator`, and the ticket in `reason_text`. **Never** hand-INSERT the row: a raw INSERT writes no audit.
4. **Reply** to the person confirming removal (no charge, effective for all E-Blasts from the tenant; service emails such as invoices, receipts, renewal reminders and password resets continue). Close the ticket within **2 business days** of receipt.
5. If the person asks to be **re-subscribed** later, that is a new, explicit request — raise it with the DPO; do not delete suppression rows ad hoc. There is no audited re-subscribe tool yet (follow-up: a DPO-approved `--resubscribe` mode that writes its own audit event).

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

### Opt-outs Resend cannot attribute to a broadcast

`cleanup-audiences` deletes each broadcast's Resend audience about an hour after send, so a later click can arrive with an audience/segment id no broadcast owns — or with none. Those opt-outs are still recorded, under this deployment's tenant with no source broadcast (log `broadcasts.webhook.resend_hosted_unsubscribe_mirrored` with `attributed: false`). Only an unusable address is not recorded: it leaves a NULL-tenant audit row `broadcast_webhook_signature_rejected` / `reason: 'contact_updated_invalid_email'` (address stored only as a tenant-scoped hash) — find the contact in the Resend dashboard and apply it with **§ 1** (`--ticket=resend-invalid-<date>`).

**Verify once** (and after Resend API changes): click the unsubscribe link in an E-Blast **older than one hour** (its audience already reaped), then check § 2's SQL shows the row, and note the `contact.updated` payload Resend actually sent (Resend dashboard → Webhooks → event) in this runbook.

## 3. Verify List-Unsubscribe on a real broadcast (after any Resend/template change)

1. Send a test E-Blast to an internal Gmail address.
2. Gmail → ⋮ → *Show original*: confirm `List-Unsubscribe:` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` are present (Resend-generated) and that Gmail shows the *Unsubscribe* affordance next to the sender.
3. Click it and confirm § 2's SQL shows the row (`channel: resend_hosted`).

## 4. Rate-limit behaviour (for support questions)

- A recipient who clicks many links quickly from one network may see **"Please try again shortly"** (20 requests / 5 min per IP on the GET page). It reveals nothing about the link; nothing was recorded; retrying later works.
- One-click POSTs are never throttled for a valid token; only repeated **invalid** tokens from one IP get `429`.
