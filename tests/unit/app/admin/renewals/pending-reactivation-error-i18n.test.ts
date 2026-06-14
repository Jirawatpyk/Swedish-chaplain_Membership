/**
 * 070 F8 item #18 — i18n coverage pin for the `PendingReactivationActions`
 * reject error-toast set.
 *
 * The component surfaces the reject route's `{ error: { code } }` via
 * `t(\`reject.error.${code}\`)` with a `t.has(...)` + `server_error`
 * fallback. Unit tests mock next-intl (t() never throws on a missing key)
 * and `check:i18n` is parity-only (not code-ref-aware), so a route error
 * code WITHOUT an EN `reject.error.*` key would pass every gate and render
 * the generic server_error copy at runtime instead of its own message.
 *
 * EN is the canonical locale (a missing EN key is the crash/wrong-copy
 * class; TH/SV parity is `check:i18n`'s job). We assert against the REAL
 * en.json so a key rename/removal fails this test — NOT a rendered Base UI
 * dialog (which deadlocks under jsdom + React 19 startTransition, see the
 * dialog-jsdom-hang memory). Static leaf coverage is the right seam here.
 */
import { describe, expect, it } from 'vitest';
import { PENDING_REACTIVATION_REJECT_ERROR_CODES } from '@/app/(staff)/admin/renewals/[cycleId]/_components/pending-reactivation-error-codes';
import en from '@/i18n/messages/en.json';

const pr = (
  en as unknown as {
    admin: {
      renewals: {
        cycleDetail: {
          pendingReactivation: {
            reactivate: Record<string, string | undefined>;
            reject: {
              error: Record<string, string | undefined>;
            } & Record<string, unknown>;
          };
        };
      };
    };
  }
).admin.renewals.cycleDetail.pendingReactivation;

const rejectErrors = pr.reject.error;

describe('PendingReactivationActions error set — EN i18n coverage (070)', () => {
  it('every route-emittable reject error code has a non-empty reject.error.* EN key', () => {
    const missing = PENDING_REACTIVATION_REJECT_ERROR_CODES.filter(
      (code) =>
        typeof rejectErrors[code] !== 'string' ||
        rejectErrors[code]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty EN copy for reject error code(s): ${missing.join(', ')} — ` +
        'the route emits these in `{ error: { code } }`; add ' +
        '`admin.renewals.cycleDetail.pendingReactivation.reject.error.<code>` ' +
        'to en.json (+ th/sv for check:i18n parity) or the toast renders the ' +
        'generic server_error copy.',
    ).toEqual([]);
  });

  it('the server_error fallback key exists (the t.has(...) fallback target)', () => {
    expect(typeof rejectErrors['server_error']).toBe('string');
    expect(rejectErrors['server_error']!.length).toBeGreaterThan(0);
  });

  it('the reactivate + reject success/copy keys the component reads are present', () => {
    // The non-error keys the component references directly (no t.has guard),
    // so a missing one renders the raw dotted key path at runtime.
    const reactivate = pr.reactivate;
    for (const k of [
      'button',
      'dialogTitle',
      'dialogBody',
      'confirm',
      'cancel',
      'submitting',
      'successToast',
      'errorToast',
    ]) {
      expect(typeof reactivate[k], `reactivate.${k}`).toBe('string');
    }
    const reject = pr.reject as Record<string, unknown>;
    for (const k of [
      'button',
      'dialogTitle',
      'dialogBody',
      'reasonLabel',
      'reasonPlaceholder',
      'reasonRequired',
      'confirm',
      'cancel',
      'submitting',
      'successRefundedToast',
      'successNoRefundToast',
    ]) {
      expect(typeof reject[k], `reject.${k}`).toBe('string');
    }
  });
});
