'use client';

/**
 * T079 — Test-webhook button (F6 Phase 5 / US3 AS2).
 *
 * Async POST to `/api/admin/integrations/eventcreate/test-webhook`.
 * Renders three states:
 *   - idle: "Send test event"
 *   - pending: spinner + `aria-busy=true` (disabled)
 *   - resolved: sonner toast (success/failure) + outcome callback fires
 *
 * `aria-live="polite"` SR announcement on resolve. 2-second cooldown
 * before re-enabling so accidental double-clicks don't immediately
 * spam the 10/hr rate limit.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2Icon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';
import type { RunTestWebhookOutcome } from '@/modules/events';

/**
 * Round-6 verify-fix 2026-05-13 (type-design C1) — the UI previously
 * re-declared its own `TestWebhookOutcome` interface with `ok: boolean`
 * and every distinguishing field as `?:` optional. That threw away the
 * compile-time narrowing the Application-layer `RunTestWebhookOutcome`
 * discriminated union earns at the use-case boundary. The route
 * handler serialises `RunTestWebhookOutcome` verbatim to JSON, so
 * consuming the same type here is a free upgrade.
 */
export type TestWebhookOutcome = RunTestWebhookOutcome;

export interface TestWebhookButtonProps {
  /** Fires after the round-trip resolves so the parent can refresh
   *  the recent-deliveries panel. */
  readonly onResolved?: (outcome: TestWebhookOutcome) => void;
}

export function TestWebhookButton({ onResolved }: TestWebhookButtonProps) {
  const t = useTranslations('admin.integrations.eventcreate.phaseC.test');
  const [loading, setLoading] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  async function handleClick() {
    setLoading(true);
    setAnnouncement(t('inProgress'));
    try {
      const res = await fetch(
        '/api/admin/integrations/eventcreate/test-webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: '{}',
        },
      );
      if (res.status === 429) {
        // Round 2 SF-LOW8 fix (2026-05-13) — surface the `Retry-After`
        // seconds in the toast copy so the admin knows how long to
        // wait. Route emits `Retry-After: <seconds>` + a problem-body
        // `detail` containing the same value.
        const retryAfterRaw = res.headers.get('Retry-After');
        const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : null;
        const message =
          retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0
            ? t('rateLimitedWithRetry', { seconds: retryAfter })
            : t('rateLimited');
        toast.error(message);
        setAnnouncement(message);
        return;
      }
      if (!res.ok) {
        // Round 2 simplifier P1 (2026-05-13) — shared
        // `parseProblemDetail` helper. Surfaces distinct copy for
        // 404 (kill-switch) vs 500 (audit-fail) vs 503.
        const message = await parseProblemDetail(res, t('serverError'));
        toast.error(message);
        setAnnouncement(message);
        return;
      }
      const body = (await res.json()) as TestWebhookOutcome;
      // Round-6 verify-fix 2026-05-13 (type-design C1) — discriminated
      // narrowing on `body.ok`. The Application-layer
      // `RunTestWebhookOutcome` guarantees `processingOutcome` /
      // `durationMs` are present on the success arm and
      // `failureCategory` / `hint` on the failure arm.
      if (body.ok) {
        toast.success(
          t('successWithOutcome', {
            outcome: body.processingOutcome,
            durationMs: body.durationMs,
          }),
        );
        setAnnouncement(t('success'));
      } else {
        toast.error(t('failureWithHint', { hint: body.hint }));
        setAnnouncement(t('failure'));
      }
      onResolved?.(body);
    } catch (e) {
      // Round-6 verify-fix 2026-05-13 — surface error to DevTools so
      // SREs/devs can diagnose root cause (DNS / TLS / abort / timeout)
      // without manual repro. User-facing toast stays generic.
      console.error('[F6] test-webhook request failed', e);
      toast.error(t('networkError'));
      setAnnouncement(t('networkError'));
    } finally {
      // 2s cooldown so accidental double-clicks don't immediately
      // consume the 10/hr quota.
      setTimeout(() => setLoading(false), 2_000);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        onClick={() => void handleClick()}
        disabled={loading}
        aria-busy={loading}
        className="min-h-11"
      >
        {loading ? (
          <Loader2Icon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <SendIcon className="size-4" aria-hidden />
        )}
        {loading ? t('inProgress') : t('sendTest')}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
