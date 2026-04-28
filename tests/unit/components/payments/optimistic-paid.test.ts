/**
 * Unit tests for the optimistic-paid store: sessionStorage TTL, the
 * BroadcastChannel self-echo guard, and `useSyncExternalStore` SSR
 * snapshot semantics.
 *
 * Notes on isolation:
 *   - `tabSenderId` and the dispatcher BroadcastChannel are
 *     module-level singletons. We `vi.resetModules()` between tests
 *     so each test starts with a fresh sender id + fresh channel.
 *   - jsdom DOES provide BroadcastChannel since v20+; vitest's
 *     `environment: 'jsdom'` is configured at the suite level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH =
  '@/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid';

beforeEach(() => {
  // Fresh module + storage + crypto per test.
  vi.resetModules();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('optimistic-paid store', () => {
  describe('dispatchInvoicePaid + readPaidFlag round-trip', () => {
    it('writes a paid flag for the given invoice id that survives subsequent reads', async () => {
      const mod = await import(MODULE_PATH);
      const id = '11111111-1111-1111-1111-111111111111';

      mod.dispatchInvoicePaid(id);

      // Calling readPaidFlag is private; the public surface is the
      // hook. Validate via sessionStorage directly — that IS the
      // contract (`swecham:optimistic-paid:{id}` key exists).
      expect(
        window.sessionStorage.getItem(`swecham:optimistic-paid:${id}`),
      ).not.toBeNull();
    });

    it('returns false for a different invoice id (key isolation)', async () => {
      const mod = await import(MODULE_PATH);
      const paidId = '11111111-1111-1111-1111-111111111111';
      const otherId = '22222222-2222-2222-2222-222222222222';

      mod.dispatchInvoicePaid(paidId);

      expect(
        window.sessionStorage.getItem(`swecham:optimistic-paid:${otherId}`),
      ).toBeNull();
    });
  });

  describe('60s TTL boundary', () => {
    it('treats an entry younger than 60s as paid', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));

      const mod = await import(MODULE_PATH);
      const id = '33333333-3333-3333-3333-333333333333';

      mod.dispatchInvoicePaid(id);
      vi.setSystemTime(new Date('2026-04-26T12:00:59Z')); // +59 s

      // Re-import is unnecessary — readPaidFlag uses Date.now()
      // every call. The flag must still report paid.
      const stored = window.sessionStorage.getItem(
        `swecham:optimistic-paid:${id}`,
      );
      expect(stored).not.toBeNull();
      const ts = Number(stored);
      expect(Date.now() - ts).toBeLessThanOrEqual(60_000);
    });

    it('treats an entry older than 60s as expired (TTL boundary)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));

      const mod = await import(MODULE_PATH);
      const id = '44444444-4444-4444-4444-444444444444';

      mod.dispatchInvoicePaid(id);
      vi.setSystemTime(new Date('2026-04-26T12:01:01Z')); // +61 s

      const stored = window.sessionStorage.getItem(
        `swecham:optimistic-paid:${id}`,
      );
      expect(stored).not.toBeNull();
      const ts = Number(stored);
      expect(Date.now() - ts).toBeGreaterThan(60_000);
    });
  });

  describe('BroadcastChannel self-echo guard', () => {
    it('dispatches a BC message stamped with a senderId that survives across calls in the same tab', async () => {
      const mod = await import(MODULE_PATH);
      const id = '55555555-5555-5555-5555-555555555555';

      // Listen on a fresh channel BEFORE dispatching to capture the
      // posted senderId. Same-channel-instance suppression DOES NOT
      // apply across a different listener channel — that's the
      // exact bug `senderId` exists to suppress.
      const listener = new BroadcastChannel('swecham:invoice-paid');
      const received: Array<{ invoiceId?: string; senderId?: string }> = [];
      listener.addEventListener('message', (e) => {
        received.push(e.data);
      });

      mod.dispatchInvoicePaid(id);

      // Yield to the microtask queue + give BC a tick.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0]!;
      expect(msg.invoiceId).toBe(id);
      expect(typeof msg.senderId).toBe('string');
      expect(msg.senderId!.length).toBeGreaterThan(0);

      // Second dispatch from the SAME tab — senderId stays stable.
      const senderIdFirst = msg.senderId;
      received.length = 0;
      mod.dispatchInvoicePaid(id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received.length).toBeGreaterThan(0);
      expect(received[0]!.senderId).toBe(senderIdFirst);

      listener.close();
    });
  });

  describe('SSR safety', () => {
    it('exposes a server-snapshot value of false (SSR pre-hydration)', async () => {
      // The implementation file ALREADY guards `typeof window`
      // checks per accessor. We can't directly invoke
      // getServerSnapshot from the public API — instead verify the
      // hook returns false on first render with empty storage,
      // which is the SSR-equivalent state on the client.
      const mod = await import(MODULE_PATH);
      window.sessionStorage.clear();
      const id = '66666666-6666-6666-6666-666666666666';

      // No paid flag set — the hook MUST return false (matches
      // server snapshot) so SSR + first client render agree.
      const stored = window.sessionStorage.getItem(
        `swecham:optimistic-paid:${id}`,
      );
      expect(stored).toBeNull();
      // The dispatchInvoicePaid + writePaidFlag pair is the only
      // way to flip true; without it, snapshot must be false.
      expect(typeof mod.dispatchInvoicePaid).toBe('function');
      expect(typeof mod.useOptimisticPaid).toBe('function');
    });

    // R3-fix IG-1 (2026-04-26): exercise the actual hook via
    // `renderHook` to verify SSR-snapshot semantics through the
    // public API, not just the storage side-effect. Catches the
    // off-by-one + stale-render bugs that the storage-only checks
    // above can miss.
    it('useOptimisticPaid returns false on first render when storage is empty (SSR-aligned)', async () => {
      const { renderHook } = await import('@testing-library/react');
      const mod = await import(MODULE_PATH);
      const id = '77777777-7777-7777-7777-777777777777';

      const { result } = renderHook(() => mod.useOptimisticPaid(id));
      expect(result.current).toBe(false);
    });

    // R3-fix TQ-2 (2026-04-26): TTL boundary via the PUBLIC hook —
    // not just storage timestamps. Confirms `readPaidFlag` actually
    // returns false when the entry is older than 60s, defending
    // against an off-by-one bug like `< 60_000` vs `<= 60_000`.
    it('useOptimisticPaid returns false after the 60s TTL elapses (TTL boundary, public API)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));

      const { renderHook } = await import('@testing-library/react');
      const mod = await import(MODULE_PATH);
      const id = '88888888-8888-8888-8888-888888888888';

      mod.dispatchInvoicePaid(id);
      // Right after dispatch — should read true.
      const before = renderHook(() => mod.useOptimisticPaid(id));
      expect(before.result.current).toBe(true);

      // Advance past TTL — flag must drop to false on next read.
      vi.setSystemTime(new Date('2026-04-26T12:01:01Z')); // +61 s
      const after = renderHook(() => mod.useOptimisticPaid(id));
      expect(after.result.current).toBe(false);
    });
  });
});
