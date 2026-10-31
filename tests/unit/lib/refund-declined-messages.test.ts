/**
 * #51 — the refund route's decline copy rides the shared `processor_unavailable`
 * envelope code, so it lives outside `F5_ERROR_MESSAGES`. Pin it to the dialog's
 * own locale strings so the two cannot drift on the next copy edit.
 */
import { describe, expect, it } from 'vitest';
import { REFUND_DECLINED_MESSAGES } from '@/lib/payments-errors-i18n';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';

describe('REFUND_DECLINED_MESSAGES', () => {
  it('matches admin.refund.error.processor_unavailable in EN and TH', () => {
    expect(REFUND_DECLINED_MESSAGES.message).toBe(en.admin.refund.error.processor_unavailable);
    expect(REFUND_DECLINED_MESSAGES.messageThai).toBe(th.admin.refund.error.processor_unavailable);
  });
});
