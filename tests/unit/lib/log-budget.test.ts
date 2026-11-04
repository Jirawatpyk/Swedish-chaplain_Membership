/**
 * #72 — Vercel keeps a bounded number of log lines per request (the first
 * prod run of `sweep-orphan-blobs` stopped at 256 and lost its summary). A
 * request-scoped budget caps every line except the summaries it is told to
 * always pass, so the summary cannot be crowded out by either half.
 */
import { describe, expect, it, vi } from 'vitest';
import { budgetedLogger } from '@/lib/log-budget';

const base = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const isSummary = (meta: Record<string, unknown>) => meta.event === 'done';

describe('budgetedLogger (#72)', () => {
  it('passes the first N lines across all levels, counts the rest, and always passes a summary', () => {
    const b = base();
    const l = budgetedLogger(b, 3, isSummary);
    l.logger.info({ event: 'a' }, 'm');
    l.logger.warn({ event: 'b' }, 'm');
    l.logger.error({ event: 'c' }, 'm');
    l.logger.error({ event: 'd' }, 'm');
    l.logger.info({ event: 'e' }, 'm');
    l.logger.info({ event: 'done' }, 'summary');
    expect(b.info).toHaveBeenCalledTimes(2);
    expect(b.info).toHaveBeenLastCalledWith({ event: 'done' }, 'summary');
    expect(b.warn).toHaveBeenCalledTimes(1);
    expect(b.error).toHaveBeenCalledTimes(1);
    expect(l.suppressed()).toBe(2);
  });
});
