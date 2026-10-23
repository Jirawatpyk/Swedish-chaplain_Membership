/**
 * A `pending` refund the stale-refund sweep cannot terminalise (Stripe still
 * `pending`/`requires_action`, or no `processor_refund_id`) escalates to an
 * ops signal once STRICTLY older than this, measured on `initiated_at`.
 * Signal only — the row stays `pending`. The invoice dashboard's
 * Needs-attention row ages pending refunds by the same rule (spec 124 D-k).
 */
export const STALE_REFUND_ESCALATION_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
