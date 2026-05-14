'use client';

/**
 * T075 — Webhook config wizard orchestrator (F6 Phase 5 / US3).
 *
 * Client component that orchestrates the 3-phase progressive
 * disclosure flow:
 *
 *   - Phase A: secret generation + one-time-reveal + checkbox gate
 *               (`<WebhookSecretReveal>`)
 *   - Phase B: 8-step Zapier walkthrough (server-rendered prop)
 *   - Phase C: webhook URL + test button + recent deliveries + rotate
 *
 * On a "configured" tenant (secretConfigured=true), the orchestrator
 * jumps straight to Phase C — Phase A is unreachable post-generation
 * (one-time-reveal contract). Phase B remains accessible as
 * reference material via a "View setup guide" expandable inside
 * Phase C (wired by Round-6 verify-fix 2026-05-13 / UX D-01).
 *
 * Receives server-loaded props from the page server component so the
 * first paint shows the correct state without a client-side fetch.
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { InfoIcon } from 'lucide-react';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/members/copy-button';
import { formatGraceTimestamp } from '@/lib/format-grace-timestamp';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';
import { adminPost } from '@/lib/http/admin-post';
import type { IntegrationConfigView } from '@/lib/events-admin-integration-types';
import { WebhookSecretReveal } from './webhook-secret-reveal';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { TestWebhookButton } from './test-webhook-button';
import { RecentDeliveriesPanel } from './recent-deliveries-panel';

export interface WebhookConfigWizardProps {
  /**
   * The full discriminated `IntegrationConfigView` from the loader.
   * Component narrows on `view.secretConfigured` internally.
   *
   * Round-6 verify-fix 2026-05-13 (type-design C4) — was previously a
   * flat-bag set of optional fields that allowed `{secretConfigured:
   * false, secretLastFour: 'abcd'}` to compile.
   */
  readonly view: IntegrationConfigView;
  /** Pre-rendered Phase B server component. */
  readonly walkthrough: ReactNode;
}

type Phase = 'a-generate' | 'a-reveal' | 'b-walkthrough' | 'c-test';

interface GeneratedSecret {
  readonly secret: string;
  readonly secretLastFour: string;
}

