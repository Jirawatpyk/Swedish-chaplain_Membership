import { z } from 'zod';

/**
 * Boot-time environment validation (T017, plan.md § Constraints).
 *
 * Reads `process.env`, validates with zod, and exports a typed `env`
 * object for the rest of the codebase. Throws synchronously at module
 * load if a required variable is missing or malformed — Next.js will
 * surface the error during dev startup or production boot.
 *
 * Why throw at boot:
 *   - We never want to discover a missing DATABASE_URL inside a request
 *     handler (would bubble up as a 500 with a confusing stack trace).
 *   - Zod errors are descriptive and grouped, so the operator sees
 *     every misconfigured key at once instead of fixing them one by
 *     one through trial and error.
 *
 * Vercel Marketplace mapping:
 *   - Neon integration sets `DATABASE_URL` + `DATABASE_URL_UNPOOLED`
 *     (and a bunch of `POSTGRES_*` aliases). We accept any of them.
 *   - Vercel KV / Upstash integration sets `KV_REST_API_URL` +
 *     `KV_REST_API_TOKEN`. We expose them under `upstashUrl` /
 *     `upstashToken` so the rate-limit adapter (T037) doesn't have to
 *     know which integration provisioned them.
 */

// --- Coercion helpers ---------------------------------------------------------

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return value.trim().toLowerCase() === 'true' || value.trim() === '1';
  });

const csvList = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .refine((items) => items.length > 0, 'must contain at least one entry');

// A comma-separated list where every entry must be a valid email. Reuses
// `csvList` for the split/trim/non-empty contract, then validates each item —
// a single typo'd address fails the boot (same fail-fast contract as every
// other env var). Used for multi-recipient contact channels (e.g. the
// offline-payment "contact us" mailto, which can reach more than one person).
const emailCsvList = csvList.pipe(z.array(z.string().email()));

// --- Schema -------------------------------------------------------------------

