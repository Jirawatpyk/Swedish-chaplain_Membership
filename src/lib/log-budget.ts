/**
 * #72 — a request-scoped cap on log lines. Vercel keeps a bounded number of
 * log lines per function request (256 when the first prod run of
 * `sweep-orphan-blobs` stopped and lost its summary), so a cron that can log
 * per item caps every line except the ones `always` names (its summaries).
 */
export interface LineLogger {
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
}

export function budgetedLogger(
  base: LineLogger,
  maxLines: number,
  always: (meta: Record<string, unknown>) => boolean,
): { readonly logger: LineLogger; suppressed(): number } {
  let left = maxLines;
  let dropped = 0;
  const pass =
    (level: keyof LineLogger) =>
    (meta: Record<string, unknown>, msg: string): void => {
      if (always(meta)) {
        base[level](meta, msg);
        return;
      }
      if (left > 0) {
        left -= 1;
        base[level](meta, msg);
      } else dropped += 1;
    };
  return {
    logger: { info: pass('info'), warn: pass('warn'), error: pass('error') },
    suppressed: () => dropped,
  };
}
