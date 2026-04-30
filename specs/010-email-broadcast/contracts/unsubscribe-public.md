# F7 — Public Unsubscribe Route Contract

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Phase 1 Design

This document specifies the contract for the public unauthenticated unsubscribe surface used by every broadcast email recipient. The route is GDPR Article 21 + PDPA §24 + ePrivacy compliant: one-click, no-login, single-page, idempotent, server-rendered, locale-aware.

---

## 1. Endpoint

```
GET /unsubscribe/[token]
Runtime: Node.js (server-rendered HTML; no JS dependency for completion)
Authz: Signed token only (no session cookie; no CSRF check needed because the action is recipient-side)
```

Why GET and not POST: most email clients pre-fetch links for malware scanning; we need the click action to be safe-on-pre-fetch. Idempotency via `marketing_unsubscribes` upsert ensures pre-fetch + actual-click both produce the same outcome (one upsert, no duplicate audit event).

---

## 2. Token format (FR-029 + research.md § 4)

```
v1.<urlSafeBase64Json>.<urlSafeBase64HMAC>
```

Where:

```ts
const TokenPayload = z.object({
  v: z.literal(1),                            // version
  tid: z.string(),                            // tenant id
  bid: z.string().uuid(),                     // broadcast id
  eml: z.string().regex(/^[a-f0-9]{64}$/),    // sha256(tenant_id + ':' + email_lower)
                                              // — peppered with tenant_id per Round 1 critique E7 + privacy
                                              //   checklist CHK024 to defend cross-tenant rainbow-table attacks.
                                              //   The peppered hash is unique per (tenant, email) pair so the
                                              //   same recipient in two tenants produces different `eml` values.
  iat: z.number().int().positive(),           // issued-at unix seconds (informational only — no expiry)
});
```

Encoding:

```
urlSafeBase64Json = base64url(JSON.stringify(payload))
urlSafeBase64HMAC = base64url(hmacSha256(env.unsubscribeTokenSecret, urlSafeBase64Json))
finalToken = `v1.${urlSafeBase64Json}.${urlSafeBase64HMAC}`
```

Verification uses `crypto.timingSafeEqual` per F1 pattern. The token has **no expiry** — GDPR Art. 21 right-to-object must be honoured indefinitely.

---

## 3. URL embedding

Every broadcast email footer contains:

```html
<p style="font-size: 11px; color: #888;">
  You are receiving this email because you are a contact at a member of {{TenantDisplayName}}.
  <a href="https://{{tenantHost}}/unsubscribe/{{token}}?lang={{recipientLocale}}">Unsubscribe</a>
  from these broadcasts at any time.
</p>
```

The `lang` query param is signed-into the token (prevents tampering from changing locale to e.g. inject text via locale fallback) but presented separately for ease of construction. The route accepts the `lang` parameter as a hint but always re-validates against the token's locale field.

(Locale-aware footer — translated EN/TH/SV; the ARIA-described unsubscribe button is also locale-aware.)

---

## 4. Route handler

```ts
// src/app/unsubscribe/[token]/page.tsx (Node.js runtime; server-rendered)
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { token } = await params;
  const { lang } = await searchParams;

  // 1. Verify token (timing-safe HMAC)
  const verifyResult = await unsubscribeTokenPort.verify(token);
  if (!verifyResult.ok) {
    await audit.emit('broadcast_unsubscribe_token_invalid', {
      failureReason: verifyResult.error.code,
      sourceIp: headers().get('x-forwarded-for'),
    });
    return <UnsubscribeFallbackPage locale={lang ?? 'en'} />; // bilingual error page with support email
  }

  const { tenantId, broadcastId, emailHash } = verifyResult.value;

  // 2. Resolve recipient email from broadcast_deliveries by hash + tenant + broadcast
  // (the email itself is in our own DB; the token only carries the hash for privacy)
  const recipientEmail = await runInTenant(TenantContext.fromTenantId(tenantId), (tx) =>
    broadcastDeliveriesRepo.findRecipientByEmailHash(tx, broadcastId, emailHash)
  );

  if (!recipientEmail) {
    // Hash didn't match any known delivery — token tampered or referencing a deleted delivery row
    await audit.emit('broadcast_unsubscribe_token_invalid', { failureReason: 'recipient_not_found', sourceIp });
    return <UnsubscribeFallbackPage locale={lang ?? 'en'} />;
  }

  // 3. Upsert into marketing_unsubscribes (idempotent on (tenant_id, email_lower))
  const ctx = TenantContext.fromTenantId(tenantId);
  const result = await runInTenant(ctx, (tx) =>
    unsubscribeRecipientUseCase.execute(tx, {
      tenantId,
      emailLower: recipientEmail,
      sourceBroadcastId: broadcastId,
      sourceTokenHash: sha256(token),
      reason: 'recipient_initiated',
      reasonText: null, // Phase 2: optional feedback box can populate this
    })
  );

  // 4. Render confirmation
  return <UnsubscribeConfirmationPage
    locale={lang ?? 'en'}
    tenantDisplayName={resolved.tenantDisplayName}
    isFirstUnsubscribe={result.value.isFirstUnsubscribe}
  />;
}
```

The use case is idempotent: replaying the same token returns the same confirmation page with `isFirstUnsubscribe=false` so the UI shows "You are already unsubscribed" instead of "Unsubscribed successfully".

---

## 5. Use case `unsubscribe-recipient.ts`