const schema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database (Neon)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  POSTGRES_URL_NON_POOLING: z.string().url().optional(),
  // Optional postgres-js pool size override. Falls back to per-env
  // defaults in `src/lib/db.ts` (prod=10, dev=8). Set this on Vercel
  // when scaling concurrent webhook bursts requires headroom beyond
  // the defaults — no code change needed.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),

  // Rate-limit cache (Upstash via Vercel Marketplace)
  // Vercel KV exports KV_REST_API_*, plain Upstash exports UPSTASH_REDIS_REST_*.
  // We accept either and normalise below.
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(20).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(20).optional(),

  // Transactional email (Resend)
  RESEND_API_KEY: z
    .string()
    .min(10)
    .refine((value) => value.startsWith('re_'), 'expected "re_" prefix'),
  RESEND_WEBHOOK_SIGNING_SECRET: z.string().min(10),
  // From address used for all outbound transactional mail.
  // MUST match a domain that is verified in the Resend account bound
  // to `RESEND_API_KEY`. Format: `Display Name <local@domain>` OR
  // bare `local@domain`. Optional; falls back to the SweCham brand
  // default in `resend-client.ts`.
  RESEND_FROM_EMAIL: z.string().min(3).optional(),

  // Auth cookie HMAC signing secret (≥32 bytes of entropy recommended).
  // Generate with: openssl rand -base64 48
  AUTH_COOKIE_SIGNING_SECRET: z.string().min(32),

  // Application URLs
  APP_BASE_URL: z.string().url(),
  // Comma-separated allow-list — used by proxy.ts CSRF Origin check
  // (delegated to `src/lib/csrf.ts`'s `checkCsrf()` decision function).
  APP_ALLOWED_ORIGINS: csvList,

  // Operational flags
  READ_ONLY_MODE: booleanFromString.default(false),

  // K14-9 (R13-S6): off-Vercel deployments must opt-in to acknowledge
  // they have wired a trusted reverse proxy that strips and rewrites
  // `x-forwarded-for`. When unset (default false), the boot-time
  // `assertVercelDeploymentForTrustedXff()` in `src/lib/client-ip.ts`
  // emits a console.warn in production if `VERCEL` env var is also
  // absent — to alert operators that per-IP rate-limit buckets may be
  // spoofable. Routing the read through this zod-validated accessor
  // (rather than raw `process.env.TRUSTED_REVERSE_PROXY === 'true'`)
  // makes the value robust to capitalisation variations (`True`, `1`,
  // `TRUE` all coerce correctly via `booleanFromString`).
  TRUSTED_REVERSE_PROXY: booleanFromString.default(false),

  // Bootstrap (used only by scripts/seed-bootstrap-admin.ts)
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),

  // Member-facing support contact — the `mailto:` target on the portal's
  // lapsed-membership + invoice cards. Defaulted to the SweCham address so a
  // single-tenant deploy works out of the box; override per deployment
  // (tenant-config-ready for multi-tenant onboarding). Not a secret.
  SUPPORT_EMAIL: z.string().email().default('info@swecham.se'),

  // Billing / offline-payment contact — the `mailto:` recipients on the
  // invoice-detail "online payment unavailable" card (OnlinePaymentDisabledCard).
  // Comma-separated so payment queries can reach more than one person (mailto
  // supports multiple recipients). Optional — when unset the card falls back to
  // SUPPORT_EMAIL (which always has a value), so a deploy that never sets this
  // still renders a working CTA. Deliberately SEPARATE from BOOTSTRAP_ADMIN_EMAIL,
  // which is an ADMIN-ACCOUNT IDENTITY (scripts look it up by exact match), not a
  // contact channel. Not a secret.
  BILLING_CONTACT_EMAILS: emailCsvList.optional(),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- F2 Multi-tenancy -----------------------------------------------------
  // Single-tenant deployment: `TENANT_SLUG=swecham` in F2. The tenant-context
  // resolver (`src/lib/tenant-context.ts`) emits this as a constant
  // TenantContext for every request until F10 introduces real subdomain /
  // custom-domain resolution. Slug format `[a-z0-9-]{1,63}` matches the
  // `asTenantContext()` validator in `src/modules/tenants/domain/tenant-context.ts`
  // so invalid slugs are rejected at boot rather than runtime.
  TENANT_SLUG: z
    .string()
    .regex(
      /^[a-z0-9-]{1,63}$/,
      'TENANT_SLUG must be 1..63 chars of [a-z0-9-] (lowercase alphanumeric + hyphen)',
    ),

  // Single-tenant deployment IANA timezone — drives F7 quota-year boundary
  // math + reset-date microcopy. SweCham defaults to `Asia/Bangkok` per
  // FR-006; a future Stockholm chamber would deploy a separate Vercel
  // instance with `TENANT_TIMEZONE=Europe/Stockholm`. Validated at boot
  // against the IANA registry via `Intl.DateTimeFormat` — invalid id
  // throws RangeError, refusing to start the app rather than silently
  // rendering UTC.
  //
  // F12-TODO: when multi-tenant-per-deployment ships, replace this env
  // var with a `tenants.timezone` column read via TenantConfigPort.
  TENANT_TIMEZONE: z
    .string()
    .default('Asia/Bangkok')
    .superRefine((value, ctx) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `TENANT_TIMEZONE must be a valid IANA timezone identifier (got "${value}")`,
        });
      }
    }),

  // Dev-mode safety net: when TRUE, `assertTenantContextSet()` in `src/lib/db.ts`
  // throws a loud, stack-traced error if a query runs while
  // `current_setting('app.current_tenant', TRUE)` is NULL — prevents
  // "I forgot runInTenant" class of bug during development. MUST be false
  // (or unset) in production; the env validator asserts this below.
  //
  // R7-S4 — ops recommendation: set this to TRUE on STAGING (non-prod)
  // so any cross-tenant hole caught by the F4 sequence allocator or F3
  // member repo assertion fails loud during QA instead of falling
  // through to RLS (silent deny → harder to diagnose). Keep OFF in
  // production to avoid leaking stack traces in hot paths.
  DEBUG_RLS_STATE: booleanFromString.default(false),

  // T115t — test-only flag enabling `X-Tenant` header override in
  // `resolveTenantFromRequest`. When TRUE, a request's `X-Tenant`
  // header value is used as the tenant slug instead of
  // `env.tenant.slug`. Required by Playwright throwaway-tenant
  // fixtures that provision per-test tenants.
  //
  // REFUSED in production: the validator below throws at boot if
  // NODE_ENV='production' AND this flag is TRUE. In prod this
  // header is silently ignored regardless of header presence.
  E2E_X_TENANT_HEADER_ENABLED: booleanFromString.default(false),

  // --- F3 Feature flag ------------------------------------------------------
  // Kill-switch for the Members & Contacts feature. When FALSE every
  // `/api/members/**` and `/api/portal/**` route returns 503 `read_only_mode`
  // via the feature-flag guard (T036/T037). Default TRUE so normal
  // deployments pick up the feature; set to FALSE in Vercel env to
  // temporarily disable without a code deploy.
  FEATURE_F3_MEMBERS: booleanFromString.default(true),

  // --- F4 Invoicing ---------------------------------------------------------
  // Vercel Blob (private) read/write token — used by
  // `vercel-blob-adapter.ts` to persist rendered tax-document PDFs under
  // `invoicing/{tenant_id}/{yyyy}/{document_id}.pdf`. Signed URLs are
  // issued per-request with a 60s TTL. Missing token at boot is a
  // ship-blocker: F4 cannot render/store/serve PDFs without it.
  BLOB_READ_WRITE_TOKEN: z.string().min(10),

  // --- F9 Insights export (private Blob store) ------------------------------
  // Read/write token for a SEPARATE, **private-access** Vercel Blob store used
  // ONLY by `private-blob-adapter.ts` to persist F9 E-Book / GDPR export
  // artefacts via `put({ access: 'private' })`. A Vercel Blob store is public
  // XOR private (chosen at store-creation); the existing `BLOB_READ_WRITE_TOKEN`
  // store is PUBLIC (it backs F4 invoice PDFs + F9 directory logos, all
  // `access:'public'`), so private puts on it are rejected. Optional: when
  // unset it falls back to `BLOB_READ_WRITE_TOKEN` so dev/test boot + the
  // dark-launch path keep working (exports use an in-memory stub in tests and
  // are flag-gated in prod). Ship-day operator MUST provision a private store
  // and set this before flipping `FEATURE_F9_DASHBOARD` on (runbook T101a).
  BLOB_PRIVATE_READ_WRITE_TOKEN: z.string().min(10).optional(),

  // Shared secret used by Vercel Cron to authenticate the auto-email
  // dispatcher endpoint (`/api/cron/auto-email-dispatch`). The route
  // handler compares this against the `Authorization: Bearer <secret>`
  // header that Vercel Cron supplies. Rotating this secret invalidates
  // queued webhook triggers — coordinate with vercel.json updates.
  CRON_SECRET: z.string().min(16),

  // Kill-switch for F4 Invoicing. When FALSE every `/api/invoices/**`,
  // `/api/credit-notes/**`, `/api/tenant-invoice-settings/**`, and
  // `/api/portal/invoices/**` route returns 503 `read_only_mode` via
  // the feature-flag guard (T020). Default TRUE so normal deployments
  // pick up the feature; set to FALSE in Vercel env to temporarily
  // disable without a code deploy — useful for emergency write-freeze
  // of financial mutations.
  FEATURE_F4_INVOICING: booleanFromString.default(true),

  // --- F5 Online Payment (Stripe + PromptPay) -------------------------------
  // Stripe secret key — server-only. MUST never be logged (pino redact
  // list extended in T032). Test keys start `sk_test_`, live keys `sk_live_`.
  STRIPE_SECRET_KEY: z
    .string()
    .min(10)
    .refine((v) => v.startsWith('sk_test_') || v.startsWith('sk_live_'),
      'expected "sk_test_" or "sk_live_" prefix')
    .describe('SECRET — do not log'),

  // Stripe publishable key — safe to ship to the browser via Stripe Elements.
  // MUST use `NEXT_PUBLIC_` prefix so Next.js inlines it into the client
  // bundle (server-only env vars are stripped from the client chunk).
  // Consumed by `loadStripe()` in `src/modules/payments/infrastructure/stripe/stripe-browser.ts`.
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .min(10)
    .refine((v) => v.startsWith('pk_test_') || v.startsWith('pk_live_'),
      'expected "pk_test_" or "pk_live_" prefix'),

  // Webhook signing secret used by `stripe.webhooks.constructEvent` to
  // verify `Stripe-Signature` header. SECRET — redacted in logs.
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(10)
    .refine((v) => v.startsWith('whsec_'), 'expected "whsec_" prefix')
    .describe('SECRET — do not log'),

  // Pinned Stripe API version (currently `2025-09-30.clover`; the live
  // pin is whatever this `STRIPE_API_VERSION` var is set to — see
  // `.env.example` + `stripe-api-version.ts`). Passed to
  // `new Stripe(..., { apiVersion })` and surfaced as `Stripe-Version`
  // response header by the webhook route. Pinning prevents silent
  // behaviour drift when Stripe releases a new default version.
  STRIPE_API_VERSION: z.string().min(8),

  // Stripe connected-account ID for SweCham tenant (stable across
  // test + live modes, one account per tenant). Used as
  // `stripeAccount` option on SDK calls.
  STRIPE_ACCOUNT_ID_SWECHAM: z.string().min(10),

  // Environment assertion — MUST match `STRIPE_SECRET_KEY` prefix.
  // TRUE in production only; FALSE in dev/staging. Cross-checked at
  // boot below to refuse `sk_live_` in non-production deploys.
  STRIPE_LIVE_MODE: booleanFromString.default(false),

  // Kill-switch for F5 Online Payment. When FALSE the
  // `online_payment_enabled` column is ignored and every payment
  // route returns 503 `feature_disabled`. Default FALSE so F5 ships
  // dark; flip to TRUE in Vercel env after Rolling Release gate.
  FEATURE_F5_ONLINE_PAYMENT: booleanFromString.default(false),

  // T166 (Phase 9 polish — async receipt PDF). When TRUE,
  // `record-payment.ts` H+I steps skip the synchronous PDF render +
  // upload and instead enqueue a `receipt_pdf_render` outbox row for
  // async dispatch. Webhook p95 drops from ~5–15 s to ~1–3 s. Default
  // FALSE keeps the inline path while the async pipeline soaks in
  // production. Flip to TRUE per `docs/runbooks/receipt-pdf-async-rollback.md`.
  // Kept dual-path for 2 releases per Constitution Principle VIII
  // reliability — kill-switch must always revert without code deploy.
  FEATURE_F5_ASYNC_RECEIPT_PDF: booleanFromString.default(false),

  // PG-2 DPA gate — FR-036 cancellation emails CAN include the VOID-
  // stamped invoice PDF as an email attachment. Shipping the PDF
  // bytes (which contain member tax ID + legal name + address) to
  // Resend (EU processor) expands the PDPA §28 / GDPR Art. 28 cross-
  // border transfer scope beyond what the existing F1 Resend DPA
  // explicitly covers. Default FALSE until DPO/legal confirms the
  // DPA extension covers binary attachments containing tax-document
  // PII. When FALSE the cancellation email still references the
  // voided document number and declares "no longer payable" (FR-036
  // partial), but ships a download LINK instead of an attachment.
  // Flip to TRUE in Vercel env once the DPA amendment is signed.
  FEATURE_F4_VOID_ATTACHMENT: booleanFromString.default(false),

  // --- 088 Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้) ----------
  // Kill-switch for the new §87-at-payment tax flow. When FALSE (default)
  // the legacy F4 flow is active: the pre-payment document is a §86/4
  // ใบกำกับภาษี issued with a §87 number at issue time. When TRUE the new
  // flow ships: the pre-payment document becomes a NON-tax ใบแจ้งหนี้
  // (non-§87 `SC` bill number allocated at issue), and the single §86/4
  // ใบกำกับภาษี/ใบเสร็จรับเงิน is minted only at payment (§78/1 tax point),
  // dated at the payment date, with the §87 `RC` number born then — so a
  // member never holds two §86/4 tax invoices for one sale.
  //
  // The SAME flag ALSO gates the US8 surface (per plan § Rollout G5): the
  // issue-invoice `vat_treatment` toggle (standard 7% / zero-rated
  // §80/1(5) 0%) + MFA-cert fields + the zero-rate render arm — so US8 can
  // dark-launch independently of the P1 core (flag off → the toggle is
  // hidden and every invoice is `'standard'` 7%).
  //
  // Default FALSE — 088 ships dark; the SweCham settings flip
  // (receiptNumberingMode='separate', receiptNumberPrefix='RC', WHT note)
  // is the operator trigger. Reverting the flag + redeploying prior code +
  // reverting the settings flip is the rollback (NOT a DB down-migration —
  // an `ALTER TYPE … ADD VALUE 'bill'` and consumed §87 numbers are
  // irreversible; see plan § Rollout / Constitution Gate X).
  FEATURE_088_TAX_AT_PAYMENT: booleanFromString.default(false),

  // --- F7 Email Broadcast (Resend Broadcasts API) ---------------------------
  // Resend Broadcasts API key — separate Resend product surface from the
  // F1+F4 transactional API. Hosted on the same Resend account; uses a
  // distinct webhook endpoint (`/api/webhooks/resend-broadcasts`) and
  // separate suppression list. May equal `RESEND_API_KEY` if the same
  // account hosts both products, but is kept as a distinct env var for
  // independent rotation. SECRET — redacted in logs.
  RESEND_BROADCASTS_API_KEY: z
    .string()
    .min(10)
    .refine((v) => v.startsWith('re_'), 'expected "re_" prefix')
    .describe('SECRET — do not log'),

  // Svix HMAC-SHA256 webhook signing secret for the Broadcasts webhook
  // endpoint at `/api/webhooks/resend-broadcasts`. Distinct from
  // `RESEND_WEBHOOK_SIGNING_SECRET` (F1 transactional) — each Resend
  // product issues its own webhook secret. ≥32 bytes of entropy.
  // SECRET — redacted in logs.
  RESEND_BROADCASTS_WEBHOOK_SECRET: z.string().min(32).describe('SECRET — do not log'),

  // From-address used for outbound F7 broadcast dispatches (passed as
  // `from` to `broadcasts.create`). MUST match a domain verified in the
  // Resend account bound to `RESEND_BROADCASTS_API_KEY`.
  //
  // Accepts EITHER format (Resend SDK supports both):
  //   - bare:    `noreply@domain.tld`
  //   - wrapped: `Display Name <noreply@domain.tld>`
  //
  // No default — boot fails if unset to prevent accidental dispatch
  // from a placeholder address (see review C1 — 2026-04-30).
  BROADCASTS_FROM_EMAIL: z
    .string()
    .min(3)
    .refine(
      (v) => {
        // Extract email portion: either the whole string, or the part
        // inside <…> for the wrapped form.
        const wrapped = v.match(/<([^>]+)>\s*$/);
        const email = wrapped ? wrapped[1]?.trim() : v.trim();
        if (!email) return false;
        // Lightweight RFC-5321 check (matches `RESEND_FROM_EMAIL` style).
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      },
      'must be `local@domain` or `Display Name <local@domain>`',
    )
    .refine(
      (v) => {
        const wrapped = v.match(/<([^>]+)>\s*$/);
        const email = wrapped ? wrapped[1]?.trim() : v.trim();
        if (!email) return true;
        const domain = email.split('@')[1] ?? '';
        return !/\.(example|invalid|test|localhost)$/i.test(domain);
      },
      'must not use IANA reserved TLDs (.example/.invalid/.test/.localhost)',
    ),

  // HMAC secret used to sign one-click unsubscribe tokens. ≥32 bytes of
  // entropy. MUST be distinct from `AUTH_COOKIE_SIGNING_SECRET` (per
  // research.md § 4) so token rotation does not invalidate user sessions.
  // Tokens are valid forever (FR-030 idempotency — replays are safe).
  // Generate with: openssl rand -base64 48
  // SECRET — redacted in logs.
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32).describe('SECRET — do not log'),

  // F7 UX-5/UX-6 — optional public URLs surfaced on member-acknowledge
  // banner (privacy policy) and the public unsubscribe page (chamber
  // website). Both nullable; UI gracefully omits the link when unset
  // so a tenant without a published privacy policy or website does
  // not render dead `<a href="">` markup. URL validation is best-
  // effort; mis-typed URLs degrade to "no link rendered" in prod.
  TENANT_PRIVACY_POLICY_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  TENANT_WEBSITE_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  // Kill-switch for F7 Email Broadcast. When FALSE every
  // `/api/broadcasts/**` and `/api/admin/broadcasts/**` route returns
  // 503 `feature_disabled` via the kill-switch helper (T031). Default
  // FALSE — F7 ships dark; flip to TRUE in Vercel env after the F7
  // release gate. Mid-flight broadcasts (status `submitted`/`approved`)
  // remain visible to admins for completion/rejection per FR-002 +
  // Spec § Edge Cases L341.
  FEATURE_F7_BROADCASTS: booleanFromString.default(false),

  // --- F8 Renewal Tracking + Smart Reminders --------------------------------
  // Kill-switch for F8 Renewal Tracking + Smart Reminders. When FALSE
  // every `/api/cron/renewals/**`, `/api/admin/renewals/**`, and the
  // member portal renewal page return 503/404 `feature_disabled` via
  // the kill-switch helper. Default FALSE — F8 ships dark; flip to
  // TRUE at MVP-wide chamber go-live (Option C per Assumption A12 v3
  // — when entire MVP F1-F9 + Phase 5B polish complete). 6 cron jobs +
  // renewal pipeline + at-risk widget + tier-upgrade queue + escalation
  // tasks all gated by this single flag.
  FEATURE_F8_RENEWALS: booleanFromString.default(false),

  // --- COMP-1 Member Erasure (GDPR Art.17 / PDPA §33) -----------------------
  // Kill-switch for the US2d member-erasure reconciliation sweep
  // (`/api/cron/members/reconcile-erasures`). When FALSE the cron route
  // returns 200 + {skipped:true} so cron-job.org does NOT retry-storm during a
  // pause window. The reconciler re-drives the idempotent `eraseMember` for
  // members whose erasure committed (`members.erased_at` set) but whose
  // `member_erased` completion audit never landed. Default TRUE — erasure is a
  // shipped compliance surface (mirrors F3/F4 default-true), so the self-healing
  // sweep must run unless an operator explicitly pauses it. Flip to FALSE in
  // Vercel env to halt re-drives during an incident, then revert + redeploy.
  FEATURE_MEMBER_ERASURE_RECONCILE: booleanFromString.default(true),

  // Granular kill-switch for F8 at-risk widget + at-risk recompute cron.
  // When TRUE, ONLY the at-risk surfaces are short-circuited (widget
  // returns "Feature temporarily unavailable" placeholder; recompute cron
  // returns `{skipped:true,reason:'at_risk_disabled'}`; score-column
  // reads return null). Pipeline + reminders + tier-upgrade + escalation
  // tasks + member self-service remain fully operational. Designed for
  // incident response when at-risk formula calibration ships bad
  // signals — restored via env-var revert + redeploy in <5 minutes.
  // Default FALSE — at-risk widget enabled when F8 is live.
  FEATURE_F8_AT_RISK_DISABLED: booleanFromString.default(false),

  // HMAC primary signing key for renewal-link tokens (per FR-026 + R1).
  // Tokens are HMAC-SHA256 over a JSON payload {v,tid,mid,cid,iat,exp}.
  // ≥32 bytes of entropy. MUST be distinct from AUTH_COOKIE_SIGNING_SECRET
  // (F1) and UNSUBSCRIBE_TOKEN_SECRET (F7) so independent rotation does
  // not invalidate user sessions or marketing tokens.
  // Generate with: openssl rand -base64 48
  // SECRET — redacted in logs.
  RENEWAL_LINK_TOKEN_SECRET_PRIMARY: z.string().min(32).describe('SECRET — do not log'),

  // HMAC fallback signing key during dual-key rotation window per R16.
  // OPTIONAL — set ONLY during a 30-day rotation window:
  //   1. Generate new secret with `openssl rand -base64 48`.
  //   2. Set RENEWAL_LINK_TOKEN_SECRET_FALLBACK = <current PRIMARY value>.
  //   3. Set RENEWAL_LINK_TOKEN_SECRET_PRIMARY = <new value>.
  //   4. Redeploy. New tokens use PRIMARY; old in-flight tokens (TTL ≤30d)
  //      verify against FALLBACK.
  //   5. After 30 days, remove FALLBACK.
  // Steady state = only PRIMARY set. SECRET — redacted in logs.
  RENEWAL_LINK_TOKEN_SECRET_FALLBACK: z.string().min(32).optional().describe('SECRET — do not log'),

  // --- F6 EventCreate Integration -------------------------------------------
  // Kill-switch for F6 EventCreate Integration. When FALSE every
  // `/api/webhooks/eventcreate/v1/**`, `/api/admin/events/**`,
  // `/api/admin/integrations/eventcreate/**`, and the two F6 retention crons
  // return 503/404 `feature_disabled` via the kill-switch helper. Default
  // FALSE — F6 ships dark per `plan.md § Production gate`; flip to TRUE per
  // tenant after (a) Zapier setup wizard complete, (b) test-webhook
  // round-trip green, (c) maintainer co-signed security checklist.
  //
  // When TRUE at boot, `EVENTCREATE_PII_PSEUDONYM_SALT` MUST also be set
  // (≥32 bytes base64). The cross-field validator below refuses to start
  // when the flag is true but the salt is missing — this prevents the
  // FR-032 retention sweep from running with a default/empty salt and
  // accidentally producing non-deterministic / collidable pseudonyms.
  FEATURE_F6_EVENTCREATE: booleanFromString.default(false),

  // F6.1 sub-flag — controls the EventCreate-format CSV adapter at
  // `src/modules/events/infrastructure/eventcreate-csv-adapter.ts`. When
  // TRUE (default), the adapter detects EventCreate-format uploads via
  // the presence-of-6-required-columns heuristic (FR-001 / R2) and
  // routes them through the EventCreate column-mapping path. When
  // FALSE, the route forces the generic-CSV path even if EventCreate
  // signature is detected — rollback safety net per Spec § Rollback
  // Plan (>5 admin support issues attributable to F6.1 in first 7 days
  // post-launch triggers a flag-flip).
  //
  // Asymmetry note: this env-var follows the project-wide
  // `booleanFromString` helper (accepts `"true"`/`"1"` case-insensitive
  // trimmed). The form-field `force_proceed` in
  // `csv-import-eventcreate-api.md` accepts a wider set (`"true"`/`"1"`
  // /`"yes"`) for admin friendliness — intentional, do NOT harmonize.
  FEATURE_F6_EVENTCREATE_ADAPTER: booleanFromString.default(true),

  // Deterministic per-tenant pseudonymisation salt for the F6 non-member
  // PII retention sweep (FR-032 / SC-011). The cron emits sha256(salt ||
  // tenant_id || external_attendee_id) as the pseudonym, replacing the
  // raw attendee name + email + company in `event_registrations` rows
  // older than 2 years for non-member match types. Same salt MUST be
  // used for the lifetime of the deployment — rotating it would break
  // forensic linkage between historical pseudonyms and any subsequent
  // re-imports.
  //
  // ≥32 bytes raw entropy, base64-encoded. Generate with:
  //   openssl rand -base64 32
  //
  // OPTIONAL at the schema layer so dev/staging deployments without F6
  // enabled boot cleanly. The cross-field validator below ENFORCES that
  // the salt is set whenever `FEATURE_F6_EVENTCREATE=true`. SECRET —
  // redacted in logs (pino redact list extended for this exact env-var
  // name in `src/lib/logger.ts` T002).
  EVENTCREATE_PII_PSEUDONYM_SALT: z
    .string()
    .min(32)
    .optional()
    .describe('SECRET — do not log'),

  // Phase 5 review-fix W-06 (2026-05-13) — Zapier DPA execution flag.
  // F6 attendee PII transits Zapier (US) en route from EventCreate
  // (US) to Vercel sin1. PDPA §28 / GDPR Art. 28 require an executed
  // Data Processing Agreement with the third-party processor (Zapier)
  // before live attendee data flows. The DPIA outstanding-items list
  // (`docs/compliance/dpia-template.md`) tracks the legal task; this
  // env var is the technical backstop that refuses to boot when
  // `FEATURE_F6_EVENTCREATE=true` is set without ZAPIER_DPA_EXECUTED
  // = true, mirroring the `EVENTCREATE_PII_PSEUDONYM_SALT` pattern.
  // Default false — production deployments where F6 is dark are
  // unaffected.
  ZAPIER_DPA_EXECUTED: booleanFromString.default(false),

  // --- F7.1a Email Broadcast Advanced --------------------------------------
  // Master kill-switch for F7.1a (pagination + image embedding + multi-
  // template library). When FALSE every F7.1a-only surface short-circuits
  // and the F7 MVP 5k cap path remains active. Default FALSE — F7.1a
  // ships dark; flip TRUE only after ClamAV Fly.io deploy (T139) +
  // staging flag-matrix smoke test (T142) per quickstart.md § 9.
  FEATURE_F71A_BROADCAST_ADVANCED: booleanFromString.default(false),

  // Per-US flags — only have effect when the master flag is also TRUE.
  // Staged flip order (lowest risk → highest): US7 templates → US2 images
  // → US1 pagination. See tasks.md T143–T146.
  FEATURE_F71A_US1_PAGINATION: booleanFromString.default(false),
  FEATURE_F71A_US2_IMAGES: booleanFromString.default(false),
  FEATURE_F71A_US7_TEMPLATES: booleanFromString.default(false),

  // --- ClamAV virus scanner (US2 dependency) -------------------------------
  // Network address of the clamd daemon. Empty string in dev = US2 disabled.
  // In prod, points at the Fly.io private 6PN address (e.g.
  // "clamav-swecham.internal"). The clamav-virus-scanner adapter (Phase 2
  // T025) treats empty CLAMAV_HOST as `error` verdict and surfaces the
  // ClamAV-unreachable banner (T081). See infra/clamav/README.md.
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  // Scan timeout per file. FR-013 mandates conservative `error` verdict
  // on timeout — the use-case (T071 upload-inline-image) refuses to
  // persist the file.
  //
  // PR-review fix 2026-05-20 SF-H5 — default lowered from 300_000ms
  // (5 min) to 50_000ms (50 s) to fit inside the inline-image-upload
  // route's `maxDuration = 60`. The previous 300s ceiling created a
  // TOCTOU window: function timeout (60s) fires while ClamAV scan is
  // still running → orphaned scan eventually completes against bytes
  // that already passed the size cap → audit `broadcast_image_unsafe`
  // never fires for that path because the use-case awaited a verdict
  // the route had already abandoned. The 50s default leaves a 10s
  // headroom for Blob put + audit emit inside the function budget.
  // Deferred-F7.1b attachments may opt UP via env override (max 600_000ms).
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(50000),
  // Note: CLAMAV_SHARED_SECRET removed 2026-05-19 per /speckit.superb.critique
  // Important #1 — env var was documented as auth but never reached the
  // daemon (clamscan@2.4 doesn't support auth headers, Dockerfile has no
  // proxy). Fly.io 6PN private network is the security boundary in
  // production; dev mode runs in Docker localhost. No replacement env
  // var needed.

  // --- ClamAV HTTP scan-wrapper (Option D, 2026-05-22) ---------------------
  // Vercel functions cannot join Fly's IPv6-only 6PN private network, so
  // clamd is no longer reached over raw TCP. Instead the app POSTs bytes
  // to a public HTTPS scan-wrapper in front of clamd (bearer-authed).
  // See specs/014-email-broadcast-advance/clamav-vercel-connectivity.md.
  //
  // Full endpoint URL, e.g. https://clamav-swecham.fly.dev/scan . Empty
  // (default) ⇒ the adapter returns `error: unconfigured` (US2 disabled),
  // mirroring the old empty-CLAMAV_HOST contract. The legacy CLAMAV_HOST/
  // CLAMAV_PORT vars above are retained for the endpoint-resolver + dev
  // notes but are NOT used by the production adapter anymore.
  CLAMAV_SCAN_URL: z.string().default(''),
  // Bearer token presented to the scan-wrapper; MUST equal the Fly app's
  // CLAMAV_SCAN_SECRET secret (≥32 bytes). Empty when US2 is dark.
  // SECRET — do not log.
  CLAMAV_SCAN_SECRET: z.string().default('').describe('SECRET — do not log'),

  // --- F9 Admin Dashboard + Directory + Timeline + Audit --------------------
  // Kill-switch for F9. When FALSE the `/admin` page keeps the F1 placeholder,
  // F9 staff/member surfaces short-circuit, and the snapshot/export crons
  // return `{ skipped: true }`. Tables + cron ship dark first; flip to TRUE in
  // Vercel env after the Slice-A review gate (research R11). Default FALSE.
  FEATURE_F9_DASHBOARD: booleanFromString.default(false),

  // HMAC secret used to sign single-use, short-TTL (≤1 h) download tokens for
  // the private-artefact proxy (`/api/internal/exports/[jobId]/download`).
  // GDPR archives + Directory E-Books are stored in PRIVATE Vercel Blob and
  // streamed only after session + RBAC + constant-time token verification
  // (research R6, contracts/http-endpoints). ≥32 bytes of entropy; MUST be
  // distinct from AUTH_COOKIE_SIGNING_SECRET / UNSUBSCRIBE_TOKEN_SECRET /
  // RENEWAL_LINK_TOKEN_SECRET_* so independent rotation never invalidates a
  // different surface's tokens. Generate with: openssl rand -base64 48.
  //
  // OPTIONAL at the schema layer so deployments where F9 is dark (and local
  // Slice-A dev/tests, which never touch the export proxy) boot cleanly. The
  // cross-field validator below ENFORCES it (≥32 bytes) the moment
  // FEATURE_F9_DASHBOARD flips on — mirrors the F6 pseudonym-salt idiom.
  // SECRET — redacted in logs.
  EXPORT_DOWNLOAD_TOKEN_SECRET: z.string().min(32).optional().describe('SECRET — do not log'),
});

