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
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2Icon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';
import { parseRetryAfterSeconds } from '@/lib/http/parse-retry-after';
import { adminPost } from '@/lib/http/admin-post';
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
  // Round 11 code-reviewer fix #1 (2026-05-14) — track the 2s cooldown
  // timer in a ref so it can be cleared on unmount. Previously the
  // bare `setTimeout` inside `finally` had no cleanup; if the parent
  // unmounted this component within the 2s window (e.g. admin opens
  // RotateSecretDialog or navigates away after pressing Send),
  // `setLoading(false)` fired on an unmounted component and produced a
  // React 18 "Can't perform a React state update on an unmounted
  // component" warning. Same lifecycle pattern as
  // <WebhookSecretReveal>'s `copied` reset effect.
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, []);

  async function handleClick() {
    setLoading(true);
    setAnnouncement(t('inProgress'));
    try {
      // Round 3 S-H3 — shared `adminPost` replaces the boilerplate.
      const res = await adminPost(
        '/api/admin/integrations/eventcreate/test-webhook',
      );
      if (res.status === 429) {
        const retryAfter = parseRetryAfterSeconds(res);
        const message =
          retryAfter !== null
            ? t('rateLimitedWithRetry', { seconds: retryAfter })
            : t('rateLimited');
        toast.error(message);
        setAnnouncement(message);
        return;
      }
      if (!res.ok) {
        const message = await parseProblemDetail(
          res,
          t('serverError'),
          'test-webhook',
        );
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
      // consume the 10/hr quota. Timer stored in `cooldownTimerRef`
      // so the unmount effect can clear it (round 11 code-reviewer
      // fix #1 — prevent React-18 state-update-on-unmounted warning).
      cooldownTimerRef.current = setTimeout(() => {
        cooldownTimerRef.current = null;
        setLoading(false);
      }, 2_000);
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
