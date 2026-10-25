/**
 * Retry window for all kill-switch 503s. Mirrored as `Retry-After` header
 * AND `retryAfterSeconds` body field so route handlers + member-portal
 * error boundaries can render a countdown without parsing headers (some
 * fetch wrappers strip them). The staff help page (`/admin/support`) quotes
 * the same window, so the two can never disagree.
 */
export const KILL_SWITCH_RETRY_AFTER_SECONDS = 300;