// --- Parse with grouped error reporting --------------------------------------

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return `  - ${path || '(root)'}: ${issue.message}`;
    })
    .join('\n');

  throw new Error(
    `Environment validation failed (src/lib/env.ts):\n${formatted}\n\n` +
      `Check .env.local against .env.example. The server will not start until ` +
      `every required variable is set.`,
  );
}

const raw = parsed.data;

// --- Cross-field normalisation ------------------------------------------------

// Prefer the unpooled URL for migrations; fall back to whatever the
// integration set.
const unpooledUrl =
  raw.DATABASE_URL_UNPOOLED ?? raw.POSTGRES_URL_NON_POOLING ?? raw.DATABASE_URL;

// Pick whichever Upstash variable was set.
const upstashUrl = raw.KV_REST_API_URL ?? raw.UPSTASH_REDIS_REST_URL;
const upstashToken = raw.KV_REST_API_TOKEN ?? raw.UPSTASH_REDIS_REST_TOKEN;

if (!upstashUrl || !upstashToken) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - missing Upstash credentials. Set either KV_REST_API_URL + KV_REST_API_TOKEN ' +
      '(Vercel KV) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (plain Upstash).',
  );
}

// F2: DEBUG_RLS_STATE must not be enabled in production — it's a dev-mode
// assertion that would add query overhead in prod and signals a
// configuration mistake. Fail fast rather than silently run with it.
if (raw.NODE_ENV === 'production' && raw.DEBUG_RLS_STATE) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - DEBUG_RLS_STATE must be false (or unset) when NODE_ENV=production. ' +
      'This flag is a development-time RLS safety net, not a production feature.',
  );
}

