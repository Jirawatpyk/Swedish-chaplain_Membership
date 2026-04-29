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

  // Bootstrap (used only by scripts/seed-bootstrap-admin.ts)
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),

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

  // Pinned Stripe API version (e.g. `2025-09-30.basil`). Passed to
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

  // HMAC secret used to sign one-click unsubscribe tokens. ≥32 bytes of
  // entropy. MUST be distinct from `AUTH_COOKIE_SIGNING_SECRET` (per
  // research.md § 4) so token rotation does not invalidate user sessions.
  // Tokens are valid forever (FR-030 idempotency — replays are safe).
  // Generate with: openssl rand -base64 48
  // SECRET — redacted in logs.
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32).describe('SECRET — do not log'),

  // Kill-switch for F7 Email Broadcast. When FALSE every
  // `/api/broadcasts/**` and `/api/admin/broadcasts/**` route returns
  // 503 `feature_disabled` via the kill-switch helper (T031). Default
  // FALSE — F7 ships dark; flip to TRUE in Vercel env after the F7
  // release gate. Mid-flight broadcasts (status `submitted`/`approved`)
  // remain visible to admins for completion/rejection per FR-002 +
  // Spec § Edge Cases L341.
  FEATURE_F7_BROADCASTS: booleanFromString.default(false),
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
  },

  bootstrap: {
    adminEmail: raw.BOOTSTRAP_ADMIN_EMAIL,
  },

  log: {
    level: raw.LOG_LEVEL,
  },

  // F2: Single-tenant deployment — constant resolved by
  // `src/lib/tenant-context.ts` for every request. Extended in F10
  // when a real subdomain resolver replaces the constant.
  tenant: {
    slug: raw.TENANT_SLUG,
    debugRlsState: raw.DEBUG_RLS_STATE,
    // T115t — Playwright throwaway-tenant harness. Guarded at boot
    // (refused in production, see validator above) + runtime-checked
    // by `resolveTenantFromRequest` before honouring the X-Tenant
    // header.
    xHeaderEnabled: raw.E2E_X_TENANT_HEADER_ENABLED,
  },

  // F3 + F4 + F5 + F7 feature flags
  features: {
    f3Members: raw.FEATURE_F3_MEMBERS,
    f4Invoicing: raw.FEATURE_F4_INVOICING,
    f4VoidAttachment: raw.FEATURE_F4_VOID_ATTACHMENT,
    f5OnlinePayment: raw.FEATURE_F5_ONLINE_PAYMENT,
    f5AsyncReceiptPdf: raw.FEATURE_F5_ASYNC_RECEIPT_PDF,
    f7Broadcasts: raw.FEATURE_F7_BROADCASTS,
  },

  // F4 Invoicing
  blob: {
    readWriteToken: raw.BLOB_READ_WRITE_TOKEN,
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
  },
} as const;

export type Env = typeof env;
