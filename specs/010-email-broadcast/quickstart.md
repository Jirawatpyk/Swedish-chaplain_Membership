# F7 Email Broadcast — Developer Quickstart

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29

This guide gets a developer from a clean clone to a working F7 dev loop in ~30 minutes. Assumes F1+F2+F3+F4+F5 quickstarts have already been completed (Vercel project linked, Neon DB seeded, Upstash Redis provisioned, Resend transactional account created).

---

## 1. Prerequisites

- Node.js 22 LTS + pnpm (lockfile is `pnpm-lock.yaml`)
- Branch checked out: `git checkout 010-email-broadcast`
- F1+F4 quickstarts complete — `vercel env pull .env.local` already produces a working transactional auth/invoice setup
- Resend account (same one used for F1+F4 transactional)

## 2. Install new dependencies

```bash
pnpm add @tiptap/react @tiptap/starter-kit isomorphic-dompurify email-validator
pnpm install
```

This adds the four new F7 deps to `package.json` + `pnpm-lock.yaml`.

## 3. Enable Resend Broadcasts on the existing Resend account

In the Resend dashboard:

1. Open **Audiences** in the sidebar — accept the Broadcasts product if not already enabled (free for the first 3,000 recipients/month; SweCham scale needs ~ 4,200 → upgrade to **Pro** at $20/month before first production ship).
2. Verify the **broadcasts sender domain** — for SweCham use the existing F1 verified domain (e.g., `swecham.zyncdata.app`) and add a new sender identity `broadcasts@swecham.zyncdata.app`. Validate SPF/DKIM/DMARC records (the dashboard guides through this — typically 5 minutes if F1's domain is already verified).
3. Generate a **dedicated Broadcasts API key** (Settings → API Keys → "Create API key" with **broadcast scope only**). Copy the value. (You CAN reuse the F1 key, but separate keys allow independent rotation per research.md § 4.)
4. Set up the **Broadcasts webhook endpoint** (Settings → Webhooks → "Create webhook"):
   - URL: `https://<your-preview-or-prod-host>/api/webhooks/resend-broadcasts`
   - Events to subscribe: `email.sent`, `email.delivered`, `email.bounced`, `email.delivery_delayed`, `email.complained`
   - Copy the **Signing Secret** (used for `RESEND_BROADCASTS_WEBHOOK_SECRET`).

## 4. Add F7 env vars

In Vercel dashboard (or `.env.local` for local dev):

```bash
# F7 Resend Broadcasts (separate from F1 transactional)
RESEND_BROADCASTS_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
RESEND_BROADCASTS_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxx

# F7 Unsubscribe token signing secret (independent of session cookie secret per research.md § 4)
# Generate with: openssl rand -base64 32
UNSUBSCRIBE_TOKEN_SECRET=<32-byte-random-base64>

# F7 kill switch — false during dev/staging until Phase 5; flip to true at ship time
FEATURE_F7_BROADCASTS=true
```

Then refresh local env:

```bash
vercel env pull .env.local
```

`src/lib/env.ts` zod schema is updated by Phase 4 implementation tasks; until then the boot will warn about missing keys but continue (tests use mocks).

## 5. Run migrations

```bash
pnpm drizzle-kit generate           # produces 0064_create_broadcasts.sql etc.
pnpm drizzle-kit migrate            # applies to $DATABASE_URL (your dev Neon branch)
```

After migration:

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM broadcast_segment_definitions WHERE tenant_id = 'swecham';"
# Expect: 9 (default segments seeded by 0068)
```

## 6. Set up local webhook tunnel

Resend Broadcasts webhook deliveries cannot reach your laptop directly. Two options:

### Option A — Test on Vercel preview deploys

1. `git push origin 010-email-broadcast` → Vercel preview URL.
2. In the Resend dashboard, set the broadcasts webhook URL to the preview URL.
3. Trigger broadcasts from the deployed preview; Resend posts events to the preview.

### Option B — Local tunnel via ngrok / cloudflared

```bash
# Terminal 1
pnpm dev                                                       # Next.js on :3100

# Terminal 2 — tunnel localhost:3100 to a public URL
ngrok http 3100
# Copy the https://xxx.ngrok.io URL
```

Then in the Resend dashboard set the broadcasts webhook URL to `https://xxx.ngrok.io/api/webhooks/resend-broadcasts`. Trigger broadcasts from the local app; Resend posts events to your laptop via the tunnel.

(Note: ngrok URLs change on every restart unless you have a paid plan with a reserved subdomain. For long-running dev, prefer Option A.)

## 7. Daily dev loop

```bash
pnpm dev                              # localhost:3100
pnpm test                             # Vitest watch mode
pnpm test:integration                 # against live Neon Singapore via .env.local
pnpm test:integration:nightly         # JCC-test tenant fixture (Q18 / SC-011 multi-tenant readiness — runs in CI nightly; manual invocation here for verification)
pnpm test:e2e --workers=1             # Playwright (workers=1 mandatory per project memory)
pnpm lint
pnpm typecheck
pnpm check:i18n                       # add new keys to en/th/sv before this passes
```

**CI nightly cadence**: `.github/workflows/multi-tenant-readiness.yml` runs `pnpm test:integration:nightly` once per day, posts a status badge to README, and fails-the-build on any sub-criterion of SC-011 — making multi-tenant readiness a per-release continuous invariant rather than an F11-conditional milestone (Critique Round 3 R3-NEW-6 → Clarifications Q18 reword).

Smoke flow once code is implemented (Phase 5):

1. Sign in as a Premium Corporate member → navigate to `/portal/broadcasts/new`.
2. Compose: subject "Q3 product launch", body "Hello, …", segment "All members".
3. Click Submit → see confirmation with reservation count.
4. Sign out, sign in as `admin` → open `/admin/broadcasts?status=submitted`.
5. Click Approve & send now.
6. Check the test-mailbox inbox (any test member's `primary_contact_email` configured to a Mailtrap inbox or a `+seven` Gmail alias).
7. Click the unsubscribe link → see public confirmation page → reload → see "Already unsubscribed".

## 8. Cron-job.org dispatch trigger

For the scheduled-send dispatch handler:

1. Sign up at https://cron-job.org (free tier covers 5-min cadence).
2. Create a new cron job:
   - URL: `https://swecham.zyncdata.app/api/cron/broadcasts/dispatch-scheduled`
   - Schedule: `*/5 * * * *`
   - Method: GET
   - Headers: `Authorization: Bearer ${CRON_SECRET}` (the same `CRON_SECRET` already in Vercel env from F4/F5)
3. Save + enable.

For dev / staging, point the cron job at the preview URL (one cron-job.org account per environment).

## 9. Coverage thresholds

Vitest configured per Constitution Principle II:

- Domain `src/modules/broadcasts/domain/**` — 100% line
- Application `src/modules/broadcasts/application/**` — ≥ 80% line + 80% branch overall
- **100% branch on these security-critical use cases**:
  - `submit-broadcast.ts`
  - `sanitize-html.ts`
  - `validate-custom-recipients.ts`
  - `process-webhook-event.ts`
  - `cancel-broadcast.ts`
  - `unsubscribe-recipient.ts`
  - `enforce-tenant-context-on-broadcast.ts`
  - `enforce-tenant-context-on-unsubscribe.ts`

Run `pnpm test:coverage` to check.

## 10. Pre-PR checklist

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1
```

All green → push the branch → run `/speckit.review` → run `/speckit.staff-review` → if any BLOCKER/CRITICAL fix and re-run.

## 11. Emergency switches

- **`FEATURE_F7_BROADCASTS=false`** — kills the feature flag globally. Compose surface returns 503; cron handler skips. No-code-deploy mitigation. Same pattern as F4/F5.
- **`READ_ONLY_MODE=true`** — inherited from F1; returns 503 on every state-changing F7 endpoint while keeping reads + sign-in alive. Reversible in ~30 seconds without a code deploy.

## 12. Common dev gotchas

- **Tiptap hydration mismatch**: ALWAYS use `next/dynamic` with `ssr: false` for the editor. Never SSR Tiptap directly.
- **DOMPurify allowlist drift**: when adding a new Tiptap extension, also update `SANITIZER_CONFIG.ALLOWED_TAGS` + `ALLOWED_ATTR`. CI will fail on drift via the snapshot test in `sanitize-html.test.ts`.
- **Webhook signature dev key vs prod key**: Resend gives separate signing secrets for test mode vs live mode. Make sure your `RESEND_BROADCASTS_WEBHOOK_SECRET` matches the environment your webhook URL points at.
- **F6 stub returns []**: members selecting `event_attendees_last_90d` segment will see "Selected segment has no eligible recipients" (FR-002c) until F6 ships. This is documented behaviour, not a defect (Clarifications Q5).
- **`primary_contact_email` requirement**: F7 blocks submission for members without a primary contact email (FR-002 precondition `j` per Clarifications Q11). Seed your dev member with a real email or you'll see `broadcast_member_missing_primary_contact_email` errors.
- **Quota year boundary tests**: when running tests near 31 December / 1 January Bangkok time, expect quota-year-related tests to flake unless they freeze the clock via the `ClockPort` mock.

## 13. Useful queries

```sql
-- All pending broadcasts in tenant
SET app.current_tenant = 'swecham';
SELECT broadcast_id, subject, requested_by_member_id, submitted_at
FROM broadcasts
WHERE status = 'submitted'
ORDER BY submitted_at ASC;

-- Quota counter for a member
SELECT
  count(*) FILTER (WHERE status = 'sent' AND quota_year_consumed = 2026) AS used,
  count(*) FILTER (WHERE status IN ('submitted', 'approved')) AS reserved
FROM broadcasts
WHERE requested_by_member_id = '<member-uuid>';

-- Suppression list for tenant
SELECT email_lower, reason, unsubscribed_at FROM marketing_unsubscribes
WHERE tenant_id = 'swecham'
ORDER BY unsubscribed_at DESC LIMIT 50;

-- Webhook events received in last 24h
SELECT broadcast_id, status, count(*) FROM broadcast_deliveries
WHERE event_timestamp > now() - interval '24 hours'
GROUP BY broadcast_id, status;
```

## 14. References

- spec.md — feature specification (12 clarifications resolved)
- plan.md — implementation plan + Constitution Check
- research.md — Phase 0 research (Resend Broadcasts, Tiptap, sanitiser, tokens, cron)
- data-model.md — Phase 1 data model + RLS + state machine
- contracts/broadcasts-api.md — REST API contracts
- contracts/resend-webhook.md — webhook handler contract
- contracts/unsubscribe-public.md — public unsubscribe route
- docs/email-broadcast-analysis.md — strategic analysis (vendor selection, tier quotas)
- docs/saas-architecture.md — multi-tenant strategy