// F5: Stripe live/test environment assertion — the secret-key prefix
// MUST agree with STRIPE_LIVE_MODE so a misconfigured deploy cannot
// accidentally run live-mode transactions with a test key (or vice
// versa). Cross-checked at boot; fails loud before any request lands.
{
  const isLiveKey = raw.STRIPE_SECRET_KEY.startsWith('sk_live_');
  if (raw.STRIPE_LIVE_MODE !== isLiveKey) {
    throw new Error(
      'Environment validation failed (src/lib/env.ts):\n' +
        `  - STRIPE_LIVE_MODE=${raw.STRIPE_LIVE_MODE} disagrees with STRIPE_SECRET_KEY ` +
        `prefix (${isLiveKey ? 'sk_live_' : 'sk_test_'}). Both must agree: ` +
        'live-mode secret key ↔ STRIPE_LIVE_MODE=true, test-mode key ↔ false.',
    );
  }
  if (raw.NODE_ENV !== 'production' && raw.STRIPE_LIVE_MODE) {
    throw new Error(
      'Environment validation failed (src/lib/env.ts):\n' +
        '  - STRIPE_LIVE_MODE=true is only allowed when NODE_ENV=production. ' +
        'Dev/staging deployments must use sk_test_ keys to prevent accidental live charges.',
    );
  }
}

