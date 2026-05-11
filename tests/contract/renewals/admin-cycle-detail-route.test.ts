/**
 * F8 Phase 3 Wave H3 · T064 contract test — GET `/api/admin/renewals/[cycleId]`.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const loadCycleDetailMock = vi.fn();
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
    loadCycleDetail: (...args: unknown[]) => loadCycleDetailMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-2',
  correlationId: 'corr-2',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000c3';

function makeReq(): NextRequest {
  return new NextRequest(`http://localhost/api/admin/renewals/${VALID_UUID}`);
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/renewals/[cycleId]/route');
  return mod.GET;
}

const FAKE_CYCLE = {
  cycleId: VALID_UUID,
  memberId: 'm1',
  status: 'awaiting_payment' as const,
  periodFrom: '2026-06-01T00:00:00.000Z',
  periodTo: '2027-06-01T00:00:00.000Z',
  expiresAt: '2027-06-01T00:00:00.000Z',
  cycleLengthMonths: 12,
  tierAtCycleStart: 'regular',
  planIdAtCycleStart: 'p1',
  frozenPlanPriceThb: '50000.00',
  frozenPlanTermMonths: 12,
  frozenPlanCurrency: 'THB' as const,
  enteredPendingAt: null,
  linkedInvoiceId: null,
  linkedCreditNoteId: null,
  closedAt: null,
  closedReason: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

describe('GET /api/admin/renewals/[cycleId] — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Round 7 test-infra fix — see admin-mark-paid-offline-route.test.ts
  // for rationale (cold-load timeout under heavy parallel load).
  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const GET = await loadHandler();
    const res = await GET(makeReq(), makeCtx());
    expect(res.status).toBe(503);
  });

  it('200 happy path with snake_case mapping', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadCycleDetailMock.mockResolvedValueOnce(
      ok({
        cycle: FAKE_CYCLE,
        reminderHistory: [],
        escalationTasks: [],
        linkedInvoice: null,
      }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle.cycle_id).toBe(VALID_UUID);
    expect(body.cycle.tier_at_cycle_start).toBe('regular');
    expect(body.cycle.frozen_plan_price_thb).toBe('50000.00');
    expect(body.linked_invoice).toBeNull();
  });

  it('serialises linked_invoice with bigint→string', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadCycleDetailMock.mockResolvedValueOnce(
      ok({
        cycle: FAKE_CYCLE,
        reminderHistory: [],
        escalationTasks: [],
        linkedInvoice: {
          invoiceId: 'inv-1',
          invoiceNumber: 'INV-2026-0001',
          status: 'paid',
          totalSatang: 5000000n,
        },
      }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(), makeCtx());
    const body = await res.json();
    expect(body.linked_invoice.invoice_number).toBe('INV-2026-0001');
    expect(body.linked_invoice.total_satang).toBe('5000000');
  });

  it('404 when cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadCycleDetailMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_found' }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(), makeCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('cycle_not_found');
  });

  it('400 on invalid_input', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadCycleDetailMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'invalid cycle id' }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_cycle_id');
  });
});
