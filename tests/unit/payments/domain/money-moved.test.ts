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
  classifyGatewayFailure,
  proveNothingMoved,
  type MoneyExit,
  type ProcessorFailureKind,
  type RejectionProof,
} from '@/modules/payments/domain/settlement/money-moved';
import type { ProcessorGatewayError } from '@/modules/payments/application/ports';

describe('classifyGatewayFailure', () => {
  it('treats only a permanent failure as proof the money was rejected', () => {
    expect(classifyGatewayFailure('permanent')).toBe<MoneyExit>('rejected');
  });

  it.each<ProcessorFailureKind>(['retryable', 'idempotency_conflict'])(
    'treats %s as UNKNOWN — the request may have reached the processor',
    (kind) => {
      expect(classifyGatewayFailure(kind)).toBe<MoneyExit>('unknown');
    },
  );

  it('stays in sync with the gateway port error kinds', () => {
    // Compile-time drift guard: if the port grows a fourth kind, this
    // assignment fails to typecheck and someone has to decide which exit it
    // maps to, rather than it silently defaulting.
    const portKind: ProcessorGatewayError['kind'] = 'retryable';
    const domainKind: ProcessorFailureKind = portKind;
    expect(classifyGatewayFailure(domainKind)).toBe('unknown');
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
    const maybe = proveNothingMoved(classifyGatewayFailure('retryable'));
    expect(maybe).toBeNull();
  });
});