// F6: when FEATURE_F6_EVENTCREATE=true the deterministic pseudonymisation
// salt MUST also be set so the FR-032 retention sweep produces stable,
// non-collidable pseudonyms. The optional() at the schema layer keeps
// dev/staging deployments boot-clean when F6 is dark; this cross-field
// gate fails loud the moment a tenant flag-flips F6 on without providing
// the salt — surfaces the misconfiguration at boot, not silently at the
// first 03:00 cron pass that would write null-salt pseudonyms.
if (raw.FEATURE_F6_EVENTCREATE && !raw.EVENTCREATE_PII_PSEUDONYM_SALT) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - EVENTCREATE_PII_PSEUDONYM_SALT must be set (≥32 bytes base64) ' +
      'when FEATURE_F6_EVENTCREATE=true. Generate with: openssl rand -base64 32.',
  );
}

// Phase 5 review-fix W-06 (2026-05-13) — Zapier DPA technical backstop.
// F6 must NOT be flag-flipped to true in production until the Zapier
// DPA has been executed (PDPA §28 / GDPR Art. 28 cross-border
// safeguard for the US-resident processor). Once the legal team has
// the signed agreement on file, the operator sets ZAPIER_DPA_EXECUTED
// = true in Vercel env alongside the F6 flag flip. The boot refusal
// fires loud rather than silently allowing un-DPA'd attendee PII to
// transit Zapier — same posture as the pseudonym-salt guard above.
//
// Bypass in non-production (NODE_ENV ≠ production) is intentional so
// local dev + staging environments can iterate on F6 without
// requiring a DPA flag flip — but production refuses.
if (
  raw.NODE_ENV === 'production' &&
  raw.FEATURE_F6_EVENTCREATE &&
  !raw.ZAPIER_DPA_EXECUTED
) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - ZAPIER_DPA_EXECUTED must be true in production when ' +
      'FEATURE_F6_EVENTCREATE=true. F6 attendee PII transits Zapier; ' +
      'PDPA §28 / GDPR Art. 28 require an executed Data Processing ' +
      'Agreement before live data flows. See docs/compliance/dpia-template.md ' +
      'outstanding-items list. Set ZAPIER_DPA_EXECUTED=true in Vercel env ' +
      'after legal counsel confirms the DPA is signed and on file.',
  );
}

