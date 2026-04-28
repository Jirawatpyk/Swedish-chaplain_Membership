/**
 * F5 LoggerPort adapter (audit 2026-04-25 finding #5).
 *
 * Wraps the project's pino instance from `@/lib/logger` so Application
 * use-cases can emit structured logs via the `LoggerPort` interface
 * without violating Principle III (no framework imports in
 * Application). The adapter is responsible for binding the canonical
 * `mod: 'payments'` field so observability dashboards can filter the
 * F5 surface from F1/F2/F3/F4 lines.
 *
 * Forbidden fields (PCI SAQ-A): pino's `redact` config in
 * `src/lib/logger.ts` REDACT_PATHS catches `clientSecret`,
 * `client_secret`, `card.*`, etc. Even so, callers MUST NOT include
 * any card / secret data in `meta`.
 */
import { logger } from '@/lib/logger';
import type { LoggerPort } from '@/modules/payments/application/ports';

export const paymentsLogger: LoggerPort = {
  info(message, meta) {
    logger.info({ mod: 'payments', ...(meta ?? {}) }, message);
  },
  warn(message, meta) {
    logger.warn({ mod: 'payments', ...(meta ?? {}) }, message);
  },
  error(message, meta) {
    logger.error({ mod: 'payments', ...(meta ?? {}) }, message);
  },
};
