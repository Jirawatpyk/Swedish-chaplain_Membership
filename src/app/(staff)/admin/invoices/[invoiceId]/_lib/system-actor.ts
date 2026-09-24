/**
 * Non-human actors on the invoice detail page: the legacy `system:` string
 * prefix (some F5 audit emit paths) OR the reserved UUID
 * `SYSTEM_ACTOR_STRIPE_WEBHOOK` from migration 0041 — which is what F4
 * `payment_recorded_by_user_id` carries on an online payment. Looking that
 * UUID up in the users table returns the seeded internal e-mail
 * `system-stripe-webhook@chamber-os.internal`, so callers render the i18n
 * "System (Stripe webhook)" label instead.
 */
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments';

const SYSTEM_ACTOR_PREFIX = 'system:';

export function isSystemActor(actorUserId: string): boolean {
  return (
    actorUserId.startsWith(SYSTEM_ACTOR_PREFIX) ||
    actorUserId === SYSTEM_ACTOR_STRIPE_WEBHOOK
  );
}