export function WebhookConfigWizard({ view, walkthrough }: WebhookConfigWizardProps) {
  const t = useTranslations('admin.integrations.eventcreate.wizard');
  const format = useFormatter();
  const router = useRouter();

  // Initial phase derives from props: configured tenants land on
  // Phase C; fresh tenants land on Phase A.
  const initialPhase: Phase = view.secretConfigured ? 'c-test' : 'a-generate';
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [generated, setGenerated] = useState<GeneratedSecret | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Round 2 MED-09 fix (2026-05-13) — `<details>` keeps children in
  // the DOM regardless of open state; the controlled `guideOpen`
  // flag short-circuits the 8 walkthrough `<Image>` renders until
  // the admin actually opens the reference panel.
  const [guideOpen, setGuideOpen] = useState(false);

  // Round 3 M-err-5 (2026-05-13) — post-`router.refresh()` resync
  // guard. CRIT-01's synchronous `setPhase('c-test')` flips the
  // client state ahead of the refresh, but if the server-component
  // re-render hits an error (e.g. transient Neon load failure
  // upstream of `runLoadIntegrationConfig`), `view` stays at the
  // pre-409 shape (`secretConfigured: false`). The wizard then
  // renders Phase C against a `null` discriminant — empty masked
  // secret, broken last-4 chip. Toast asks the admin to reload so
  // they don't sit on a half-rendered screen wondering why the
  // last-4 hint is blank.
  useEffect(() => {
    if (phase === 'c-test' && !view.secretConfigured) {
      toast.error(t('postRefreshResyncFailed'));
    }
    // Intentional: react to phase + view changes; toast is idempotent
    // (sonner dedupes by message).
  }, [phase, view.secretConfigured, t]);

  const steps: StepperStep[] = [
    {
      id: 'a',
      label: t('phaseAStep'),
      status: phase.startsWith('a-')
        ? 'current'
        : view.secretConfigured || generated
          ? 'complete'
          : 'upcoming',
    },
    {
      id: 'b',
      label: t('phaseBStep'),
      status:
        phase === 'b-walkthrough'
          ? 'current'
          : phase === 'c-test'
            ? 'complete'
            : 'upcoming',
    },
    {
      id: 'c',
      label: t('phaseCStep'),
      status: phase === 'c-test' ? 'current' : 'upcoming',
    },
  ];

  async function handleGenerate() {
    setGenerating(true);
    try {
      // Round 3 S-H3 — shared `adminPost` helper replaces the
      // 11-line `Content-Type + Idempotency-Key + body` boilerplate
      // that this file + rotate-secret-dialog + test-webhook-button
      // each carried verbatim.
      const res = await adminPost(
        '/api/admin/integrations/eventcreate/generate-secret',
      );
      if (res.status === 409) {
        // Round 2 CRIT-01 fix (2026-05-13) — must call `setPhase('c-
        // test')` SYNCHRONOUSLY before `router.refresh()`. Next.js App
        // Router preserves client `useState` across refreshes, so the
        // `phase` state stays `'a-generate'` even after the server
        // re-renders with `view.secretConfigured=true`. Without the
        // explicit setPhase, BOTH the Phase A condition (`phase ===
        // 'a-generate' && !view.secretConfigured`) AND the Phase C
        // condition (`phase === 'c-test'`) evaluate false → admin
        // sees only the stepper, nothing else. Round-6 H6 fix added
        // the refresh but missed this synchronous transition.
        toast.error(t('generateAlreadyExists'));
        setPhase('c-test');
        router.refresh();
        return;
      }
      if (!res.ok) {
        // Round 2 simplifier P1 (2026-05-13) — shared
        // `parseProblemDetail` helper replaces the 11-line inline
        // ladder. Surfaces RFC 7807 `detail` for distinct 5xx/503/404
        // copy; falls back to the locale-specific generic toast.
        toast.error(
          await parseProblemDetail(res, t('generateFailed'), 'generate-secret'),
        );
        return;
      }
      const body = (await res.json()) as { secret: string; secretLastFour: string };
      setGenerated({ secret: body.secret, secretLastFour: body.secretLastFour });
      setPhase('a-reveal');
    } catch (e) {
      // Round-6 verify-fix 2026-05-13 — surface to DevTools so devs
      // can debug network failures without manual repro.
      console.error('[F6] generate-secret request failed', e);
      toast.error(t('generateFailed'));
    } finally {
      setGenerating(false);
    }
  }

  function handleContinueFromReveal() {
    setPhase('b-walkthrough');
  }

  function handleWalkthroughComplete() {
    setPhase('c-test');
    // Refresh server data so the masked-secret view + recent
    // deliveries panel reflect the just-saved row.
    router.refresh();
  }

  function handleRotationAcknowledged() {
    router.refresh();
  }

  // Discriminated-union narrow — `view.secretLastFour` / `graceActiveUntil`
  // / `ingestEnabled` / `lastReceivedAt` are only available on the
  // `secretConfigured: true` branch (type-design C4).
  const configured = view.secretConfigured ? view : null;
  // Round-6 verify-fix 2026-05-13 (UX F-01/F-02) — format ISO
  // timestamp via `next-intl`'s `useFormatter().dateTime()` so TH/SV
  // see locale-correct date+time strings instead of the raw ISO
  // form. Falls back to the raw ISO if `Date` rejects the input.
  const graceActiveUntilDisplay = configured?.graceActiveUntil
    ? formatGraceTimestamp(format, configured.graceActiveUntil)
    : null;

  return (
    <div className="space-y-6">
      <Stepper steps={steps} aria-label={t('stepsLabel')} />

      {phase === 'a-generate' && !view.secretConfigured && (
        <>
          {/*
            Round 9 banner (2026-05-14) — EventCreate API access is
            gated to Corporate plan and up. Admins on Pro/Free plans
            cannot complete the Zapier flow even with a perfect
            wizard. Banner sets expectation upfront + offers CSV
            import (US5 / T090–T099) as the equivalent ingest path
            so admins don't waste time generating a secret they
            cannot use. Limited to Phase A intentionally — admins
            who already passed Phase A (configured tenants in
            Phase C) have already cleared the tier gate; showing
            the same banner there is reminder-noise. CSV affordance
            stays signal-tight at the exact decision point.
          */}
          <Card size="sm" className="border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/40">
            <CardContent className="flex items-start gap-3 text-sm">
              <InfoIcon className="size-4 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden />
              <div className="flex flex-col gap-1">
                <p className="font-medium">{t('tierNotice.title')}</p>
                <p className="text-muted-foreground">{t('tierNotice.body')}</p>
                <p className="text-muted-foreground">
                  {t.rich('tierNotice.csvFallback', {
                    csvLink: (chunks) => (
                      <Link
                        href="/admin/events/import"
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm">{t('phaseAIntro')}</p>
              <Button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={generating}
                aria-busy={generating}
                className="min-h-11 self-start"
              >
                {generating ? t('generating') : t('generateButton')}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {phase === 'a-reveal' && generated && (
        <div className="space-y-4">
          <WebhookSecretReveal
            secret={generated.secret}
            secretLastFour={generated.secretLastFour}
            onContinue={handleContinueFromReveal}
          />
        </div>
      )}

      {phase === 'b-walkthrough' && (
        <div className="space-y-4">
          {walkthrough}
          <div className="flex justify-end gap-2">
            {/*
              Round 3 H2 (2026-05-13) — Back-to-Phase-A only when the
              one-time-reveal payload is still in memory. The reveal
              payload is set once on the 200-generate response; the
              409 / refresh paths clear it (CRIT-01 fix synchronously
              moves to 'c-test'). Falling back to Phase A without
              `generated` would render an empty card with no last-4
              hint — broken dead-end for keyboard + screen-reader
              users. Fall back to Phase C instead (configured-tenant
              view is correct once the row exists).
            */}
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                generated ? setPhase('a-reveal') : setPhase('c-test')
              }
            >
              {t('back')}
            </Button>
            <Button
              type="button"
              onClick={handleWalkthroughComplete}
              className="min-h-11"
            >
              {t('connectComplete')}
            </Button>
          </div>
        </div>
      )}

      {phase === 'c-test' && (
        <div className="space-y-6">
          {/*
            Round-6 verify-fix 2026-05-13 (UX D-01) — "View setup
            guide" reference expandable. Phase 5's original
            doc-comment referenced this affordance but never wired
            it. The admin can re-open the Zapier walkthrough on the
            configured-tenant screen without leaving Phase C — useful
            when re-pasting the webhook URL into a second Zap or when
            onboarding a colleague.

            Round 2 fixes (2026-05-13):
              - HIGH-04: `<summary>` adds `min-h-6` + `py-1` for the
                opportunistic WCAG 2.5.8 24×24 tap-target. (The wider
                44×44 is reserved for primary action buttons; this is
                a disclosure widget, not a CTA.)
              - MED-09: walkthrough children render only when the
                `<details>` is open via a controlled `guideOpen`
                state. Native `<details>` keeps content in the DOM
                even when closed, so the 8 `<Image>` tags fired
                requests on every Phase C render. The controlled
                pattern keeps native keyboard/screen-reader behaviour
                while skipping the 8 eager image fetches.
          */}
          <details
            className="rounded-md border bg-muted/30 p-3 text-sm"
            onToggle={(e) =>
              setGuideOpen((e.currentTarget as HTMLDetailsElement).open)
            }
          >
            {/*
              Phase 5 review-fix S-11 (2026-05-13) — explicit
              `aria-expanded` on `<summary>` mirrors the native
              `<details>` open state for assistive tech that doesn't
              consume the `details` role natively. Belt-and-braces
              against the controlled `guideOpen` state going briefly
              stale (transition aborted, fast double-click); the
              native attribute on the parent `<details>` and this
              ARIA attribute always agree because both derive from
              the same toggle event.
            */}
            <summary
              className="min-h-6 cursor-pointer py-1 font-medium"
              aria-expanded={guideOpen}
            >
              {t('viewSetupGuide')}
            </summary>
            {guideOpen ? <div className="mt-3">{walkthrough}</div> : null}
          </details>

          <Card>
            <CardContent className="flex flex-col gap-4">
              <div
                className="flex flex-col gap-1"
                role="group"
                aria-labelledby="webhook-url-label"
              >
                <span id="webhook-url-label" className="text-sm font-medium">
                  {t('webhookUrlLabel')}
                </span>
                <div className="flex items-stretch gap-2">
                  {/*
                    Round-6 verify-fix 2026-05-13 (UX A-04) — the
                    previous version used `<Label htmlFor>` pointing
                    to a `<code>` element, which is invalid: HTML
                    `<label>` only associates with form controls.
                    Replaced with a `<span id>` + `role="group"
                    aria-labelledby"` on the wrapper so screen readers
                    still announce the group's accessible name.

                    Round 2 MED-08 fix (2026-05-13) — dropped
                    redundant `aria-label` on `<code>`. The accessible
                    name is already supplied via the `role="group"
                    aria-labelledby` wrapper; double-announcement
                    behaviour varies across screen readers and adds no
                    information.
                  */}
                  <code
                    className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm"
                  >
                    {view.webhookUrl}
                  </code>
                  <CopyButton value={view.webhookUrl} label={t('copyUrl')} />
                </div>
              </div>

              <div
                className="flex flex-col gap-1"
                role="group"
                aria-labelledby="webhook-secret-label"
              >
                <span id="webhook-secret-label" className="text-sm font-medium">
                  {t('secretLabel')}
                </span>
                <div className="flex items-center gap-2">
                  <code
                    className="rounded-md border bg-muted px-3 py-2 font-mono text-sm"
                  >
                    whsec_{'•'.repeat(16)}
                    {configured?.secretLastFour ?? ''}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRotateOpen(true)}
                    className="min-h-11"
                  >
                    {t('rotateButton')}
                  </Button>
                </div>
                {graceActiveUntilDisplay ? (
                  <Badge variant="secondary" className="self-start">
                    {t('graceActiveUntil', {
                      timestamp: graceActiveUntilDisplay,
                    })}
                  </Badge>
                ) : null}
              </div>

              <TestWebhookButton onResolved={() => router.refresh()} />
            </CardContent>
          </Card>

          <RecentDeliveriesPanel
            deliveries={view.recentDeliveries}
            includeTestDeliveries={view.recentDeliveriesIncludeTests}
          />
        </div>
      )}

      <RotateSecretDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        onRotationAcknowledged={handleRotationAcknowledged}
      />
    </div>
  );
}

// Round 2 refactor (2026-05-13) — `formatGraceTimestamp` extracted to
// `src/lib/format-grace-timestamp.ts` so the rotate-secret dialog and
// any future grace-window surface share one implementation (Bangkok-
// pinned timezone, defensive Invalid Date fallback).
