# F7 Email Broadcast — Phase 0 Research

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Complete

This document resolves the open questions enumerated in `plan.md` § Phase 0. Each section follows the **Decision / Rationale / Alternatives Considered** format. Source links and citations are inline.

---

## 1. Resend Broadcasts API surface

### Decision

F7 uses the Resend SDK's **Broadcasts** product surface (distinct from the Transactional product F1+F4 already use). Specifically:

- **`audiences.create({ name })`** — one fresh audience per broadcast in MVP (revisit in F7.1 for persistent-per-segment optimisation).
- **`audiences.contacts.create({ audienceId, email, firstName?, lastName?, unsubscribed? })`** — bulk-add resolved recipients (we batch via Promise.all with Resend's per-call 100ms throttle; no Bulk endpoint yet at time of writing).
- **`broadcasts.create({ audienceId, from, replyTo, subject, html, name })`** — create the broadcast resource on Resend.
- **`broadcasts.send({ id, scheduledAt? })`** — dispatch (immediate or scheduled — though F7 uses our own cron + immediate-send-only on the Resend side because Resend's `scheduledAt` lacks the per-tenant timezone awareness we need; see § 6).
- **Webhook events ingested**: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`. Not used in MVP: `email.opened`, `email.clicked` (privacy-OFF default per Clarifications Q5 / Assumptions).
- **Signature scheme**: Resend uses **Svix** for webhook signing (HMAC-SHA256 over `webhookId.timestamp.body`). The Resend SDK exposes `webhooks.unwrap(payload, signature, secret)` (since SDK v5.0). Webhook secret comes from the Resend dashboard per environment (test vs live).

### Rationale

- **Same Resend account, separate API products** — `RESEND_API_KEY` (F1+F4 transactional) MAY be the same key as `RESEND_BROADCASTS_API_KEY` (F7) per Resend's documentation; both products are exposed on a single account. F7 plan still uses a separate env var name to allow independent rotation (rotating broadcasts key does not invalidate transactional sessions, and vice versa).
- **Separate suppression lists** — Resend maintains independent suppression for transactional and broadcasts. F7's `marketing_unsubscribes` is the canonical source for our application-side filter (FR-017); Resend's audience-level unsubscribe flag is the secondary defence (we set `unsubscribed: true` on the contact-add call when the email is in our local suppression list — defence in depth).
- **Fresh audience per broadcast (MVP)** — simplest mental model, no cleanup task, audience contents are a frozen snapshot of the dispatch-time recipient list (matches FR-016 dispatch-time-list-is-source-of-truth invariant). Persistent-per-segment audience (F7.1 optimisation) reduces Resend API call volume but introduces sync drift between our suppression list and the Resend audience over time. MVP-grade volume (~ 8 broadcasts/week) does not justify the sync complexity.
- **Free-tier broadcast quota** — Resend free tier: 3,000 broadcast recipients/month + 100 audiences. SweCham scale is ~131 recipients × ~8 broadcasts/week × 4 weeks = ~ 4,200 recipients/month — slightly over free tier. Pro tier ($20/month) brings 100,000 recipients/month and is well within the F11 SaaS-billing per-tenant cost envelope. **MVP runs on Pro tier** ($20/month for SweCham; F11 will pass-through the cost).
- **Webhook signing via Svix** — Resend chose Svix (a popular webhook-as-a-service) for its broadcast event delivery. The signature header is `svix-signature` (multi-line `v1,...`) and the SDK helper handles the parsing + timing-safe verification. We MUST NOT roll our own verifier (timing-attack risk).

### Trust Assumptions (Security checklist CHK072)

The Resend integration carries two non-trivial trust assumptions that the F7 threat model must explicitly acknowledge:

1. **Resend's webhook signing-key remains uncompromised**: F7's webhook signature verification is the sole authN for `/api/webhooks/resend-broadcasts`. If an attacker obtains Resend's signing key (Resend-side compromise — outside our control), they can forge events that pass our verification. **Mitigations** (each independent): (a) every webhook event is recorded in `processor_events` with the raw event id + sha256(payload) — post-incident forensics can identify suspicious events by timestamp + content anomaly cross-referenced against Resend's own dashboard, (b) high-severity audit events (`broadcast_webhook_signature_rejected`, `broadcast_complaint_rate_per_broadcast_breach`, `broadcast_resend_resource_missing`) are alerted to on-call admin who would notice forged-event-driven anomalies (e.g., a `broadcast_sent` event for a broadcast we never dispatched), (c) Resend publishes signing-key rotation events; we subscribe to their security advisory channel and rotate `RESEND_BROADCASTS_WEBHOOK_SECRET` immediately on advisory. **Acceptance**: Resend (Svix-backed) is a SOC 2 Type II attested provider with documented operational security; the residual trust is bounded + auditable. Same trust model as F1+F4+F5 already accept for Resend transactional + Stripe webhook signing.
2. **Resend's API key authentication remains uncompromised**: similar trust assumption for the dispatch path. Mitigations: per-feature secret separation (F7's `RESEND_BROADCASTS_API_KEY` is conceptually distinct from F1's `RESEND_API_KEY` even when Resend permits both products on one key — separate env-var enables independent rotation per `credential-compromise.md` runbook), audit log of every Resend API call with idempotency-key (allows retroactive identification of unauthorized calls), and Resend's own per-account audit log accessible via dashboard.

These assumptions are inherent to using a third-party email service; the alternative (self-built SMTP per Constitution Principle X review) would replace Resend trust with our own operational-security trust at much higher cost. The trade-off is accepted with the mitigations above.

### Alternatives Considered

- **Mailchimp Marketing API** — rejected per `docs/email-broadcast-analysis.md` § 3 (vendor sprawl, cost, no benefit at scale).
- **Brevo (Sendinblue) Campaigns API** — same as above.
- **Self-built SMTP fan-out** — rejected per Constitution Principle X; would require building suppression, deliverability, sender-warmup, SPF/DKIM/DMARC, feedback-loop handlers from scratch.
- **Persistent-per-segment audiences (F7.1)** — deferred. Adds sync complexity for marginal API-call reduction at MVP scale.

---

## 2. Tiptap editor configuration

### Decision

Tiptap with the **starter-kit** extension package only, configured to emit HTML matching the FR-002a allowlist exactly. Specifically:

- **Extensions enabled**: `Document`, `Paragraph`, `Text`, `Bold`, `Italic`, `Underline`, `Heading` (levels 1-4 only — `levels: [1, 2, 3, 4]`), `BulletList`, `OrderedList`, `ListItem`, `Blockquote`, `HardBreak`, `HorizontalRule`, `Link` (with `protocols: ['http', 'https', 'mailto']`, `linkOnPaste: true`, `openOnClick: false`).
- **Extensions explicitly disabled** (would emit tags outside the FR-002a allowlist): `CodeBlock`, `Code` (inline), `Strike`, **`Image`** (Critique 2026-04-29 R2-NEW-1 — disabled to match the FR-002a `<img>` forbidden rule applied in Round 1; the "Insert image" toolbar button is omitted; members link to externally hosted images via the `Link` extension instead). `History` (undo/redo) is enabled — does not affect output HTML.
- **SSR-safety**: Tiptap is client-only — we use `next/dynamic` with `ssr: false` to defer the entire ~80KB chunk until the member opens `/portal/broadcasts/new`.
- **Theme integration**: Tiptap is headless — styling is via Tailwind classes on a wrapper. We use `prose prose-sm dark:prose-invert` from `@tailwindcss/typography` for the editor content area, matching the email-preview styling exactly so what-you-see-is-what-you-send.
- **Output format**: `editor.getHTML()` produces the string that goes into the FR-002a sanitiser. The sanitiser is the security boundary; Tiptap's own output filtering is best-effort UX.
- **Toolbar**: minimal — Bold, Italic, Underline, Heading dropdown (H1–H4), Bullet list, Ordered list, Blockquote, Link, Hr. **No image-upload button + no paste-image** in MVP — `<img>` is forbidden by FR-002a (R2-NEW-1; attachments + image embedding with mandatory source allowlist return in F7.1).

### Rationale

- **Tiptap starter-kit covers FR-002a 1:1** — every allowlisted tag has a matching Tiptap extension; every forbidden tag has no extension to emit it. This minimises the gap between editor output and sanitiser-accepted output, which improves UX (members rarely see their content stripped).
- **`next/dynamic` ssr:false** — Tiptap uses `useEffect` for editor mounting + DOM manipulation. SSR rendering Tiptap is documented as buggy (hydration mismatches). Lazy-loading also keeps the benefits dashboard light (members who don't open the editor never download Tiptap).
- **Dark mode** — Tiptap is headless so the editor inherits whatever Tailwind classes we put on the wrapper. `prose-invert` from `@tailwindcss/typography` already exists in the design system.
- **No collaborative editing** — explicitly out of scope; the @tiptap/extension-collaboration extension is NOT installed.

### Alternatives Considered

- **Lexical (Meta)** — modern but smaller community + less mature docs at time of writing. Tiptap's React bindings are more polished.
- **BlockNote** — Notion-style block editor; UX overkill for a marketing email surface where members write 200-500 words of mostly-flat HTML.
- **Quill** — legacy ecosystem; less Tailwind-friendly.
- **Plain `<textarea>` + markdown-it** — UX regression; chamber admins are not engineers and would not write markdown. Rejected.
- **MJML / Unlayer drag-and-drop builders** — explicitly out of MVP scope per spec.

---

## 3. DOMPurify allowlist (FR-002a)

### Decision

`isomorphic-dompurify@^2` configured with the following exact allowlist matching FR-002a:

```ts
// Critique 2026-04-29 E9/X3: removed 'img' from ALLOWED_TAGS + 'src'/'alt' from ALLOWED_ATTR
// to close the tracking-pixel privacy bypass. Members link to images via <a href="..."> instead.
// Image embedding with mandatory source allowlist enforcement is F7.1 scope.
const SANITIZER_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u',
    'a',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4',
    'blockquote',
    'hr',
  ],
  ALLOWED_ATTR: ['href', 'title', 'data-broadcast-id', 'data-tenant-id'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'link', 'meta', 'base', 'object', 'embed', 'svg', 'img'],
  FORBID_ATTR: ['style'], // also strips all on* via DOMPurify default
  KEEP_CONTENT: true, // strip forbidden tags but preserve their text content (e.g., <script>X</script> → X removed entirely; <b>X</b> → X kept)
  RETURN_TRUSTED_TYPE: false,
  USE_PROFILES: { html: true },
};
```

The sanitiser runs at the **Application layer** — `sanitize-html.ts` use-case wraps `HtmlSanitizerPort.sanitize(input)` and returns the cleaned string. The Application layer also computes `sanitised === input` to detect whether the diff is empty (FR-002 precondition `g` requires zero forbidden constructs to pass — i.e., the editor output should already be clean if Tiptap is configured correctly, but the sanitiser is the security boundary).

### Rationale

- **DOMPurify is the industry standard** — battle-tested, regularly audited, used by Google + Microsoft + GitHub. Industry consensus on safe HTML for untrusted input.
- **Allowlist exactly matches FR-002a** — no surprises; what the spec promised is what the sanitiser enforces.
- **`KEEP_CONTENT: true`** — when a forbidden tag appears, its text content is preserved (e.g., `<b>hello</b>` becomes `hello`); but DOMPurify defaults strip the entire `<script>` element including content (correct — we don't want script payloads as plaintext).
- **Deterministic output** — DOMPurify with a fixed config is deterministic; our `sanitize-html.test.ts` snapshot-tests 30+ payloads to enforce this.
- **`isomorphic-dompurify`** — wraps DOMPurify for both Node (uses `jsdom`) and browser. We use it in Application (Node) only; Tiptap is client-only.
- **`ALLOWED_URI_REGEXP`** — DOMPurify default rejects `javascript:` and `data:` URLs; the explicit regex pins the safe scheme set to `http`, `https`, `mailto`. Covers FR-002a's URL-scheme rule.

### Alternatives Considered

- **`sanitize-html`** — less actively maintained; smaller security audit footprint.
- **`xss`** — heavier API surface; configured similarly but with less mind-share.
- **Hand-rolled regex stripping** — actively dangerous (impossible to enumerate XSS vectors). Rejected outright.
- **Server-side HTML parser + manual tree walk** — re-implements DOMPurify; pointless reinvention.

---

## 4. Unsubscribe token signing-secret naming

### Decision

**Use a dedicated `UNSUBSCRIBE_TOKEN_SECRET` env var** (not reuse `AUTH_COOKIE_SIGNING_SECRET`).

Token format (HMAC-SHA256):

```
v1.<urlSafeBase64Json>.<urlSafeBase64HMAC>