// T115t — E2E_X_TENANT_HEADER_ENABLED must NEVER be set in production.
// It lets an incoming request override the deployed tenant slug via
// the `X-Tenant` header, which is test-harness-only and would be a
// trivial tenant-enumeration vector if enabled in prod.
if (raw.NODE_ENV === 'production' && raw.E2E_X_TENANT_HEADER_ENABLED) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - E2E_X_TENANT_HEADER_ENABLED must be false (or unset) when NODE_ENV=production. ' +
      'This flag is a Playwright throwaway-tenant test harness, not a production feature. ' +
      'Enabling it in prod would allow any client to override the deployed tenant slug via the X-Tenant header.',
  );
}

// F9: when FEATURE_F9_DASHBOARD=true the export-download-token signing secret
// MUST be set so the private-artefact proxy can mint + verify single-use
// download tokens (research R6). optional() at the schema layer keeps F9-dark
// deployments + local Slice-A dev/tests boot-clean; this cross-field gate
// fails loud the moment a tenant flag-flips F9 on without the secret — surfaces
// the misconfiguration at boot, not at the first export download attempt.
if (raw.FEATURE_F9_DASHBOARD && !raw.EXPORT_DOWNLOAD_TOKEN_SECRET) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - EXPORT_DOWNLOAD_TOKEN_SECRET must be set (≥32 bytes) when ' +
      'FEATURE_F9_DASHBOARD=true. It signs single-use private-artefact ' +
      'download tokens. Generate with: openssl rand -base64 48.',
  );
}

// F9 (#13): EXPORT_DOWNLOAD_TOKEN_SECRET MUST be DISTINCT from the other
// token-signing secrets (per its schema docstring) so a leak/rotation of one
// secret never compromises another surface's tokens. The schema only enforces
// length (≥32); this is the cross-field distinctness gate. Checked whenever the
// secret is set (F9 on).
if (raw.EXPORT_DOWNLOAD_TOKEN_SECRET) {
  const collisions = (
    [
      ['AUTH_COOKIE_SIGNING_SECRET', raw.AUTH_COOKIE_SIGNING_SECRET],
      ['UNSUBSCRIBE_TOKEN_SECRET', raw.UNSUBSCRIBE_TOKEN_SECRET],
      ['RENEWAL_LINK_TOKEN_SECRET_PRIMARY', raw.RENEWAL_LINK_TOKEN_SECRET_PRIMARY],
      ['RENEWAL_LINK_TOKEN_SECRET_FALLBACK', raw.RENEWAL_LINK_TOKEN_SECRET_FALLBACK],
    ] as const
  ).filter(([, value]) => value === raw.EXPORT_DOWNLOAD_TOKEN_SECRET);
  if (collisions.length > 0) {
    throw new Error(
      'Environment validation failed (src/lib/env.ts):\n' +
        `  - EXPORT_DOWNLOAD_TOKEN_SECRET must be DISTINCT from ${collisions
          .map(([name]) => name)
          .join(', ')}. Reusing one secret across surfaces means a leak or ` +
        'rotation of one compromises the other. Generate a separate value: ' +
        'openssl rand -base64 48.',
    );
  }
}

