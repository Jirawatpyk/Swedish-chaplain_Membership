/**
 * Test-only stub `RenewalGateway` adapter.
 *
 * Returns a mock delivery-id without invoking the real Resend SDK.
 * Lets the dispatcher logic + idempotency primitive + audit emission
 * be tested end-to-end without external network dependency or
 * email-template rendering. The production composition root
 * (`renewals-deps.ts`) wires `resendTransactionalRenewalGateway` —
 * this stub is reserved for unit-test deps composition that wants
 * deterministic gateway behaviour.
 *
 * **Production guard**: throws on dispatch when `NODE_ENV === 'production'`
 * — preserves the audit-trail invariant (Constitution Principle VIII)
 * by failing loudly if a code path accidentally wires the stub into
 * a production deployment.
 */
import { randomUUID } from 'node:crypto';
import { ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  RenewalGateway,
  SendRenewalEmailError,
  SendRenewalEmailInput,
  SendRenewalEmailResult,
  SendTierUpgradeApprovalEmailInput,
} from '../application/ports/renewal-gateway';

export const stubRenewalGateway: RenewalGateway = {
  async sendRenewalEmail(
    input: SendRenewalEmailInput,
  ): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `stubRenewalGateway.sendRenewalEmail called in production ` +
          `(stepId=${input.stepId}). Wave I3 T100 must swap this stub ` +
          `for the real ResendTransactionalRenewalGateway before flipping ` +
          `FEATURE_F8_RENEWALS=true.`,
      );
    }
    const deliveryId = `stub-${randomUUID()}`;
    const dispatchedAt = new Date().toISOString();
    logger.info(
      {
        stub: true,
        tenantId: input.tenantId,
        cycleId: input.cycleId,
        stepId: input.stepId,
        templateId: input.templateId,
        recipientLocale: input.recipient.preferredLocale,
        memberId: input.recipient.memberId,
        deliveryId,
      },
      'stubRenewalGateway.sendRenewalEmail (no real Resend dispatch — Wave I3 swaps this)',
    );
    return ok({ deliveryId, dispatchedAt });
  },

  async sendTierUpgradeApprovalEmail(
    input: SendTierUpgradeApprovalEmailInput,
  ): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `stubRenewalGateway.sendTierUpgradeApprovalEmail called in production`,
      );
    }
    const deliveryId = `stub-tier-${randomUUID()}`;
    const dispatchedAt = new Date().toISOString();
    logger.info(
      {
        stub: true,
        tenantId: input.tenantId,
        memberId: input.recipient.memberId,
        idempotencyKey: input.idempotencyKey,
        deliveryId,
      },
      'stubRenewalGateway.sendTierUpgradeApprovalEmail (no real Resend dispatch)',
    );
    return ok({ deliveryId, dispatchedAt });
  },
};
