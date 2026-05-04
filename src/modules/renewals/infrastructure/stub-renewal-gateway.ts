/**
 * F8 Phase 4 Wave I2c — Stub `RenewalGateway` adapter.
 *
 * Returns a mock delivery-id without invoking the real Resend SDK.
 * Lets the dispatcher logic + idempotency primitive + audit emission
 * be tested end-to-end without external network dependency or
 * email-template rendering.
 *
 * Wave I3 T100 swaps this for the real `ResendTransactionalRenewalGateway`
 * adapter that wraps F1's `emailSender` + renders React Email templates
 * from `src/modules/renewals/infrastructure/email/templates/*.tsx`.
 *
 * **Production guard**: throws on dispatch when `NODE_ENV === 'production'`
 * — preserves the audit-trail invariant (Constitution Principle VIII)
 * by failing loudly if a code path forgot to swap the stub before going
 * live behind `FEATURE_F8_RENEWALS=true`.
 */
import { randomUUID } from 'node:crypto';
import { ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  RenewalGateway,
  SendRenewalEmailError,
  SendRenewalEmailInput,
  SendRenewalEmailResult,
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
        // memberId is hashed-friendly even in stub logs (privacy-by-default).
        memberId: input.recipient.memberId,
        deliveryId,
      },
      'stubRenewalGateway.sendRenewalEmail (no real Resend dispatch — Wave I3 swaps this)',
    );
    return ok({ deliveryId, dispatchedAt });
  },
};