```ts
async function unsubscribeRecipient(ctx: TenantContext, input: UnsubscribeInput): Promise<Result<UnsubscribeResult, UnsubscribeError>> {
  return runInTenant(ctx, async (tx) => {
    // Resolve member id by email (best-effort)
    const memberId = await membersBridge.lookupMemberByEmail(ctx, input.emailLower);

    // Idempotent upsert
    const existing = await marketingUnsubscribesRepo.findByEmail(tx, input.tenantId, input.emailLower);
    if (existing) {
      // Already unsubscribed — no-op, return same shape
      return Result.ok({
        isFirstUnsubscribe: false,
        unsubscribedAt: existing.unsubscribedAt,
      });
    }

    await marketingUnsubscribesRepo.insert(tx, {
      tenantId: input.tenantId,
      emailLower: input.emailLower,
      memberId,
      reason: input.reason,
      reasonText: input.reasonText,
      sourceBroadcastId: input.sourceBroadcastId,
      sourceTokenHash: input.sourceTokenHash,
    });

    await audit.emit('broadcast_unsubscribed', {
      broadcastId: input.sourceBroadcastId,
      emailHash: sha256(input.emailLower),
      memberId,
      sourceTokenHash: input.sourceTokenHash,
    });

    return Result.ok({
      isFirstUnsubscribe: true,
      unsubscribedAt: new Date(),
    });
  });
}
```

---

## 6. Render shapes

### 6.1 Success (first unsubscribe)

Page text (TH primary for SweCham; EN + SV from `messages/`):

> **Unsubscribed**
>
> You have been unsubscribed from {{TenantDisplayName}} marketing broadcasts. You will no longer receive E-Blasts.
>
> You will continue to receive transactional emails (password resets, invoice receipts, renewal reminders) related to your account, if any.
>
> If you unsubscribed by mistake, please contact {{TenantSupportEmail}}.

Visual: minimal centred card; tenant logo; no chrome (no nav bar, no footer beyond the support email link).

### 6.2 Already unsubscribed

> **Already unsubscribed**
>
> Your email is already on our suppression list for {{TenantDisplayName}}. No further action needed.
>
> If you would like to receive broadcasts again, please contact {{TenantSupportEmail}}.

### 6.3 Token invalid / expired

> **Link is invalid**
>
> This unsubscribe link could not be verified. It may have been tampered with, or it may belong to a different tenant.
>
> Please contact {{TenantSupportEmail}} to be removed from broadcasts.

(Note: "expired" wording is used for backward compatibility with members who paste a hand-edited URL; in practice the token has no expiry. The actual failure reason in the audit log distinguishes the cases.)

---

## 7. Locale resolution

In priority order:

1. **Token's `lang` field** (signed) — the broadcast email was rendered in this locale, so we honour it.
2. **`?lang=` query param** — for hand-shared links, fall back to query.
3. **`Accept-Language` header** — best-effort.
4. **Tenant default locale** (e.g., SweCham defaults to `th`).
5. **`en`** as final fallback.

The chosen locale is exposed to next-intl via the route's server-component `locale` prop.

---

## 8. Accessibility

- The page is fully keyboard-navigable (single CTA, focus on contact-support mailto link).
- WCAG 2.1 AA contrast on the confirmation card (axe-core scan in `tests/e2e/recipient-unsubscribe.spec.ts`).
- `prefers-reduced-motion` honoured (the success-checkmark icon is animated only with `motion-safe:`).
- Semantic HTML — `<main>`, `<h1>`, `<p>` — no ARIA needed for this static surface.
- No JS required to read or use the page (the unsubscribe action happens server-side at request time; the page renders the result directly).

---

## 9. Rate limit + bot protection

Per plan.md § Storage: `GET /unsubscribe/[token]` is rate-limited to **20 hits / 5 min per source IP** to prevent token-brute-force enumeration. Legitimate clicks rarely hit the limit.

Pre-fetch protection: many corporate email clients (Outlook, Gmail with image-proxy mode) pre-fetch links to scan for malware. The handler is idempotent so pre-fetch + actual-click produce the same outcome. The audit log records every successful unsubscribe; if the recipient never explicitly clicks but their email client pre-fetched, the recipient is still unsubscribed — this is **acceptable per ePrivacy guidance** (the recipient's mail-server agent acts on their behalf for safety scanning).

---

## 10. Audit emission

Per request:

- **Success**: `broadcast_unsubscribed` (with broadcast_id + email_hash + member_id + source_token_hash) — emitted only on first unsubscribe (replays do NOT re-audit per FR-031 idempotency).
- **Token invalid**: `broadcast_unsubscribe_token_invalid` (with failure_reason + source_ip) — emitted on every invalid attempt, no de-dupe.

No raw email + no raw token in audit payloads.

---

## 11. Smoke test (Phase 5 verification)

A simple cURL flow:

```bash
# 1. Generate a valid token (in Node REPL or test fixture)
TOKEN=$(node -e "console.log(require('./src/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer').sign({tid:'swecham',bid:'<broadcast-uuid>',eml:'<sha256>'}))")

# 2. First click — successful unsubscribe
curl -i "https://swecham.zyncdata.app/unsubscribe/$TOKEN?lang=en"
# Expect 200 + HTML containing "Unsubscribed"

# 3. Second click — idempotent
curl -i "https://swecham.zyncdata.app/unsubscribe/$TOKEN?lang=en"
# Expect 200 + HTML containing "Already unsubscribed"

# 4. Tampered token
curl -i "https://swecham.zyncdata.app/unsubscribe/${TOKEN}xxx?lang=en"
# Expect 200 + HTML containing "Link is invalid"
# Audit log shows broadcast_unsubscribe_token_invalid
```