where:
  urlSafeBase64Json = base64url(JSON.stringify({
    tid: tenantId,
    bid: broadcastId,
    eml: tenantPepperedEmailHash, // sha256(tenant_id + ':' + email_lower) — pepper with tenant_id
                                  //   defends cross-tenant rainbow-table attack (Critique Round 1 E7 / privacy
                                  //   checklist CHK024). The tenant_id pepper makes the email-hash unique per
                                  //   tenant, so the same recipient address in tenant A and tenant B has
                                  //   different `eml` values across tokens.
    iat: issuedAtUnixSeconds,     // for audit; not used as expiry
  }))
  urlSafeBase64HMAC = base64url(hmacSha256(secret, urlSafeBase64Json))
```

Verification uses `crypto.timingSafeEqual` per F1 pattern.

### Rationale

- **Independent rotation** — rotating `AUTH_COOKIE_SIGNING_SECRET` invalidates every signed session cookie (forces all members to re-sign-in). If we reused it for unsubscribe tokens, it would also invalidate every outstanding unsubscribe link in members' inboxes (potentially years old). GDPR Article 21 says "right to object" must be honoured indefinitely — an invalid unsubscribe link is a regulatory finding.
- **Compromise containment** — leak of one secret should not compromise the other.
- **Different lifetimes** — session secrets rotate quarterly per F1; unsubscribe tokens MUST be valid forever (no expiry per FR-030 idempotency requirement).
- **`emailLowerSha256` not raw email in the token** — privacy: the token URL appears in headers, server logs, ISP caches, mail-server spam scanners. Hashing the email prevents bulk-extraction of the recipient list from token URLs. The actual email is recovered at verification time via the `(tenant_id, broadcast_id)` → `broadcast_deliveries(recipient_email_lower)` lookup, then a sha256 comparison confirms the token belongs to that recipient.

### Alternatives Considered

- **Reuse `AUTH_COOKIE_SIGNING_SECRET`** — rejected per the rotation argument above.
- **JWT with `exp`** — token expiry breaks FR-030 idempotency; rejected.
- **Random opaque token persisted in a `unsubscribe_tokens` table** — adds a stateful lookup at every unsubscribe; unnecessary state for a stateless HMAC scheme.
- **Encrypted token (AES-GCM) instead of HMAC** — HMAC suffices for an unsubscribe token because the payload is not secret (tenant id + broadcast id + email hash are all derivable from the broadcast). HMAC is simpler to implement correctly.

---

## 5. Quota-year boundary handling for Asia/Bangkok

### Decision

Reuse F4's `@js-joda/core@^6` + `@js-joda/timezone@^2` (already a project dep). The `currentQuotaYear(tenantTz: string, atUtc: Instant): number` helper:

```ts
import { LocalDate, ZonedDateTime, ZoneId, Instant } from '@js-joda/core';
import '@js-joda/timezone';

