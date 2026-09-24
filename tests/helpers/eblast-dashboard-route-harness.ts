/**
 * F119 Phase 6 — the shared harness for the dashboard contract tests
 * (T109 / T110 / T112 / T113) over `GET /api/admin/broadcasts`.
 *
 * The route runs for real; its seams are replaced:
 *   - `@/lib/rbac`           — `requireApiPermission` answers the session of
 *                              `dash.role` (the REAL evaluator decides whether
 *                              that role holds `broadcasts.read`);
 *   - `@/lib/tenant-context` — one tenant;
 *   - `@/lib/db`             — `runInTenant` hands the callback a recording
 *                              `tx` whose `execute` answers the member-name
 *                              projection and the pending count by SQL text;
 *   - `@/modules/broadcasts` — the REAL Domain stage/turn/status modules, plus
 *                              the list repo, the queue reads and the flag as
 *                              doubles over `dash`.
 *
 * Use it from a test file with:
 *   vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-dashboard-route-harness')).rbacMock());
 *   … (see any `eblast-dashboard-*.test.ts`).
 */
import { vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

export const DASH_TENANT = 'test-tenant';

export interface DeliveryCountsDouble {
  readonly recipients: number;
  readonly delivered: number;
  readonly bounced: number;
  readonly complained: number;
}

export interface ListCall {
  readonly tenantId: string;
  readonly opts: Record<string, unknown>;
}

export const dash = {
  role: 'admin' as string,
  rows: [] as Broadcast[],
  counts: {} as Partial<Record<BroadcastStatus, number>>,
  deliveries: new Map<string, DeliveryCountsDouble>(),
  memberNames: new Map<string, string>(),
  flag: false,
  listCalls: [] as ListCall[],
  deliveryCalls: [] as string[][],
  sqlTexts: [] as string[],
};

export function resetDashboard(): void {
  dash.role = 'admin';
  dash.rows = [];
  dash.counts = {};
  dash.deliveries = new Map();
  dash.memberNames = new Map();
  dash.flag = false;
  dash.listCalls = [];
  dash.deliveryCalls = [];
  dash.sqlTexts = [];
}

/** The statement text of a drizzle `sql` object (StringChunks joined, params as `?`). */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'value' in c) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : ' ? ';
      }
      if (typeof c === 'object' && c !== null && 'queryChunks' in c) return sqlText(c);
      return ' ? ';
    })
    .join('');
}

const recordingTx = {
  execute: async (q: unknown) => {
    const text = sqlText(q);
    dash.sqlTexts.push(text);
    if (/FROM\s+members/i.test(text)) {
      return [...dash.memberNames.entries()].map(([member_id, company_name]) => ({ member_id, company_name }));
    }
    if (/COUNT\(\*\)/i.test(text)) {
      return [{ n: dash.rows.filter((r) => r.status === 'submitted').length }];
    }
    return [];
  },
};

export function dbMock() {
  return {
    runInTenant: async (_ctx: unknown, fn: (tx: typeof recordingTx) => unknown) => fn(recordingTx),
  };
}

export function rbacMock() {
  return {
    requireApiPermission: async (_req: unknown, key: string) => {
      if (!hasPermission(dash.role as never, key as never)) {
        return { response: NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 }) };
      }
      return {
        current: {
          user: { id: 'user-staff-1', email: 'staff@swecham.test', role: dash.role, status: 'active', displayName: 'Staff' },
          session: { id: 'sess-staff-1' },
        },
        sourceIp: '203.0.113.10',
        requestId: 'req-dash-1',
      };
    },
  };
}

export function tenantContextMock() {
  return { resolveTenantFromRequest: () => ({ slug: DASH_TENANT, __brand: true }) };
}

export function loggerMock() {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
}

/** The broadcasts barrel: the REAL Domain stage vocabulary + doubles over `dash`. */
export async function broadcastsBarrelMock() {
  const status = await import('@/modules/broadcasts/domain/value-objects/broadcast-status');
  const stage = await import('@/modules/broadcasts/domain/stage/broadcast-stage');
  const turn = await import('@/modules/broadcasts/domain/stage/whose-turn');
  const inProgress = await import('@/modules/broadcasts/domain/stage/in-progress-statuses');
  const age = await import('@/modules/broadcasts/domain/stage/stage-age');
  return {
    ...status,
    ...stage,
    ...turn,
    ...inProgress,
    ...age,
    isEblastMemberApprovalEnabled: () => dash.flag,
    makeGetBroadcastDeps: () => ({
      broadcastsRepo: {
        listByTenantStatus: async (tenantId: string, opts: Record<string, unknown>) => {
          dash.listCalls.push({ tenantId, opts });
          const filter = opts['statusFilter'] as readonly string[] | undefined;
          const rows = filter === undefined ? dash.rows : dash.rows.filter((r) => filter.includes(r.status));
          return { rows, nextCursor: null };
        },
      },
    }),
    makeBroadcastQueueReads: () => ({
      countByStatus: async () =>
        Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, dash.counts[s] ?? 0])) as Record<BroadcastStatus, number>,
      deliveryCountsFor: async (_ctx: unknown, ids: readonly string[]) => {
        dash.deliveryCalls.push([...ids]);
        return new Map([...dash.deliveries.entries()].filter(([id]) => ids.includes(id)));
      },
    }),
  };
}

export async function importListRoute() {
  return import('@/app/api/admin/broadcasts/route');
}

export function listRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/admin/broadcasts${query}`, { method: 'GET' });
}

/** GET the list and parse the body. */
export async function getQueue(query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await importListRoute();
  const res = await GET(listRequest(query));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
