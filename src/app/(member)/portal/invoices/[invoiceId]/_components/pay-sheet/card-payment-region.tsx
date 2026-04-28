'use client';

/**
 * `<CardPaymentRegion>` — extracted from `pay-sheet-internal.tsx` (audit
 * 2026-04-26 round-2 #1 refactor — see file header in pay-sheet-internal).
 *
 * Owns the "card-form" branch render: skeleton-in-flow + CardForm
 * absolute-behind, single-mount Stripe iframe pattern (audit 2026-04-25
 * finding #5 v3). The orchestrator passes the ephemeral clientSecret +
 * Stripe callbacks; this component owns ONLY the JSX shape.
 *
 * Architectural invariant (do NOT refactor toward two render branches):
 *   - `<CardForm>` is mounted EXACTLY ONCE per `card-form` payState.
 *     Wrapper className swaps between `absolute inset-0 opacity-0
 *     pointer-events-none overflow-hidden` (skeleton up) and `undefined`
 *     (skeleton down) — same React node, no remount, Stripe iframe
 *     preserved across the cardFormVisible flip.
 *   - `overflow-hidden` is critical: skeleton sets the .relative
 *     container's intrinsic height (~190 px); Stripe's PaymentElement
 *     iframe paints ~300 px tall. Without clipping, the iframe's
 *     overflow bleeds into the ancestor `.overflow-y-auto` → scrollbar
 *     appears even though nothing is visible past the skeleton.
 */

import { CardForm } from './card-form';
import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';

export interface CardPaymentRegionProps {
  readonly clientSecret: string;
  readonly publishableKey: string;
  readonly amountDue: number;
  readonly invoiceId: string;
  readonly memberId: string;
  readonly cardFormVisible: boolean;
  readonly onSuccess: React.ComponentProps<typeof CardForm>['onSuccess'];
  readonly onFailure: React.ComponentProps<typeof CardForm>['onFailure'];
  readonly onRequiresAction: React.ComponentProps<typeof CardForm>['onRequiresAction'];
  readonly onVisible: () => void;
}

export function CardPaymentRegion({
  clientSecret,
  publishableKey,
  amountDue,
  invoiceId,
  memberId,
  cardFormVisible,
  onSuccess,
  onFailure,
  onRequiresAction,
  onVisible,
}: CardPaymentRegionProps) {
  return (
    <div className="relative">
      <div
        className={
          cardFormVisible
            ? undefined
            : 'absolute inset-0 opacity-0 pointer-events-none overflow-hidden'
        }
        aria-hidden={!cardFormVisible}
        data-testid="pay-sheet-card-form-wrapper"
      >
        <CardForm
          clientSecret={clientSecret}
          publishableKey={publishableKey}
          amountDue={amountDue}
          invoiceId={invoiceId}
          memberId={memberId}
          onSuccess={onSuccess}
          onFailure={onFailure}
          onRequiresAction={onRequiresAction}
          onVisible={onVisible}
        />
      </div>
      {!cardFormVisible ? <PaySheetSkeleton /> : null}
    </div>
  );
}
