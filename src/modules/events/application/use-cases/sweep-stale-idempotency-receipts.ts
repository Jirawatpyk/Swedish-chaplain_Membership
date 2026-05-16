/**
 * F6 Phase 10 T115 — `sweepStaleIdempotencyReceipts` use-case.
 *
 * Daily TTL sweep of `eventcreate_idempotency_receipts` per round-3 Z5.
 * Deletes rows where `ttl_expires_at < NOW()` for the caller's tenant.
 *
 * The receipt table is purely operational: it absorbs Zapier retry
 * storms via the webhook idempotency layer. Rows expire 7 days after
 * processing (DB default). Sweep keeps the table bounded.
 *
 * Failure mode: pure-deletion sweep — if the DELETE fails, the use-case
 * returns Result.err so the cron handler logs + the AA1 stalled-sweep
 * alert fires.
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (cron handler) wraps in `runInTenant(ctx, ...)` per tenant.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';

/** Optional cap to prevent runaway DELETEs on a misconfigured tenant. */
const DEFAULT_MAX_ROWS = 50_000;

export interface SweepStaleIdempotencyReceiptsInput {
  readonly tenantId: TenantId;
  readonly occurredAt: Date;
  readonly maxRows?: number;
}

export interface SweepStaleIdempotencyReceiptsOutput {
  readonly tenantId: string;
  readonly deletedCount: number;
  readonly durationMs: number;
}

export type SweepStaleIdempotencyReceiptsError = {
  readonly kind: 'sweep_db_error';
  readonly message: string;
};

/**
 * Port for the actual DB sweep. Implementation is a thin Drizzle DELETE
 * query — kept as a port for unit-testability + so the use-case stays
 * pure Application (Constitution III).
 */
export interface IdempotencyReceiptsSweepPort {
  delete(input: {
    readonly tenantId: TenantId;
    readonly cutoff: Date;
    readonly maxRows: number;
  }): Promise<{ readonly deletedCount: number }>;
}

export interface SweepStaleIdempotencyReceiptsDeps {
  readonly sweepPort: IdempotencyReceiptsSweepPort;
}

export async function sweepStaleIdempotencyReceipts(
  input: SweepStaleIdempotencyReceiptsInput,
  deps: SweepStaleIdempotencyReceiptsDeps,
): Promise<
  Result<SweepStaleIdempotencyReceiptsOutput, SweepStaleIdempotencyReceiptsError>
> {
  const startedAt = Date.now();
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  try {
    const result = await deps.sweepPort.delete({
      tenantId: input.tenantId,
      cutoff: input.occurredAt,
      maxRows,
    });
    return ok({
      tenantId: String(input.tenantId),
      deletedCount: result.deletedCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
    return err({ kind: 'sweep_db_error', message });
  }
}
