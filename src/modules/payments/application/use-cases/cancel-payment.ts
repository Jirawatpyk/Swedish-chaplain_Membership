/**
 * T059 — cancelPayment use-case (F5 / payments-api.md § 2).
 *
 * Member-initiated cancel of own pending payment.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { isAllowed, type F5Role } from '../../domain/rbac-policy';
import type { PaymentId } from '../../domain/payment';

export interface CancelPaymentInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: F5Role;
  readonly actorMemberId: string;
  readonly paymentId: PaymentId;
  readonly requestId: string | null;
}

export interface CancelPaymentSuccess {
  readonly paymentId: PaymentId;
  readonly status: 'canceled';
  readonly completedAt: string; // ISO
}

export type CancelPaymentError =
  | { readonly code: 'forbidden_role' }
  | { readonly code: 'payment_not_found' }
  | { readonly code: 'forbidden_payment' }
  | { readonly code: 'payment_not_cancelable'; readonly currentStatus: string }
  | { readonly code: 'processor_unavailable'; readonly reason: string };

export interface CancelPaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export async function cancelPayment(
  deps: CancelPaymentDeps,
  input: CancelPaymentInput,
): Promise<Result<CancelPaymentSuccess, CancelPaymentError>> {
  if (!isAllowed(input.actorRole, 'payments', 'cancel-own')) {
    return err({ code: 'forbidden_role' });
  }

  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    return err({ code: 'processor_unavailable', reason: 'tenant_settings_missing' });
  }

  return await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdate(
      tx,
      input.paymentId,
      input.tenantId,
    );
    if (!payment) {
      // Cross-tenant probe audit (best-effort outside tx — the row is
      // invisible under RLS so we don't know if it's missing or hidden).
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on payment ${input.paymentId} (not found / not owned)`,
        payload: {
          subject_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: input.paymentId,
        },
        retentionYears: 5,
      });
      return err<CancelPaymentError>({ code: 'payment_not_found' });
    }

    // Ownership check — payment must belong to actor's member record.
    if (payment.memberId !== input.actorMemberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Ownership mismatch probe on payment ${input.paymentId}`,
        payload: {
          subject_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: input.paymentId,
        },
        retentionYears: 5,
      });
      return err<CancelPaymentError>({ code: 'forbidden_payment' });
    }

    const transition = canTransition(payment.status, 'canceled');
    if (!transition.ok) {
      return err<CancelPaymentError>({
        code: 'payment_not_cancelable',
        currentStatus: payment.status,
      });
    }

    const cancelResult = await deps.processorGateway.cancelPaymentIntent(
      payment.processorPaymentIntentId,
      settings.processorAccountId,
    );
    if (!cancelResult.ok) {
      return err<CancelPaymentError>({
        code: 'processor_unavailable',
        reason: cancelResult.error.kind,
      });
    }

    const completedAt = new Date(deps.clock.nowMs());
    await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'canceled',
      completedAt,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_canceled',
      actorUserId: input.actorUserId,
      summary: `Payment ${payment.id} canceled by member`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        actor_type: 'member',
      },
      retentionYears: 5,
    });

    return ok<CancelPaymentSuccess>({
      paymentId: payment.id,
      status: 'canceled',
      completedAt: completedAt.toISOString(),
    });
  });
}
