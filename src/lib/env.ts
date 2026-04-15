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
  DEBUG_RLS_STATE: booleanFromString.default(false),

  // --- F3 Feature flag ------------------------------------------------------
  // Kill-switch for the Members & Contacts feature. When FALSE every
  // `/api/members/**` and `/api/portal/**` route returns 503 `read_only_mode`
  // via the feature-flag guard (T036/T037). Default TRUE so normal
  // deployments pick up the feature; set to FALSE in Vercel env to
  // temporarily disable without a code deploy.
  FEATURE_F3_MEMBERS: booleanFromString.default(true),
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

// --- Public, typed env object -------------------------------------------------

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  database: {
    url: raw.DATABASE_URL,
    unpooledUrl,
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
  },

  // F3 feature flags
  features: {
    f3Members: raw.FEATURE_F3_MEMBERS,
  },
} as const;

export type Env = typeof env;
