# Email Broadcast (E-Blast) Analysis — F7

**Feature**: F7 — Email Broadcast / E-Blast System
**Status**: Planned (identified as critical gap 2026-04-11)
**Priority**: P1 (paid benefit — members pay for it)
**Depends on**: F3 (members), F2 (plans — for quota limits)
**Connects to**: Smart Feature #1 (Benefit Usage Dashboard)
**Multi-tenancy**: Full — see `docs/saas-architecture.md`

---

## 1. Why this feature exists

E-Blast is a **paid benefit** that every Corporate and Partnership tier promises
in the 2026 Membership Package PDF:

| Tier | E-Blasts promised / year |
|---|---|
| Premium Corporate | 6 |
| Large Corporate | 3 |
| Regular Corporate | 1 |
| Diamond Partnership | 15 |
| Platinum Partnership | 10 |
| Gold Partnership | 6 |

**Without F7, the chamber cannot deliver the benefit** — this is a contractual
obligation to members who have paid. It is NOT optional for MVP.

---

## 2. User scope

### Who triggers an E-Blast?

- **Member (Premium, Large, Regular, Diamond, Platinum, Gold)** submits an
  E-Blast request via the member portal — this consumes 1 unit from their
  annual quota
- **Admin** reviews the content + approves OR rejects
- **Admin** schedules the send (immediate or future date)
- **System** delivers the email to a segmented recipient list (usually "all
  other members" or "all in Bangkok", etc.)

### Who receives an E-Blast?

- Segmentation is chosen by the submitting member OR overridden by admin
- Typical segments:
  - **All members** (most common for corporate news)
  - **All Premium + Large** (high-value members only)
  - **Event attendees in past 90 days** (re-engagement)
  - **Members by industry sector** (if F3 tracks this)
  - **Custom list** (admin-curated email list)
- Recipients must have **not unsubscribed** from marketing email (GDPR
  obligation)

---

## 3. Why Resend Broadcasts (not Mailchimp/Brevo)

### Decision: **Build on Resend Broadcasts API**

We already use Resend for transactional email (password reset, invitations,
reminders — see F1 `auth` module). Resend launched **Broadcasts** as a
separate product in 2024, purpose-built for marketing/bulk email.

### Comparison

| Option | Build effort | Monthly cost | Vendor lock-in | Integration complexity |
|---|---|---|---|---|
| **Resend Broadcasts** ⭐ | ~6 tasks | $0 (existing) | Low (we own UI + data) | Low (same API as transactional) |
| **Mailchimp** | ~8 tasks | $13-500/tenant | High (per-tenant API key) | Medium (OAuth, lists sync) |
| **Brevo** (Sendinblue) | ~8 tasks | $0-65/tenant | Medium | Medium |
| **Build from scratch** | ~30 tasks | $0 | None | High (editor, deliverability, compliance) |

### Rationale for Resend

1. **Already installed** — zero new dependencies, unified sender identity
2. **Same infrastructure** — the email template engine from F1 (React Email)
   works for broadcasts too
3. **SOC 2 + GDPR compliant** — inherited from F1 decision
4. **Pricing scales with tenants** — per-tenant Resend account OR bring-your-own
   Resend API key (Enterprise plan)
5. **Broadcasts API is simple** — list creation, contact add, broadcast send,
   analytics webhook
6. **Deliverability inherited** — Resend's reputation handles sender warmup,
   SPF, DKIM, DMARC, feedback loops

### Known limitations of Resend Broadcasts (accepted trade-offs)

- Smaller template library than Mailchimp (we don't need it — React Email
  covers it)
- No built-in A/B testing (not needed for F1 MVP)
- No drip campaigns / automation sequences (F8 Renewal Reminders uses
  transactional, not Broadcasts)
- Newer product than Mailchimp (some rough edges expected)

---

## 4. Data model

```ts
// src/modules/broadcasts/infrastructure/db/schema.ts (F7)

// Enum: broadcast lifecycle
export const broadcastStatusEnum = pgEnum('broadcast_status', [
  'draft',        // member is composing
  'submitted',    // member submitted for admin review
  'approved',     // admin approved, ready to schedule
  'scheduled',    // scheduled for future send
  'sending',      // Resend is delivering
  'sent',         // delivery finished
  'rejected',     // admin rejected, member notified, quota NOT consumed
  'cancelled',    // member cancelled before send, quota NOT consumed
]);

// Broadcasts — one row per e-blast request
export const broadcasts = pgTable(
  'broadcasts',
  {
    tenantId: text('tenant_id').notNull(),
    broadcastId: uuid('broadcast_id').defaultRandom(),

    // Originator
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id').notNull(),
    requestedAt: timestamp('requested_at').notNull().defaultNow(),

    // Content
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),  // rendered HTML
    bodySource: text('body_source').notNull(),  // markdown or editor state
    fromName: text('from_name').notNull(),  // e.g. "Fogmaker via SweCham"
    replyToEmail: text('reply_to_email').notNull(),
    attachments: jsonb('attachments'),  // array of { filename, url, size }

    // Recipient targeting
    segmentType: text('segment_type').notNull(),  // 'all_members', 'premium_plus_large', 'custom', ...
    segmentFilter: jsonb('segment_filter'),  // parameterised filter (e.g., {tier: ['premium', 'large']})
    customRecipientEmails: text('custom_recipient_emails').array(),  // for 'custom' segment
    estimatedRecipientCount: integer('estimated_recipient_count'),  // computed at submit time

    // Lifecycle
    status: broadcastStatusEnum('status').notNull().default('draft'),
    submittedAt: timestamp('submitted_at'),
    approvedAt: timestamp('approved_at'),
    approvedByUserId: uuid('approved_by_user_id'),
    rejectedAt: timestamp('rejected_at'),
    rejectedByUserId: uuid('rejected_by_user_id'),
    rejectionReason: text('rejection_reason'),
    scheduledFor: timestamp('scheduled_for'),  // null = immediate
    sentAt: timestamp('sent_at'),

    // Quota accounting
    quotaYearConsumed: integer('quota_year_consumed'),  // 2026 — which annual quota was used
    quotaConsumedAt: timestamp('quota_consumed_at'),  // when 'sent' fires

    // Resend integration
    resendBroadcastId: text('resend_broadcast_id'),  // Resend's ID
    resendAudienceId: text('resend_audience_id'),  // Resend audience (recipient list)

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.broadcastId] }),
    tenantStatusIdx: index('broadcasts_tenant_status_idx').on(table.tenantId, table.status),
    tenantRequestedByIdx: index('broadcasts_tenant_requested_by_idx').on(table.tenantId, table.requestedByMemberId),
  }),
);

// Delivery events from Resend webhook (per-recipient tracking)
export const broadcastDeliveries = pgTable(
  'broadcast_deliveries',
  {
    tenantId: text('tenant_id').notNull(),
    deliveryId: uuid('delivery_id').defaultRandom(),

    broadcastId: uuid('broadcast_id').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    recipientMemberId: uuid('recipient_member_id'),  // nullable if non-member

    // Resend event types
    status: text('status').notNull(),  // 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'
    eventTimestamp: timestamp('event_timestamp').notNull(),
    resendMessageId: text('resend_message_id').notNull(),
    errorMessage: text('error_message'),  // populated on bounce/complaint

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.deliveryId] }),
    broadcastIdx: index('broadcast_deliveries_broadcast_idx').on(table.tenantId, table.broadcastId),
  }),
);

// Annual quota — per member, per year
// Computed view (not a table) — derived from members.plan_id + broadcasts
// Example query for Smart Feature #1 dashboard:
//
//   SELECT
//     m.member_id,
//     m.plan_id,
//     p.eblast_per_year AS quota,
//     COUNT(b.broadcast_id) FILTER (WHERE b.status = 'sent' AND b.quota_year_consumed = 2026) AS used,
//     p.eblast_per_year - COUNT(...) AS remaining
//   FROM members m
//   JOIN membership_plans p ON (p.tenant_id = m.tenant_id AND p.plan_id = m.plan_id)
//   LEFT JOIN broadcasts b ON (b.tenant_id = m.tenant_id AND b.requested_by_member_id = m.member_id)
//   WHERE m.tenant_id = 'swecham'
//   GROUP BY m.member_id, m.plan_id, p.eblast_per_year;

// Member-level unsubscribe (GDPR)
export const marketingUnsubscribes = pgTable(
  'marketing_unsubscribes',
  {
    tenantId: text('tenant_id').notNull(),
    memberId: uuid('member_id'),  // nullable — non-member can unsubscribe via token
    emailLower: text('email_lower').notNull(),
    unsubscribedAt: timestamp('unsubscribed_at').notNull().defaultNow(),
    reason: text('reason'),  // optional feedback
    sourceToken: text('source_token'),  // which unsubscribe link triggered
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.emailLower] }),
  }),
);
```

---

## 5. User journeys

### 5.1 Member submits an E-Blast request

```
1. Member signs in to /portal
2. Navigates to "My Benefits" → "E-Blast Service"
3. Sees quota: "4/6 remaining for 2026" (Premium tier)
4. Clicks "Compose New E-Blast"
5. Fills in:
   - Subject line
   - Body (rich-text editor or markdown)
   - Attachments (optional, ≤10 MB)
   - Recipient segment (dropdown: "All members", "Premium only", ...)
   - Preferred send date (default: "ASAP after approval")
6. Previews the email as it will appear
7. Clicks "Submit for Review"
8. System marks status='submitted', quota NOT yet consumed
9. Admin is notified (email + dashboard badge)
10. Member sees confirmation: "Submitted — admin will review within 48 hours"
```

### 5.2 Admin reviews & approves

```
1. Admin signs in to /admin
2. Dashboard shows "3 E-Blasts pending review"
3. Admin opens the list
4. For each submission:
   a. Preview the content
   b. Review recipient segment
   c. Click "Approve" OR "Reject with reason"
5. On approve:
   - Status → 'approved'
   - Member notified via email
   - If scheduled for future date, stays in queue
   - If immediate, transitions to 'sending'
6. On reject:
   - Status → 'rejected'
   - Member notified with reason
   - Quota NOT consumed
```

### 5.3 System sends the broadcast

```
1. A cron job OR immediate handler reads 'approved' broadcasts where
   scheduledFor <= now()
2. For each:
   a. Resolve recipient segment → list of email addresses
   b. Filter out unsubscribed emails
   c. Create a Resend Audience (if segment-based) OR use existing
   d. Call Resend Broadcasts API: create + send
   e. Store resendBroadcastId in our row
   f. Status → 'sending'
3. On Resend webhook (email.delivered / bounced / complained):
   - Append row to broadcast_deliveries
   - When all events accounted for, status → 'sent'
   - Consume quota: quota_year_consumed = 2026, quota_consumed_at = now()
4. Emit audit event: "broadcast_sent" with counts
```

### 5.4 Edge cases

- **Member submits but quota is 0**: reject at submission time (UI shows
  "Quota exhausted for 2026 — upgrade tier or wait until 2027")
- **Admin approves but member's tier changed between submit and send**: use
  the tier at **submit time** (stored in broadcast row), not current tier
- **Resend returns bounce for > 5% of recipients**: alert admin, don't
  consume quota (treat as delivery failure)
- **Admin rejects after approving**: allowed before 'sending' state; after
  that, not possible
- **Member tries to cancel after admin approved**: allowed if status is
  'approved' and scheduledFor > now() + 1 hour
- **Send fails due to Resend outage**: retry with exponential backoff for
  1 hour; then status → 'failed' and admin notified
- **Unsubscribe link clicked**: add row to marketing_unsubscribes, future
  broadcasts exclude this email automatically

---

## 6. API endpoints (contract overview)

All endpoints are tenant-scoped — requests must include tenant context
(resolved by middleware from subdomain/host).

### Member-facing

- `POST /api/broadcasts` — create draft
- `PUT /api/broadcasts/:id` — update draft
- `POST /api/broadcasts/:id/submit` — submit for review
- `POST /api/broadcasts/:id/cancel` — cancel before send
- `GET /api/broadcasts` — list own broadcasts
- `GET /api/broadcasts/:id` — view own broadcast + delivery stats

### Admin-facing

- `GET /api/admin/broadcasts?status=submitted` — review queue
- `POST /api/admin/broadcasts/:id/approve` — approve (optionally reschedule)
- `POST /api/admin/broadcasts/:id/reject` — reject with reason
- `GET /api/admin/broadcasts/:id/deliveries` — per-recipient status

### System

- `POST /api/cron/broadcasts/send-scheduled` — cron handler (Vercel Cron)
- `POST /api/webhooks/resend-broadcasts` — delivery events from Resend
  (separate endpoint from the transactional Resend webhook in F1)

### Public

- `GET /unsubscribe/:token` — one-click unsubscribe (no auth)
  - Token is signed with `AUTH_COOKIE_SIGNING_SECRET`
  - Single use, but unsubscribing multiple times is idempotent

---

## 7. UX notes

### Compose screen

- Rich-text editor: **Tiptap** or **Lexical** — both support collaborative
  editing, markdown, paste-from-Word, and image upload
- Preview pane (split view) shows how email will render in Gmail/Outlook
- Character count for subject line (recommended ≤60 chars)
- Spam-score estimator (optional — flags "FREE!!!" type language)
- Attachment uploader (Vercel Blob or Resend's own attachment handling)

### Quota display

Shown persistently in the compose screen header:

```
┌─────────────────────────────────────────┐
│ 📧 E-Blast Service — Premium Corporate │
│                                         │
│    2 / 6   used this year               │
│    ████░░  4 remaining                  │
│                                         │
│    Next quota reset: 1 Jan 2027         │
└─────────────────────────────────────────┘
```

### Approval queue (admin)

- Default sort: oldest submission first
- Filter by member, segment, date
- Bulk approve (Enterprise UX — Smart Feature #7 Inline/Bulk Actions)
- Keyboard shortcut: `A` to approve, `R` to reject, `N` for next

---

## 8. Integration with Smart Feature #1 (Benefit Usage Dashboard)

The **Benefit Usage Dashboard** (Smart Feature #1 in
`smart-chamber-features.md`) is the primary consumer of E-Blast quota data:

```
┌───────────────────────────────────────────────────┐
│ Benefit Usage — Fogmaker (Premium Corporate)      │
│                                                   │
│ E-Blast Service          ▓▓▓░░░  2/6 used        │
│ Cultural Event Tickets   ▓░      1/2 used        │
│ Event Discount           ──      unlimited        │
│ Member Referrals         ░░      0 (available)   │
│ Directory Listing        ✓       1 page + logo   │
│                                                   │
│  Next benefit reset: 1 Jan 2027                   │
└───────────────────────────────────────────────────┘
```

The dashboard queries the `broadcasts` table (counting rows where
`status = 'sent'` + `requested_by_member_id = X` + `quota_year_consumed = 2026`)
and compares against the quota from `membership_plans.eblast_per_year`.

---

## 9. Security & privacy

- **GDPR Article 21** — unsubscribe link mandatory on every broadcast
- **PDPA Section 24** — lawful basis = contractual (member paid for the
  service); unsubscribe still required for non-member recipients
- **Token security** — unsubscribe token is HMAC-signed, single-use not
  enforced (idempotent)
- **Rate limiting** — 10 broadcast submissions per member per day to prevent
  accidental flooding
- **Content moderation** — admin approval is the human gate (MVP); automated
  spam scoring is nice-to-have (phase 2)
- **Attachment scanning** — virus scan on upload (Vercel Blob has ClamAV);
  max size 10 MB per attachment
- **Audit log** — every broadcast creation, submission, approval, send,
  reject, cancel is an audit event
- **Cross-tenant isolation** — a SweCham member CANNOT send to a JCC member
  (enforced by tenant_id filter + Postgres RLS)

---

## 10. Feature-specific clarifications (for `/speckit.clarify` on F7)

### Q1: Rich-text editor choice

- **A**: Tiptap (open source, React, most popular)
- **B**: Lexical (Meta, more modern but smaller community)
- **C**: BlockNote (Notion-style, newer)

**Recommendation**: **A (Tiptap)** — mature, battle-tested

### Q2: Recipient segmentation — how expressive?

- **A**: Fixed segments only (all_members, tier-based, custom)
- **B**: Query builder UI (like Mailchimp: "tier = Premium AND joined after 2024")
- **C**: Raw SQL-like filter JSON (power user / admin only)

**Recommendation**: **A for MVP**, B for Pro tier, C never (too risky)

### Q3: Approval flow required?

- **A**: All broadcasts require admin approval (chosen above)
- **B**: Auto-approve for Premium / Partnership tiers; review for lower
- **C**: No approval (member submits → goes direct)

**Recommendation**: **A for MVP**. Safer. Can relax later if admins burn out.

### Q4: Attachment support — build or skip?

- **A**: No attachments in MVP (link to external URLs only)
- **B**: Attachments up to 10 MB (Vercel Blob storage)
- **C**: Unlimited attachments (risky for deliverability)

**Recommendation**: **A for MVP** (link-only), **B in phase 2**

### Q5: Analytics depth — opens/clicks?

- **A**: Send count only (delivered + bounced)
- **B**: Opens + clicks (privacy-sensitive — tracking pixel)
- **C**: Full funnel (opens, clicks, replies, conversions)

**Recommendation**: **A for MVP** — privacy-conscious, GDPR-friendly. Opens/clicks
are opt-in per-tenant later. (Aligns with our decision to disable open/click
tracking in Resend for F1 transactional emails.)

---

## 11. Estimated effort

| Phase | Tasks | Time |
|---|---|---|
| F7.0 Setup & schema | 4 tasks | 2 days |
| F7.1 Member compose + submit | 8 tasks | 3-4 days |
| F7.2 Admin approval queue | 6 tasks | 2-3 days |
| F7.3 Resend Broadcasts integration | 8 tasks | 3-4 days |
| F7.4 Webhook + delivery tracking | 5 tasks | 2 days |
| F7.5 Unsubscribe flow | 4 tasks | 1-2 days |
| F7.6 Quota dashboard integration | 3 tasks | 1 day |
| F7.7 Tests (unit + integration + E2E) | 12 tasks | 3-4 days |
| F7.8 Localisation (SV/EN/TH) | 3 tasks | 1 day |

**Total**: ~53 tasks, ~18-22 days effort (solo dev)

---

## 12. Priority & sequencing

**F7 lands in Phase 2** (after P0 MVP F2-F5 is deployed and validated)

Rationale:
- F7 depends on F3 (members exist) and F2 (plans have `eblast_per_year`)
- F7 is a member-facing benefit — members must first exist + be billed
- F4 (invoicing) should prove revenue works before investing in F7
- F8 (renewal) can wait — F7 has nearer-term business value

**Updated phases-plan ordering**:

```
P0 MVP:        F1 ✓ → F2 → F3 → F4
P1 Revenue:    F5 (payment)
P1 Value:      F7 (E-Blast) ⭐  ← NEW SLOT
P1 Retention:  F8 (renewal)
P2 Integration:F6 (EventCreate)
P2 Reporting:  F9 (dashboard)
SaaS:          F10-F13
```

---

## 13. Out of scope for F7 MVP

These are nice-to-haves deferred to phase 2+:

- Drip campaigns / automated sequences (use F8 for renewal reminders instead)
- A/B testing subject lines
- Template library beyond 1-2 starter templates
- In-app inbox / reply tracking (Resend doesn't do this; would need IMAP)
- Social media cross-posting
- Link shortening + click tracking (privacy-sensitive)
- AI-assisted content generation (phase 3+)
- Send time optimisation (phase 3+)

---

## 14. References

- [Resend Broadcasts API](https://resend.com/docs/api-reference/broadcasts/send-broadcast)
- [Membership Benefits Analysis](./membership-benefits-analysis.md) — quota per tier
- [SaaS Architecture](./saas-architecture.md) — multi-tenancy strategy
- [Smart Chamber Features](./smart-chamber-features.md) — #1 Benefit Usage Dashboard
- [Phases Plan](./phases-plan.md) — full roadmap
