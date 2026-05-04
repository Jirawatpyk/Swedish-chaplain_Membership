/**
 * F8 Phase 3 Wave H3 · T066 contract test —
 * POST `/api/admin/renewals/[cycleId]/mark-paid-offline`.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const markPaidOfflineMock = vi.fn();
const f8FeatureFlag = { value: true };

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') {
          return { ...target.features, f8Renewals: f8FeatureFlag.value };
        }
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/renewals-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/renewals-route-helpers')
  >('@/lib/renewals-route-helpers');
  return {
    ...actual,
    requireRenewalAdminContext: (...args: unknown[]) =>
      requireRenewalAdminContextMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    markPaidOffline: (...args: unknown[]) => markPaidOfflineMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-4',
  correlationId: 'corr-4',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000c6';

function makeBody(overrides?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    payment_method: 'bank_transfer',
    payment_reference: 'BT-2026-0042',
    payment_date: '2026-05-15',
    ...(overrides ?? {}),
  });
}

function makeReq(body: string | null = null): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/${VALID_UUID}/mark-paid-offline`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? makeBody(),
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/[cycleId]/mark-paid-offline/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/[cycleId]/mark-paid-offline — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Round 7 test-infra fix — first test of each F8 contract file
  // cold-loads the route handler chain (transitively imports
  // @node-rs/argon2 + Upstash + Stripe SDK + react-pdf). Under heavy
  // parallel load (`pnpm test` full suite ~314 files), the cold-load
  // can exceed the 10s default per-test timeout. 30s ceiling matches
  // the F4+F5 barrel-test precedent at vitest.config.ts:42-46.
  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
  });

  it('200 happy path', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed',
        invoiceId: 'inv-1',
        newExpiresAt: '2028-06-01T00:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle_status).toBe('completed');
    expect(body.invoice_id).toBe('inv-1');
    expect(body.new_expires_at).toBe('2028-06-01T00:00:00.000Z');
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
  });

  it('400 invalid_body on bad payment_method', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_method: 'crypto' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body on bad payment_date format', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_date: '15-05-2026' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 cycle_not_payable with current_status', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_payable', currentStatus: 'completed' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.current_status).toBe('completed');
  });

  it('502 f4_failure with reason AND stage scrubbed (W-02 + B-R7-1)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({
        kind: 'f4_failure',
        stage: 'create_invoice_failed',
        reason: 'plan_not_found',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('f4_failure');
    // Round 6 B-R5-2 — Round 5 W-02 scrubs the F4-internal `reason`
    // from the HTTP response body so internal schema / column / row
    // fragments cannot leak to the admin UI. Reason is logged
    // server-side via `logger.warn` for ops triage.
    expect(body.error).not.toHaveProperty('reason');
    // Round 8 B-R7-1 — also scrub `stage` from response body. Round 7
    // W-R6-4 redacted `f4Stage` in logs but pino redaction does NOT
    // apply to `NextResponse.json`. Stage names embed F4 internal
    // use-case identifiers (`create_invoice_failed` etc.) — keeping
    // them off the wire closes the W-R6-4 incomplete-fix gap.
    expect(body.error).not.toHaveProperty('stage');
  });

  it('400 invalid_body when payment_reference is PAN-like (W-01)', async () => {
    // Round 6 S-R5-2 — contract-layer guard so a future regression
    // that drops the zod `refine` cannot land silently. 16 consecutive
    // digits = canonical raw-paste card-number error pattern.
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: '4111111111111111' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(markPaidOfflineMock).not.toHaveBeenCalled();
  });

  // Round 7 W-R6-5 — PAN regex boundary tests. The regex is `\d{13,}`
  // so 12 digits should pass, 13+ should reject. These pin the
  // boundary so a future change to `\d{14,}` (or similar) is caught.
  it.each([
    { len: 12, raw: '1'.repeat(12), expected: 'allow' as const },
    { len: 13, raw: '1'.repeat(13), expected: 'reject' as const },
    { len: 19, raw: '1'.repeat(19), expected: 'reject' as const },
    { len: 20, raw: '1'.repeat(20), expected: 'reject' as const },
  ])('PAN regex boundary: $len-digit reference is $expected', async ({ raw, expected }) => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    if (expected === 'allow') {
      markPaidOfflineMock.mockResolvedValueOnce(
        ok({
          cycleStatus: 'completed' as const,
          invoiceId: 'inv-1',
          newExpiresAt: '2027-06-01T00:00:00Z',
        }),
      );
    }
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: raw })),
      makeCtx(),
    );
    expect(res.status).toBe(expected === 'allow' ? 200 : 400);
  });

  // Round 7 B-R6-2 — Unicode digit substitute bypass guard. NFKD does
  // NOT decompose Arabic-Indic / Devanagari / Thai digits, and the
  // non-ASCII strip removes them entirely; Round 6's pass-1 regex
  // alone would silently accept these. Round 7 adds a pass-2 regex
  // that scans the original raw input for script-digit blocks.
  it.each([
    { script: 'Arabic-Indic', raw: '٤'.repeat(16) },
    { script: 'Eastern Arabic-Indic', raw: '۴'.repeat(16) },
    { script: 'Devanagari', raw: '४'.repeat(16) },
    { script: 'Thai', raw: '๔'.repeat(16) },
    // Round 8 W-R7-3 — Mathematical Bold Digits 𝟒 (U+1D7D2). Realistic
    // operator-paste vector via rich-text editors / spreadsheets.
    // 4-byte SMP codepoints — `.repeat(16)` yields 32 UTF-16 code
    // units but 16 actual digit codepoints; `/u` flag handles the
    // surrogate pairs.
    { script: 'Mathematical Bold', raw: '𝟒'.repeat(16) },
  ])('400 invalid_body when payment_reference uses $script digits (B-R6-2 + W-R7-3)', async ({ raw }) => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: raw })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(markPaidOfflineMock).not.toHaveBeenCalled();
  });

  // Round 7 S-R6-4 / W-R6-2 — document the accepted trade-off that
  // hyphen- and space-separated PANs slip through the guard
  // (max consecutive digit run is 4, below the 13-digit threshold).
  // This test makes the gap visible in coverage so a future review
  // is aware that the workflow's confirmation toast is the second
  // line of defence, not the regex.
  it.each([
    { sep: 'hyphens', raw: '4111-1111-1111-1111' },
    { sep: 'spaces', raw: '4111 1111 1111 1111' },
  ])('allows separator-formatted PAN with $sep (accepted trade-off — see route.ts comment)', async ({ raw }) => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed' as const,
        invoiceId: 'inv-1',
        newExpiresAt: '2027-06-01T00:00:00Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: raw })),
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it('200 happy path accepts Thai bank reference format YYYYMMDD-NNNNN (B-R5-1 regression guard)', async () => {
    // Round 6 B-R5-1 — Round 5's PAN regex `(\d[\s-]?){13,19}` falsely
    // blocked legitimate Thai bank reference format. The fixed regex
    // requires 13+ CONSECUTIVE digits (no separators) so this passes.
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed' as const,
        invoiceId: 'inv-1',
        newExpiresAt: '2027-06-01T00:00:00Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: 'KTB-20260504-12345' })),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(markPaidOfflineMock).toHaveBeenCalled();
  });
});