export function currentQuotaYear(tenantTz: string, atUtc: Instant = Instant.now()): number {
  return atUtc.atZone(ZoneId.of(tenantTz)).year();
}

export function quotaYearStartUtc(tenantTz: string, year: number): Instant {
  return LocalDate.of(year, 1, 1).atStartOfDay(ZoneId.of(tenantTz)).toInstant();
}

export function quotaYearEndUtc(tenantTz: string, year: number): Instant {
  return LocalDate.of(year + 1, 1, 1).atStartOfDay(ZoneId.of(tenantTz)).toInstant().minus(1, ChronoUnit.MILLIS);
}
```

For SweCham, `tenantTz = 'Asia/Bangkok'`. For future tenants, `tenantTz` comes from `tenants.timezone` column (already populated via F4 fiscal-year setup; F7 reuses).

### Rationale

- **`@js-joda` already a project dep** — no new code to install. Same library handles F4's fiscal-year boundary (Asia/Bangkok midnight → UTC 17:00 prior day) so the quota-year boundary is handled by the same primitives.
- **`atZone(...).year()` is the canonical pattern** — given a UTC instant + IANA timezone, `atZone` produces a `ZonedDateTime` from which `.year()` returns the calendar year in that timezone. No off-by-one risk on year boundaries.
- **Boundary edge case** (FR-007): a broadcast submitted on 2026-12-31 23:59 Bangkok, approved at 2027-01-01 00:01 Bangkok, sent at 2027-01-01 00:02 Bangkok. The `quota_year_consumed` is computed at the `sending → sent` transition timestamp via `currentQuotaYear(tenantTz, sentAtUtc)` which returns 2027. The compose-screen warning ("If your broadcast is approved after midnight, it will consume your 2027 quota") fires when `currentQuotaYear(tenantTz, now) !== currentQuotaYear(tenantTz, now + 24h)`.

### Alternatives Considered

- **Native `Intl.DateTimeFormat`** — works but lacks the explicit ZonedDateTime type that prevents instant-vs-zoned mistakes (the same bug class F4 was already burned by — see F4 retrospective).
- **Luxon** — would require adding a new dep; `@js-joda` already does the job.
- **Hand-rolled UTC offset math** — actively dangerous (DST, leap seconds, historical timezone changes).

---

## 6. Cron dispatch idempotency pattern

### Decision

The cron handler uses `SELECT … FOR UPDATE SKIP LOCKED` plus a per-`(tenant_id, broadcast_id)` `pg_advisory_xact_lock` to ensure exactly-once dispatch even when multiple cron worker invocations overlap:

```sql
BEGIN;
-- Lock namespace 'broadcasts:' is disjoint from F4 'invoicing:' and F5 'payments:'.
SELECT pg_advisory_xact_lock(
  hashtextextended('broadcasts:' || tenant_id || ':' || broadcast_id::text, 0)
)
FROM broadcasts
WHERE tenant_id = $1 AND broadcast_id = $2;

