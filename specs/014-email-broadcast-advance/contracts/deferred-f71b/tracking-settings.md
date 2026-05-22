# Contract: Engagement Tracking Settings (US5)

**Spec FRs**: FR-031..037 · **Clarifications**: round-1 Q5, round-2 Q4 · **Use-cases**: `toggleEngagementTracking`, `computeEngagementAggregates`, `purgeEngagementEvents`

---

## 1. Server actions

### 1.1 `toggleEngagementTracking({ openTracking?, clickTracking? })` — admin only

**Route**: `POST /api/admin/broadcasts/settings/tracking`
**Auth**: admin role + tenant ctx.
**Input**:
```typescript
const Input = z.object({
  openTrackingEnabled: z.boolean().optional(),
  clickTrackingEnabled: z.boolean().optional(),
}).refine(input => input.openTrackingEnabled !== undefined || input.clickTrackingEnabled !== undefined, 'at_least_one_toggle_required');
```
**Output**: `Promise<Result<{ open: boolean; click: boolean }, BroadcastError>>`.
**Pipeline**: UPDATE tenant_broadcast_settings.
**Audit events**: `broadcast_open_tracking_enabled_changed` (when open toggle changes) + `broadcast_click_tracking_enabled_changed` (when click toggle changes) — two SEPARATE events per Clarifications round-1 Q5 (two independent toggles, two independent audit trails).

### 1.2 `applyEngagementTrackingToDispatch({ broadcastId })` — invoked during dispatch

**Invocation**: Inside the existing F7 MVP `dispatchBroadcastBatch` use-case (now extended for US1 batching).
**Behavior**: Read tenant settings at dispatch time (snapshot) → pass tracking params to Resend Broadcasts API:
- `openTracking=true` if `broadcastOpenTrackingEnabled=true` at dispatch
- `clickTracking=true` if `broadcastClickTrackingEnabled=true` at dispatch
- Snapshot of BOTH values recorded on the `broadcast_sent` audit event (FR-037) so re-investigation can determine what was enabled at send time even if the tenant later toggles

### 1.3 `handleEngagementWebhookEvent({ type, broadcastId, recipientEmail, linkUrl? })` — extended F7 MVP webhook

**Route**: `POST /api/webhooks/resend` (existing F7 MVP route)
**Auth**: Svix HMAC signature verification (existing F7 MVP).
**Behavior**: Extends F7 MVP webhook handler with two new event types:
- `email.opened` → INSERT engagement_events row with event_type='open' + recipient_email_hash=sha256(email); ON CONFLICT DO NOTHING via `engagement_events_unique_recipient_open_idx` partial index (dedup per FR-033 unique-recipient counting)
- `email.clicked` → INSERT with event_type='click' + clicked_link_url; ON CONFLICT DO NOTHING via `engagement_events_unique_recipient_link_click_idx` partial index (dedup per FR-033 per-recipient-per-link semantics)
- EXCLUDE the unsubscribe link from click tracking (FR-033): if `linkUrl` matches the F7 MVP unsubscribe URL pattern, drop the event
**No audit event for individual webhook events** — too high-volume; aggregate counts surfaced via 1.4 below.

### 1.4 `computeEngagementAggregates(broadcastId)` — invoked by broadcast detail page

**Invocation**: Server component data fetcher (or API route called by client).
**Auth**: admin or member with broadcast access.
**Output**: `{ openCount?: number; clickCount?: number; perLinkClicks?: Array<{ linkUrl: string; uniqueRecipientCount: number }> }`.
**Behavior**:
- `openCount` returned ONLY when `broadcastOpenTrackingEnabled` was true at dispatch (snapshot from broadcast row)
- `clickCount` returned ONLY when `broadcastClickTrackingEnabled` was true at dispatch
- Per-link breakdown (FR-033 visualisation requirement) computed from engagement_events grouped by clicked_link_url
- Aggregate latency: ≤5 min lag from webhook to displayed count (US5 AS2) — driven by Postgres index freshness, no caching layer
**No audit event** (read-only).

### 1.5 `purgeEngagementEvents()` — sweeper cron

**Route**: `POST /api/cron/broadcasts/prune-engagement-events`
**Auth**: cron-job.org Bearer auth via `CRON_SECRET`.
**Schedule**: Daily at 04:00 Asia/Bangkok.
**Behavior**: DELETE engagement_events WHERE created_at < now() - interval '90 days' (FR-035 retention horizon).
**Verification**: SC-010 integrity check — assert no engagement_events row exists with `created_at + interval '91 days' < now()`.

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `at_least_one_toggle_required` | toggleEngagementTracking with neither toggle in payload | 400 |
| `webhook_signature_invalid` | Svix verification fails | 401 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch (n/a for webhook — webhook is tenant-routed via Resend audience metadata) | 403 + audit |

---

## 3. UI surface

- **Admin settings page** — `/admin/broadcasts/settings` — two independent toggle rows (open, click) with consent-obligation banners per FR-036; each toggle audits independently
- **Admin broadcast detail** — open_count column shown only if open-tracking was ON at dispatch; click_count + per-link breakdown shown only if click-tracking was ON at dispatch
- **Member archive view** — unchanged (members never see open/click — only aggregates surface to admins per FR-034)

WCAG verification: toggle is `<input type="switch">` (or shadcn Switch with `role="switch"` + `aria-checked`); per-link breakdown table has `<th scope="col">` headers; consent banner is `role="region"` with named landmark.

---

## 4. Privacy invariants

- **Per-recipient open/click data NEVER surfaced to admin/member UI** — only aggregated counts (FR-034)
- **Recipient email stored as sha256 hash** in `engagement_events.recipient_email_hash` — never plaintext (Principle I PII minimization)
- **90-day retention** for per-recipient event rows; aggregate counts on the broadcast row preserved indefinitely per FR-035
- **Snapshot of both toggles at dispatch time** stored on `broadcast_sent` audit row (FR-037) — invariant means "we never retro-track a broadcast"