// Bug #12 fix (2026-07-10): AUTH_COOKIE_SIGNING_SECRET MUST be DISTINCT from
// the token-signing secrets whose schema docstring already requires it — most
// notably UNSUBSCRIBE_TOKEN_SECRET ("MUST be distinct from
// AUTH_COOKIE_SIGNING_SECRET") — plus the renewal-link secrets. The per-field
// zod schema only enforces length (≥32); the EXPORT gate above covers the F9
// export secret; this covers the always-present AUTH pairing that was
// documented-but-unenforced, so an operator who copy-pastes one value into
// both surfaces fails loud at boot instead of silently coupling session-cookie
// signing to unsubscribe-token forgery. (We intentionally do NOT require the
// renewal primary ≠ fallback here — a shared value there is a valid
// pre-rotation state, and dev environments legitimately use it.)
if (raw.AUTH_COOKIE_SIGNING_SECRET) {
  const authCollisions = (
    [
      ['UNSUBSCRIBE_TOKEN_SECRET', raw.UNSUBSCRIBE_TOKEN_SECRET],
      ['RENEWAL_LINK_TOKEN_SECRET_PRIMARY', raw.RENEWAL_LINK_TOKEN_SECRET_PRIMARY],
      ['RENEWAL_LINK_TOKEN_SECRET_FALLBACK', raw.RENEWAL_LINK_TOKEN_SECRET_FALLBACK],
    ] as const
  ).filter(([, value]) => value === raw.AUTH_COOKIE_SIGNING_SECRET);
  if (authCollisions.length > 0) {
    throw new Error(
      'Environment validation failed (src/lib/env.ts):\n' +
        `  - AUTH_COOKIE_SIGNING_SECRET must be DISTINCT from ${authCollisions
          .map(([name]) => name)
          .join(', ')}. Reusing the session-cookie secret for a token surface ` +
        'means a leak or rotation of one compromises the other (e.g. forging ' +
        'unsubscribe tokens to suppress arbitrary addresses). Generate a ' +
        'separate value: openssl rand -base64 48.',
    );
  }
}

// Code-review follow-up (2026-07-11): close the pairwise gap the AUTH/EXPORT
// gates leave — UNSUBSCRIBE_TOKEN_SECRET vs the renewal-link secrets. The
// RENEWAL_LINK_TOKEN_SECRET_PRIMARY docstring states it MUST be distinct from
// UNSUBSCRIBE_TOKEN_SECRET, yet neither prior gate compared that pair. (We
// still do NOT compare RENEWAL primary vs fallback — a shared value there is a
// valid pre-rotation state used in dev.)
if (raw.UNSUBSCRIBE_TOKEN_SECRET) {
  const unsubCollisions = (
    [
      ['RENEWAL_LINK_TOKEN_SECRET_PRIMARY', raw.RENEWAL_LINK_TOKEN_SECRET_PRIMARY],
      ['RENEWAL_LINK_TOKEN_SECRET_FALLBACK', raw.RENEWAL_LINK_TOKEN_SECRET_FALLBACK],
    ] as const
  ).filter(([, value]) => value === raw.UNSUBSCRIBE_TOKEN_SECRET);
  if (unsubCollisions.length > 0) {
    throw new Error(
      'Environment validation failed (src/lib/env.ts):\n' +
        `  - UNSUBSCRIBE_TOKEN_SECRET must be DISTINCT from ${unsubCollisions
          .map(([name]) => name)
          .join(', ')}. Generate a separate value: openssl rand -base64 48.`,
    );
  }
}

// F9 (#8): in PRODUCTION the private-export Blob store MUST be a dedicated
// PRIVATE store — never the public BLOB_READ_WRITE_TOKEN store (which backs F4
// invoice PDFs + F9 logos). GDPR export archives + Directory E-Books carry full
// member PII; routing them to a public-access store would expose them outside the
// authenticated download proxy. The `?? raw.BLOB_READ_WRITE_TOKEN` fallback (in
// the `env.blob` object below) stays for dev/test/dark-launch ergonomics, but
// production fails loud the moment F9 is enabled without a dedicated private
// store — surfacing the misconfiguration at boot, not after PII has been written
// to the wrong store. Bypass in non-production is intentional (mirrors the F6 DPA
// + pseudonym-salt prod-only guards above).
if (
  raw.NODE_ENV === 'production' &&
  raw.FEATURE_F9_DASHBOARD &&
  (!raw.BLOB_PRIVATE_READ_WRITE_TOKEN ||
    // Absence is not enough — a copy-pasted token EQUAL to the public store
    // token resolves env.blob.privateReadWriteToken to the public store too, the
    // exact leak this guard prevents (F9 review). Reject equality as well.
    raw.BLOB_PRIVATE_READ_WRITE_TOKEN === raw.BLOB_READ_WRITE_TOKEN)
) {
  throw new Error(
    'Environment validation failed (src/lib/env.ts):\n' +
      '  - BLOB_PRIVATE_READ_WRITE_TOKEN must be set to a DEDICATED PRIVATE ' +
      'Vercel Blob store token — DISTINCT from the public BLOB_READ_WRITE_TOKEN ' +
      '— when FEATURE_F9_DASHBOARD=true in production. GDPR export archives + ' +
      'Directory E-Books carry member PII and must never resolve to the public ' +
      'store (T101a ship-day gate).',
  );
}