-- Recheck state under lock — another worker may have transitioned us first.
SELECT status FROM broadcasts
WHERE tenant_id = $1 AND broadcast_id = $2
FOR UPDATE;
-- if status != 'approved', return early (no-op for this worker)

-- Dispatch to Resend OUTSIDE the tx (network call) with stable idempotency-key `broadcast-{tenantId}-{broadcastId}`
-- (Critique 2026-04-29 E2/X2 — no attempt counter; cross-cron retries reuse the same key so Resend returns the existing broadcast)
-- (handled by the Application layer; this comment is informational)

UPDATE broadcasts
SET status = 'sending',
    resend_broadcast_id = $3,
    sending_started_at = now()
WHERE tenant_id = $1 AND broadcast_id = $2 AND status = 'approved';

COMMIT;
```

The cron-job.org HTTP trigger fires `GET /api/cron/broadcasts/dispatch-scheduled` every 5 minutes with `Authorization: Bearer ${CRON_SECRET}` (reused from F4/F5).

### Rationale

- **`SELECT FOR UPDATE SKIP LOCKED`** — the dispatch query is `SELECT * FROM broadcasts WHERE status='approved' AND scheduled_for <= now() FOR UPDATE SKIP LOCKED LIMIT 50`. Concurrent cron invocations skip rows already locked by another worker → no duplicate work.
- **`pg_advisory_xact_lock`** — second-line defence against race conditions when one worker is mid-transaction and another snapshots a stale `approved` row in its own SKIP LOCKED window. The advisory lock is namespace-scoped to `broadcasts:` (disjoint from F4's `invoicing:` and F5's `payments:` namespaces — no contention with F4 §87 sequential-number locks or F5 TOCTOU locks).
- **`hashtextextended('broadcasts:' || tenantId || ':' || broadcastId, 0)`** — produces a stable `bigint` lock id from the composite key. Postgres advisory locks are 64-bit integers; the hashing distributes locks evenly.
- **Idempotency-key on Resend dispatch** — stable `broadcast-{tenantId}-{broadcastId}` per FR-020 (Critique 2026-04-29 E2/X2 — no attempt counter). All dispatch attempts on a given F7 broadcast row reuse the same key. Defends against three failure modes simultaneously: (a) two cron workers racing past the advisory lock (impossible by design but key stability is defence in depth) — they reach Resend with the same key and both receive the same existing broadcast, (b) SDK auto-retries within a single tick — same key, same broadcast, (c) cross-tx-failure recovery — Resend dispatch succeeded but row UPDATE failed, cron tick N+1 re-dispatches with same key, gets the existing broadcast back, no duplicate.
- **Same pattern as F4 + F5** — F4 uses advisory locks for §87 sequential numbering (namespace `invoicing:`); F5 uses them for payment TOCTOU (namespace `payments:`). F7 follows the established pattern; namespaces are disjoint to avoid cross-feature lock contention.

### Alternatives Considered

- **Postgres `LISTEN/NOTIFY` for scheduled-send wake-up** — works but requires a long-lived connection (cron-style is simpler on Vercel Fluid Compute).
- **Separate worker process polling the DB** — adds ops surface; cron-job.org HTTP trigger is simpler.
- **Distributed lock via Upstash Redis** — already used for rate limiting; could be used for this lock too. But pg_advisory_xact_lock is auto-released on tx commit/rollback (no leak risk from worker crash) and stays inside the same transaction as the state transition (atomicity guarantee). Redis lock would need explicit release + lease timeout.

---

## 7. Reply-to header construction

### Decision

For every broadcast, the from + reply-to headers are constructed server-side at dispatch time as:

```
From: "<member_display_name> via <tenant_display_name>" <broadcasts@<tenant_verified_resend_domain>>
Reply-To: <member_primary_contact_email>
```

Examples:

```
From: "Fogmaker International AB via SweCham" <broadcasts@swecham.zyncdata.app>
Reply-To: peter.lindqvist@fogmaker.com
```

The from-name + tenant verified domain come from `tenants.display_name` + `tenants.broadcasts_sender_domain` (new column on the existing tenants table — added by F7 migration if not already present from F1+F4 setup; verified Resend domain).

The reply-to is always the originating member's `primary_contact_email`. FR-002 precondition `j` (Clarifications Q11) blocks submission if this field is null — so by the time dispatch runs, the reply-to is guaranteed to exist.

### Rationale

- **Locked from-name pattern** prevents impersonation — a member cannot alter the from-name to look like another member or like the chamber admin. The `<X> via <Y>` format is an established marketing-email convention (Mailchimp, Substack, ConvertKit all use it) and recipients recognise it.
- **Reply-to is the member's primary contact email** — recipient replies route to the right person (the member). Without this, replies would either go to the chamber admin (creating reply-funnel that admin then forwards = bad) or to a no-reply address (terrible for member relations).
- **Verified Resend domain** — chamber's domain (e.g., `broadcasts@swecham.zyncdata.app`). Resend requires SPF/DKIM/DMARC setup on this domain before broadcasts can be sent; setup is part of the tenant onboarding (F10 SaaS phase) and for SweCham was completed during F1.
- **Per-tenant from-name** — for SaaS multi-tenant, "via SweCham" is replaced with "via JCC" / "via GTCC" automatically based on the tenant context. F7's MTA+STD design handles this without code change.

### Alternatives Considered

- **Reply-to = chamber admin** — terrible UX; admin is a forwarding bottleneck.
- **Reply-to = no-reply address** — destroys the member↔recipient relationship; appropriate for transactional but not for marketing where conversation is desired.
- **Reply-to = member's submitting user's login email (F1)** — the user might not be the right reply target (admin could be proxying — Q12); the company's primary contact is the canonical "ask this person for more info" address.
- **Member-editable from-name** — rejected per spec edge case "Sender identity / from-name conflict"; impersonation risk.

---

## 8. F1 transactional vs F7 Broadcasts on the same Resend account

### Decision

**Single Resend account, both products enabled, separate API keys + separate webhook endpoints + separate suppression lists.**

Concretely:

- `RESEND_API_KEY` (existing F1+F4) → used by Resend SDK transactional methods (`emails.send`).
- `RESEND_BROADCASTS_API_KEY` (NEW, may equal `RESEND_API_KEY` for SweCham) → used by Resend SDK Broadcasts methods (`audiences.*`, `broadcasts.*`).
- `RESEND_WEBHOOK_SIGNING_SECRET` (existing F1+F4) → for the F1+F4 transactional webhook at `/api/webhooks/resend` (already shipped).
- `RESEND_BROADCASTS_WEBHOOK_SECRET` (NEW) → for the F7 Broadcasts webhook at `/api/webhooks/resend-broadcasts`.
- `RESEND_FROM_EMAIL` (existing F1+F4) → transactional from-address.
- `RESEND_BROADCASTS_FROM_EMAIL` (computed per-tenant at runtime — not env var) → broadcasts from-address per § 7.
- F1+F4 transactional events go to the F1+F4 webhook + F1+F4 suppression list.
- F7 Broadcasts events go to the F7 webhook + F7 suppression list (`marketing_unsubscribes`).
- A member who unsubscribes from a broadcast (FR-029) is added to F7's suppression — and is NOT added to F1+F4's transactional suppression. So they continue to receive password-reset, invoice-receipt, and renewal-reminder emails (FR-029 footer says "marketing emails only").

### Rationale

- **Resend supports both products on one account** — verified via Resend docs (https://resend.com/docs/api-reference/broadcasts/send-broadcast). The same API key MAY be used for both, but **separate keys are safer** for rotation: rotating the broadcasts key for a deliverability incident does not invalidate transactional sessions.
- **Separate webhook endpoints** — Resend's webhook setup is per-product; the dashboard lets you point each product's events at a different URL. We use this for clean separation: `email.delivered` from a transactional invoice email goes to `/api/webhooks/resend` (F4), while `email.delivered` from a broadcast goes to `/api/webhooks/resend-broadcasts` (F7). Same payload schema, different handlers, different suppression cascades.
- **Separate suppression scopes** — required by GDPR Article 21 + ePrivacy + spec FR-029: an unsubscribe from marketing MUST NOT affect transactional. Resend respects this natively via separate audiences; we mirror it locally.
- **F11 SaaS-billing implication** — when F11 introduces per-tenant Resend BYOK, tenants will provision their own Resend account and enable both products. Same env-var pattern applies.

### Alternatives Considered

- **Two separate Resend accounts (one transactional, one broadcasts)** — overkill for SweCham scale; doubles the verified-domain setup burden.
- **Single API key for both products** — works at MVP scale but creates rotation coupling. Decided against.
- **Single webhook endpoint for both products** — would force runtime branching on event payload metadata; cleaner to have two URL-segregated endpoints.

---

## 9. Resend Broadcasts API — recipient list payload

### Decision

**Fresh audience per broadcast (MVP)**:

For each `approved → sending` transition:

1. `BroadcastsGateway.createAudience({ name: 'broadcast-' + broadcastId })` — creates an empty Resend audience.
2. For each resolved recipient email (after FR-017 suppression filter), call `BroadcastsGateway.addContactToAudience({ audienceId, email, unsubscribed: false })`. Batched in groups of 50 with 100ms throttle to respect Resend rate limits.
3. `BroadcastsGateway.createBroadcast({ audienceId, from, replyTo, subject, html, name: subject })` — creates the broadcast resource on Resend.
4. `BroadcastsGateway.sendBroadcast({ id })` — dispatches.
5. The Resend audience persists in Resend's storage (Resend does not auto-delete); a periodic cleanup job (out of MVP) could prune audiences older than 90 days to keep the Resend dashboard tidy.

### Rationale

- **Snapshot semantics match FR-016** — the audience is a frozen snapshot of dispatch-time recipients. If a member is added/removed between dispatch + delivery, the audience is unaffected.
- **Suppression filter applied pre-audience-creation** — FR-017 invariant ("there is no scenario where a known-suppressed email is sent a broadcast") is enforced application-side before the Resend audience-add call. Defence in depth: we also pass `unsubscribed: true` on the contact-add call for any email that is in our suppression but somehow leaked into the resolved list (impossible by FR-017 logic but a safety net).
- **Persistent-per-segment audience (rejected for MVP)** — would reduce API call volume but introduces sync drift: when a member is added to the chamber, our `members` table reflects it instantly, but the persistent Resend audience does not. Sync-on-membership-change adds a write-amplification surface that is not justified at MVP volume.
- **F7.1 follow-up** — if metric `broadcasts.dispatch.duration_ms` exceeds the SLO-F7-004 budget consistently due to audience-creation overhead at large recipient lists (>1000), revisit persistent-per-segment audiences then.

### Alternatives Considered

- **Persistent-per-segment audiences kept in sync via members-table triggers** — write-amplification + sync-drift risk; deferred to F7.1.
- **Send a flat email list (not via audience)** — Resend Broadcasts API requires `audienceId`; no flat-list endpoint exists. Cannot bypass.
- **Use Resend transactional API in a loop** — would violate the transactional/marketing reputation separation; recipient mailbox providers heuristically detect bulk-via-transactional-API and penalise sender reputation. Not an option.

---

## 10. Cancellation cutoff implementation

### Decision

`cancel-broadcast.ts` use case enforces FR-004a / Clarifications Q10 via state-machine policy + DB-level CHECK:

```ts
// Domain layer policy
export const CANCELLABLE_STATES = ['submitted', 'approved'] as const;

