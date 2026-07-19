/**
 * Money-remediation Task 2 — money-exit classification.
 *
 * Finding F-3 leg 1: `issueRefund` flips a refund row to `failed` on every
 * gateway failure kind. But `failed` is a claim that NO money left, and only
 * `permanent` supports that claim. `retryable` means the request may have
 * reached Stripe and the response was lost; `idempotency_conflict` means a
 * request with that key already exists. Both are UNKNOWN, and terminalising
 * an unknown as `failed` is what lets a retry mint a fresh idempotency key
 * and pay the customer twice.
 *
 * `proveNothingMoved` exists so that a caller cannot assert `failed` without
 * holding a proof, and a proof can only be minted from a `rejected` exit.
 *
 * NOTE: this module has NO call site yet — Task 6 threads `RejectionProof`
 * through `RefundsRepo.updateStatus`'s `nextStatus:'failed'` overload, which
 * is what makes the wrong call stop compiling rather than merely be wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  MONEY_MOVED_PERMANENT_CODES,
  classifyGatewayFailure,
  proveNothingMoved,
  proveProcessorSettledFailed,
  type MoneyExit,
  type ProcessorFailure,
  type ProcessorFailureKind,
  type RejectionProof,
} from '@/modules/payments/domain/settlement/money-moved';
import type { ProcessorGatewayError } from '@/modules/payments/application/ports';

describe('classifyGatewayFailure', () => {
  it('treats a permanent failure as proof the money was rejected', () => {
    expect(
      classifyGatewayFailure({ kind: 'permanent', code: 'charge_already_refunded' }),
    ).toBe<MoneyExit>('rejected');
  });

  it.each<ProcessorFailureKind>(['retryable', 'idempotency_conflict'])(
    'treats %s as UNKNOWN — the request may have reached the processor',
    (kind) => {
      expect(classifyGatewayFailure({ kind })).toBe<MoneyExit>('unknown');
    },
  );

  it('treats a permanent failure with NO code as rejected', () => {
    // `code` is only populated on the port's `permanent` variant; a
    // permanent failure without one is still a refusal.
    expect(classifyGatewayFailure({ kind: 'permanent' })).toBe<MoneyExit>('rejected');
  });

  // ── The exception that makes `kind` alone insufficient ──────────────────
  //
  // `stripe-gateway.ts` returns `{kind:'permanent', code:
  // 'processor_response_amount_invalid'}` from a point where
  // `client.refunds.create` ALREADY RESOLVED — Stripe accepted the refund and
  // `refund.id` exists; only the response's `amount` field failed validation.
  // The money moved. Classifying that as `rejected` would mint a proof for a
  // settled refund, which is finding F-3 with extra steps.
  //
  // Reachable today from `confirm-payment.ts:838` and `:1204` (auto-refund),
  // both of which omit `amountSatang` — the exact precondition for this code.
  it.each(MONEY_MOVED_PERMANENT_CODES)(
    'treats permanent/%s as UNKNOWN — the processor accepted before failing',
    (code) => {
      expect(classifyGatewayFailure({ kind: 'permanent', code })).toBe<MoneyExit>(
        'unknown',
      );
    },
  );

  it('mints no proof for a permanent failure that already moved money', () => {
    const exit = classifyGatewayFailure({
      kind: 'permanent',
      code: 'processor_response_amount_invalid',
    });
    expect(proveNothingMoved(exit)).toBeNull();
  });

  it('stays in sync with the gateway port error shape', () => {
    // Compile-time drift guard: if the port grows a fourth kind, this
    // assignment fails to typecheck and someone has to decide which exit it
    // maps to, rather than it silently defaulting.
    const portError: ProcessorGatewayError = { kind: 'retryable', reason: 'rate_limit' };
    const domainFailure: ProcessorFailure = portError;
    expect(classifyGatewayFailure(domainFailure)).toBe('unknown');
  });
});

describe('proveProcessorSettledFailed', () => {
  it.each(['failed', 'canceled'] as const)(
    'mints a proof when the processor reports a %s settlement',
    (status) => {
      expect(proveProcessorSettledFailed(status)).not.toBeNull();
    },
  );

  it('produces a proof interchangeable with proveNothingMoved', () => {
    // Both minting functions must yield the SAME brand, or the two honest
    // sources of evidence would need two parallel repo overloads.
    const fromExit: RejectionProof | null = proveNothingMoved('rejected');
    const fromProcessor: RejectionProof = proveProcessorSettledFailed('failed');
    expect(Object.getOwnPropertySymbols(fromProcessor)).toEqual(
      Object.getOwnPropertySymbols(fromExit ?? {}),
    );
  });
});

describe('proveNothingMoved', () => {
  it('mints a proof for a rejected exit', () => {
    expect(proveNothingMoved('rejected')).not.toBeNull();
  });

  it.each<MoneyExit>(['unknown', 'settled'])(
    'refuses to mint a proof for a %s exit',
    (exit) => {
      expect(proveNothingMoved(exit)).toBeNull();
    },
  );

  it('cannot be forged from an object literal', () => {
    // COMPILE-TIME. The brand symbol is module-private, so nothing outside
    // `money-moved.ts` can construct a RejectionProof. `tsconfig` includes
    // test sources, so this `@ts-expect-error` is checked by `pnpm typecheck`
    // and fails the build if the error stops occurring.
    //
    // The concrete failure it guards: Task 6 threads RejectionProof through
    // `RefundsRepo.updateStatus`'s `nextStatus:'failed'` overload. A test
    // author who cannot construct one to make a stub compile will reach for
    // exporting REJECTION_PROOF — at which point F-3's guard becomes
    // decoration and every test stays green. If this line ever compiles, that
    // has already happened.
    // @ts-expect-error - the REJECTION_PROOF brand is not constructible here
    const forged: RejectionProof = { forged: true };
    expect(forged).toBeDefined();
  });

  it('an unknown exit yields nothing assignable to RejectionProof', () => {
    // The runtime half of the same guarantee: `proveNothingMoved('unknown')`
    // is `null`, so a caller demanding a proof cannot be satisfied by an
    // unknown money exit even with a non-null assertion at runtime.
    const maybe = proveNothingMoved(classifyGatewayFailure({ kind: 'retryable' }));
    expect(maybe).toBeNull();
  });
});