// --- Public, typed env object -------------------------------------------------

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  database: {
    url: raw.DATABASE_URL,
    unpooledUrl,
    /** Optional pool-size override. `null` → use per-env default in db.ts. */
    poolMax: raw.DATABASE_POOL_MAX ?? null,
  },

  upstash: {
    url: upstashUrl,
    token: upstashToken,
  },

  resend: {
    apiKey: raw.RESEND_API_KEY,
    webhookSigningSecret: raw.RESEND_WEBHOOK_SIGNING_SECRET,
    fromEmail: raw.RESEND_FROM_EMAIL,
  },

  auth: {
    cookieSigningSecret: raw.AUTH_COOKIE_SIGNING_SECRET,
  },

  app: {
    baseUrl: raw.APP_BASE_URL,
    allowedOrigins: raw.APP_ALLOWED_ORIGINS,
  },

  flags: {
    readOnlyMode: raw.READ_ONLY_MODE,
    // K14-9 (R13-S6): see schema docstring above.
    trustedReverseProxy: raw.TRUSTED_REVERSE_PROXY,
  },

  bootstrap: {
    adminEmail: raw.BOOTSTRAP_ADMIN_EMAIL,
  },

  log: {
    level: raw.LOG_LEVEL,
  },

  // Member-facing support contact (mailto on portal lapsed/invoice cards).
  supportEmail: raw.SUPPORT_EMAIL,

  // Billing / offline-payment contact recipients (mailto on the invoice-detail
  // "online payment unavailable" card). Prefer BILLING_CONTACT_EMAILS; fall back
  // to the general SUPPORT_EMAIL (always present) so the CTA is never dead.
  // Always a non-empty `string[]`.
  billingContactEmails:
    raw.BILLING_CONTACT_EMAILS && raw.BILLING_CONTACT_EMAILS.length > 0
      ? raw.BILLING_CONTACT_EMAILS
      : [raw.SUPPORT_EMAIL],

  // F2: Single-tenant deployment — constant resolved by
  // `src/lib/tenant-context.ts` for every request. Extended in F10
  // when a real subdomain resolver replaces the constant.
  tenant: {
    slug: raw.TENANT_SLUG,
    timezone: raw.TENANT_TIMEZONE,
    debugRlsState: raw.DEBUG_RLS_STATE,
    // T115t — Playwright throwaway-tenant harness. Guarded at boot
    // (refused in production, see validator above) + runtime-checked
    // by `resolveTenantFromRequest` before honouring the X-Tenant
    // header.
    xHeaderEnabled: raw.E2E_X_TENANT_HEADER_ENABLED,
  },

  // F3 + F4 + F5 + F7 + F7.1a + F8 feature flags
  features: {
    f3Members: raw.FEATURE_F3_MEMBERS,
    f4Invoicing: raw.FEATURE_F4_INVOICING,
    f4VoidAttachment: raw.FEATURE_F4_VOID_ATTACHMENT,
    f5OnlinePayment: raw.FEATURE_F5_ONLINE_PAYMENT,
    f5AsyncReceiptPdf: raw.FEATURE_F5_ASYNC_RECEIPT_PDF,
    f7Broadcasts: raw.FEATURE_F7_BROADCASTS,
    // F7.1a master + per-US flags. Adapters MUST check the master flag
    // before per-US flags (per-US flags only have effect when master ON).
    f71aBroadcastAdvanced: raw.FEATURE_F71A_BROADCAST_ADVANCED,
    f71aUs1Pagination: raw.FEATURE_F71A_US1_PAGINATION,
    f71aUs2Images: raw.FEATURE_F71A_US2_IMAGES,
    f71aUs7Templates: raw.FEATURE_F71A_US7_TEMPLATES,
    f8Renewals: raw.FEATURE_F8_RENEWALS,
    f8AtRiskDisabled: raw.FEATURE_F8_AT_RISK_DISABLED,
    // COMP-1 US2d — member-erasure reconciliation sweep kill-switch.
    memberErasureReconcile: raw.FEATURE_MEMBER_ERASURE_RECONCILE,
    f6EventCreate: raw.FEATURE_F6_EVENTCREATE,
    f6EventCreateAdapter: raw.FEATURE_F6_EVENTCREATE_ADAPTER,
    f9Dashboard: raw.FEATURE_F9_DASHBOARD,
    // 088 — §87-at-payment tax flow (bill → ใบแจ้งหนี้) + US8 zero-rate UI.
    // Default false; ships dark. See schema docstring above + plan § Rollout.
    f088TaxAtPayment: raw.FEATURE_088_TAX_AT_PAYMENT,
  },

  // F4 Invoicing
  blob: {
    readWriteToken: raw.BLOB_READ_WRITE_TOKEN,
    // F9 private-export store token. Falls back to the public read/write token
    // ONLY in dev/test/dark-launch — the cross-field guard above (F9 #8) makes
    // this fallback a hard boot error in production when F9 is enabled, so PII
    // export archives can never be written to the public store. Ship-day operator
    // sets BLOB_PRIVATE_READ_WRITE_TOKEN to the private store before enabling
    // exports (T101a). Only `private-blob-adapter.ts` reads it.
    privateReadWriteToken:
      raw.BLOB_PRIVATE_READ_WRITE_TOKEN ?? raw.BLOB_READ_WRITE_TOKEN,
  },
  cron: {
    secret: raw.CRON_SECRET,
  },

  // F5 Online Payment (Stripe)
  stripe: {
    secretKey: raw.STRIPE_SECRET_KEY,
    publishableKey: raw.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    webhookSecret: raw.STRIPE_WEBHOOK_SECRET,
    apiVersion: raw.STRIPE_API_VERSION,
    accountIdSwecham: raw.STRIPE_ACCOUNT_ID_SWECHAM,
    liveMode: raw.STRIPE_LIVE_MODE,
  },

  // F7 Email Broadcast (Resend Broadcasts API surface — distinct from
  // F1+F4 transactional `resend.*`). Webhook + unsubscribe-token
  // secrets are kept here so the F7 module can read them via a single
  // namespaced accessor (`env.broadcasts.*`) without coupling to the
  // transactional Resend block.
  broadcasts: {
    apiKey: raw.RESEND_BROADCASTS_API_KEY,
    webhookSecret: raw.RESEND_BROADCASTS_WEBHOOK_SECRET,
    unsubscribeTokenSecret: raw.UNSUBSCRIBE_TOKEN_SECRET,
    fromEmail: raw.BROADCASTS_FROM_EMAIL,
    // F7 UX-5/UX-6 — optional tenant URLs (gracefully omitted when unset).
    privacyPolicyUrl: raw.TENANT_PRIVACY_POLICY_URL,
    websiteUrl: raw.TENANT_WEBSITE_URL,
  },

  // F8 Renewal Tracking + Smart Reminders. F8 reuses F1+F4 transactional
  // Resend (`env.resend.*`) for renewal reminder emails — NOT F7's
  // Broadcasts API surface (renewal reminders are TRANSACTIONAL per
  // FR-019, not marketing). Only F8-specific secrets live here:
  // renewal-link HMAC keys for member self-service token verification
  // (per R1 + R16 dual-key rotation). `linkTokenSecretFallback` is null
  // outside the rotation window (steady state = only PRIMARY set).
  renewals: {
    linkTokenSecretPrimary: raw.RENEWAL_LINK_TOKEN_SECRET_PRIMARY,
    linkTokenSecretFallback: raw.RENEWAL_LINK_TOKEN_SECRET_FALLBACK ?? null,
  },

  // F6 EventCreate Integration. The salt is `null` when the F6 flag is
  // false (allowed at boot per the cross-field validator above) and a
  // non-empty string when the flag is true. Consumers in the retention
  // sweep cron (`pseudonymise-stale-non-member-pii.ts`) MUST narrow
  // before using — a runtime null-check is intentional defence-in-depth
  // against a future contributor enabling F6 without redeploying.
  eventcreate: {
    piiPseudonymSalt: raw.EVENTCREATE_PII_PSEUDONYM_SALT ?? null,
    // Phase 5 review-fix W-06 — exposed for compliance audit + DPIA
    // automation. Consumers should NOT branch on this at request time
    // (the boot guard already refused to start when this is false in
    // production with F6 on). Surfaced here so a dedicated
    // `/api/admin/health` style endpoint or a CLI helper can read the
    // executed-DPA status without reaching back into env.ts.
    zapierDpaExecuted: raw.ZAPIER_DPA_EXECUTED,
  },

  // F7.1a US2 — ClamAV virus scanner connection settings. The clamav-
  // virus-scanner adapter (Phase 2 T025) consumes this block. Empty
  // `host` ⇒ adapter returns `error` verdict.
  //
  // PR-review fix 2026-05-21 R4-L1 — auth boundary is Fly.io 6PN
  // private network, not an env-var shared secret. `CLAMAV_SHARED_SECRET`
  // was removed 2026-05-19 per the `clamav-virus-scanner` superb
  // critique (see env.ts:511-516 comment for the rationale: clamscan@2.4
  // doesn't support auth headers, Dockerfile has no proxy, so the env
  // var was documented as auth but never reached the daemon). See
  // infra/clamav/README.md for deploy procedure + 6PN topology.
  clamav: {
    host: raw.CLAMAV_HOST,
    port: raw.CLAMAV_PORT,
    timeoutMs: raw.CLAMAV_TIMEOUT_MS,
    // Option D HTTP scan-wrapper (2026-05-22).
    scanUrl: raw.CLAMAV_SCAN_URL,
    scanSecret: raw.CLAMAV_SCAN_SECRET,
  },

  // F9 Admin Dashboard — kill-switch + private-artefact download-token secret.
  // The `insights` bounded context reads `exportDownloadTokenSecret` to sign /
  // verify single-use download tokens for the private Blob proxy (research R6).
  insights: {
    // `null` when F9 is dark (boot-clean per the cross-field gate above); a
    // ≥32-byte string once FEATURE_F9_DASHBOARD flips on. The download-proxy
    // route (Slice B) MUST narrow before signing/verifying.
    exportDownloadTokenSecret: raw.EXPORT_DOWNLOAD_TOKEN_SECRET ?? null,
  },
} as const;

export type Env = typeof env;