// Application layer
async function cancelBroadcast(ctx: TenantContext, input: CancelBroadcastInput): Promise<Result<void, CancelError>> {
  return runInTenant(ctx, async (tx) => {
    const broadcast = await broadcastsRepo.findByIdForUpdate(tx, input.broadcastId);
    if (!broadcast) return Result.err({ code: 'broadcast_not_found' });
    if (!CANCELLABLE_STATES.includes(broadcast.status)) {
      await audit.emit('broadcast_cancel_too_late', { broadcastId, attemptedBy: input.actorId, currentState: broadcast.status });
      return Result.err({ code: 'broadcast_cancel_too_late', currentState: broadcast.status });
    }
    await broadcastsRepo.transitionToCancelled(tx, broadcastId, input.actorId, input.reason);
    await audit.emit('broadcast_cancelled', { broadcastId, actorId: input.actorId, actorRole: input.actorRole, reason: input.reason });
    await emailTransactional.enqueueCancellationNotification(broadcastId);
    return Result.ok();
  });
}
```

DB-level defence (migration 0064):

```sql
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_cancel_only_from_eligible_states CHECK (
    status != 'cancelled'
    OR (
      previous_status IN ('submitted', 'approved')
    )
  );
```

(`previous_status` is a generated column or a separate transition-log table; final shape pinned in data-model.md.)

### Rationale

- **Defence in depth** — Application layer + DB CHECK both enforce the rule; bypassing the use-case via direct DB write would still fail.
- **State-machine policy is in Domain** — `CANCELLABLE_STATES` is a Domain constant, no framework imports.
- **`broadcast_cancel_too_late` audit emission** — even rejected attempts are traceable for security analytics (someone trying to cancel a `sending` broadcast might be probing the state machine).
- **Same pattern as F5 payment cancellation** — F5's "cancel before processor accepts" rule uses an analogous Application-layer state-check + audit emission.

### Alternatives Considered

- **Allow cancel from any state, treat as no-op past `sending`** — silent failures are worse than loud rejections; member would think their broadcast was cancelled when it wasn't.
- **Add a `cancellable_until` timestamp column** — extra state for no benefit; the state-machine already encodes the cutoff.

---

## 11. Custom-list FR-015d resolver implementation

### Decision

`validate-custom-recipients.ts` use case runs three sequential lookups per entry, short-circuiting on first match:

```ts
async function validateCustomRecipients(ctx: TenantContext, emails: string[]): Promise<Result<string[], ValidationError>> {
  const normalised = emails.map(e => e.toLowerCase().trim());
  if (normalised.length > 100) return Result.err({ code: 'broadcast_custom_recipient_cap_exceeded' });

  const formatInvalid = normalised.filter(e => !emailValidator.validate(e));
  if (formatInvalid.length > 0) return Result.err({ code: 'broadcast_custom_recipient_format_invalid', entries: formatInvalid });

  const unresolved: string[] = [];
  for (const email of normalised) {
    const inMembers = await membersBridge.lookupMemberPrimaryContactEmailInTenant(ctx, email);
    if (inMembers) continue;
    const inContacts = await membersBridge.lookupContactEmailInTenant(ctx, email);
    if (inContacts) continue;
    const inEvents = await eventAttendeesRepo.findRecentAttendeeEmails(ctx, 90 /* days */);
    if (inEvents.includes(email)) continue;
    unresolved.push(email);
  }

  if (unresolved.length > 0) {
    await audit.emit('broadcast_custom_recipient_unknown', { count: unresolved.length });
    return Result.err({ code: 'broadcast_custom_recipient_unknown', entries: unresolved });
  }

  return Result.ok(normalised);
}
```

### Rationale

- **Sequential lookups, short-circuit on match** — most custom lists will resolve via the primary-contact lookup; checking that first is fastest. The third (event-attendees) is the rarest match.
- **Format validation BEFORE DB lookups** — fails fast on typos without 3 round-trips per malformed entry.
- **Audit emits count, not addresses** — privacy: rejected-recipient addresses are NOT logged; only the count.
- **Returns the verbatim unresolved list to the caller** — the API response shape includes the unresolved entries so the editor can highlight them; the caller is the member's own session, so showing them their own input is privacy-OK.
- **EventAttendees stub** — during F7-only dev the third lookup returns `[]` (empty array `.includes(email)` always false); F6 swap fixes this without code change in F7.

### Alternatives Considered

- **Single SQL UNION query across the three sources** — more efficient (1 round-trip instead of N×3) but harder to express across module boundaries (would require leaking F3's schema into F7); MVP uses the looser approach because custom lists are capped at 100 entries (manageable round-trip count).
- **Cache the lookup results in Redis** — premature optimisation at MVP scale.

---

## Phase 0 close-out

All open questions enumerated in plan.md § Phase 0 are resolved. No `[NEEDS CLARIFICATION]` markers remain. Phase 1 design (data-model.md, contracts/, quickstart.md) proceeds.
