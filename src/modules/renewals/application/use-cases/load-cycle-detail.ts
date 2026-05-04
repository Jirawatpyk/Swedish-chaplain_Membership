/**
 * F8 Phase 3 Wave H2 · T057 — `load-cycle-detail` use-case.
 *
 * Returns one renewal cycle's full detail view for `/admin/renewals/[cycleId]`.
 *
 * For Phase 3 (US1):
 *   - `reminderHistory` returns `[]` — Phase 4 ships the dispatcher cron
 *     that produces real reminder rows.
 *   - `escalationTasks` returns `[]` — Phase 8 ships escalation queue.
 *   - `linkedInvoice` is hydrated via F4 barrel `getInvoice` if
 *     `cycle.linkedInvoiceId` is non-null (mark-paid-offline ships a
 *     populated linked invoice in this phase).
 *
 * Cross-tenant semantics: `cyclesRepo.findById` returns `null` for
 * cross-tenant probes (RLS hides the row). The use-case emits a
 * `renewal_cross_tenant_probe` audit on `null` regardless of cause —
 * we cannot distinguish "truly missing" from "RLS-hidden" at the
 * application layer; the audit is defensive (Constitution Principle I
 * clause 4) + a no-op on legitimate not-found requests.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  parseCycleId,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';

export const loadCycleDetailInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.enum(['admin', 'manager']),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type LoadCycleDetailInput = z.infer<typeof loadCycleDetailInputSchema>;

export interface LoadCycleDetailOutput {
  readonly cycle: RenewalCycle;
  readonly reminderHistory: ReadonlyArray<unknown>;
  readonly escalationTasks: ReadonlyArray<unknown>;
  readonly linkedInvoice: {
    readonly invoiceId: string;
    readonly invoiceNumber: string | null;
    readonly status: string;
    readonly totalSatang: bigint;
  } | null;
}

export type LoadCycleDetailError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' };

export async function loadCycleDetail(
  deps: RenewalsDeps,
  rawInput: LoadCycleDetailInput,
): Promise<Result<LoadCycleDetailOutput, LoadCycleDetailError>> {
  const parsed = loadCycleDetailInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;

  const cycleIdResult = parseCycleId(input.cycleId);
  if (!cycleIdResult.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdResult.value;

  const cycle = await deps.cyclesRepo.findById(input.tenantId, cycleId);
  if (!cycle) {
    // Probe audit — emits on either cross-tenant attempt OR truly
    // missing cycle. The latter is harmless noise; the former is the
    // attack signal we want to surface.
    await deps.auditEmitter.emit(
      {
        type: 'renewal_cross_tenant_probe',
        payload: {
          attempted_cycle_id: cycleId,
          route: 'load-cycle-detail',
        },
      },
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
      },
    );
    return err({ kind: 'cycle_not_found' });
  }

  // Hydrate linked invoice if present.
  let linkedInvoice: LoadCycleDetailOutput['linkedInvoice'] = null;
  if (cycle.linkedInvoiceId) {
    const invoiceDeps = makeGetInvoiceDeps(input.tenantId);
    const invoiceResult = await getInvoice(invoiceDeps, {
      tenantId: input.tenantId,
      invoiceId: cycle.linkedInvoiceId,
      actor: {
        userId: input.actorUserId,
        role: input.actorRole,
        requestId: input.requestId ?? null,
      },
    });
    if (invoiceResult.ok) {
      const inv = invoiceResult.value;
      linkedInvoice = {
        invoiceId: cycle.linkedInvoiceId,
        invoiceNumber: inv.documentNumber as string | null,
        status: inv.status,
        totalSatang: inv.total?.satang ?? 0n,
      };
    } else {
      // F4 reported not-found / forbidden — surface stub so UI can
      // still link out without breaking the page.
      linkedInvoice = {
        invoiceId: cycle.linkedInvoiceId,
        invoiceNumber: null,
        status: 'unknown',
        totalSatang: 0n,
      };
    }
  }

  return ok({
    cycle,
    reminderHistory: [],
    escalationTasks: [],
    linkedInvoice,
  });
}
