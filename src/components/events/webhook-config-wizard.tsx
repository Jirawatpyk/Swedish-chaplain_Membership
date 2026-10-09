'use client';

/**
 * Webhook config wizard orchestrator (F6 Phase 5 / US3).
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
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Card, Icon, Stepper } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { CopyButton } from '@/components/members/copy-button';
import { formatGraceTimestamp } from '@/lib/format-grace-timestamp';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';
import { adminPost } from '@/lib/http/admin-post';
import type { IntegrationConfigView } from '@/lib/events-admin-integration-types';
import { WebhookSecretReveal } from './webhook-secret-reveal';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { TestWebhookButton } from './test-webhook-button';
import { RecentDeliveriesPanel } from './recent-deliveries-panel';
import { WebhookValueBox } from './webhook-value-box';

export interface WebhookConfigWizardProps {
  /**
   * The full discriminated `IntegrationConfigView` from the loader.
   * Component narrows on `view.secretConfigured` internally.
   *
   * 05-13 (type-design C4) — was previously a
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
  const locale = useLocale();
  const router = useRouter();

  // Initial phase derives from props: configured tenants land on
  // Phase C; fresh tenants land on Phase A.
  const initialPhase: Phase = view.secretConfigured ? 'c-test' : 'a-generate';
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [generated, setGenerated] = useState<GeneratedSecret | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 09 fix — `<details>` keeps children in
  // the DOM regardless of open state; the controlled `guideOpen`
  // flag short-circuits the 8 walkthrough `<Image>` renders until
  // the admin actually opens the reference panel.
  const [guideOpen, setGuideOpen] = useState(false);

  // 5 — post-`router.refresh()` resync
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
      toast.error(t('postRefreshResyncFailed'), { id: 'webhook-resync-failed' });
    }
    // Intentional: react to phase + view changes; the fixed id keeps the
    // toast idempotent (a repeat replaces it in place instead of stacking).
  }, [phase, view.secretConfigured, t]);

  // Spec 122 US9c — AURA `Stepper` takes the current step and shows the
  // ones before it as done. The phases only move forward through A → B → C
  // (Back from B returns to A's reveal or to C), so that is the same
  // complete / current / upcoming the legacy stepper was given by hand.
  const steps = [
    { id: 'a', label: t('phaseAStep') },
    { id: 'b', label: t('phaseBStep') },
    { id: 'c', label: t('phaseCStep') },
  ];
  const currentStep = phase.startsWith('a-') ? 'a' : phase === 'b-walkthrough' ? 'b' : 'c';

  async function handleGenerate() {
    setGenerating(true);
    try {
      // shared `adminPost` helper replaces the
      // 11-line `Content-Type + Idempotency-Key + body` boilerplate
      // that this file + rotate-secret-dialog + test-webhook-button
      // each carried verbatim.
      const res = await adminPost(
        '/api/admin/integrations/eventcreate/generate-secret',
      );
      if (res.status === 409) {
        // 01 fix — must call `setPhase('c-
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
        // Round 2 simplifier P1 — shared
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
      // 05-13 — surface to DevTools so devs
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
  // 05-13 (UX F-01/F-02) — format ISO
  // timestamp via `formatGraceTimestamp` (the central date helper) so
  // TH/SV/EN see locale-correct date+time strings instead of the raw ISO
  // form. Falls back to the raw ISO if `Date` rejects the input.
  const graceActiveUntilDisplay = configured?.graceActiveUntil
    ? formatGraceTimestamp(locale, configured.graceActiveUntil)
    : null;

  return (
    <div className="flex flex-col gap-[var(--aura-space-5)]">
      <Stepper label={t('stepsLabel')} steps={steps} current={currentStep} />

      {phase === 'a-generate' && !view.secretConfigured && (
        <>
          {/*
            Round 9 banner — EventCreate API access is gated to the
            Corporate plan and up, so the notice sets that expectation at
            the decision point and offers the CSV import as the equivalent
            ingest path. Phase A only: configured tenants have cleared the
            tier gate already.
          */}
          <Alert tone="info" role="note" title={t('tierNotice.title')}>
            <p>{t('tierNotice.body')}</p>
            <p>
              {t.rich('tierNotice.csvFallback', {
                csvLink: (chunks) => (
                  <Link
                    href="/admin/events/import"
                    className="font-medium text-[var(--aura-fg-accent)] underline-offset-2 hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </Alert>

          <Card>
            <div className="flex flex-col items-start gap-[var(--aura-space-4)]">
              <p>{t('phaseAIntro')}</p>
              <Button
                type="button"
                touchHeight
                onClick={() => void handleGenerate()}
                disabled={generating}
                loading={generating}
              >
                {generating ? t('generating') : t('generateButton')}
              </Button>
            </div>
          </Card>
        </>
      )}

      {phase === 'a-reveal' && generated && (
        <WebhookSecretReveal
          secret={generated.secret}
          secretLastFour={generated.secretLastFour}
          onContinue={handleContinueFromReveal}
        />
      )}

      {phase === 'b-walkthrough' && (
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          {walkthrough}
          <div className="flex flex-wrap justify-end gap-[var(--aura-space-2)] max-sm:flex-col-reverse max-sm:[&>button]:w-full">
            {/*
              Round 3 H2 — Back returns to the reveal only while the
              one-time payload is still in memory; otherwise to step 3
              (the 409 / refresh paths clear it).
            */}
            <Button
              type="button"
              variant="ghost"
              touchHeight
              onClick={() =>
                generated ? setPhase('a-reveal') : setPhase('c-test')
              }
            >
              {t('back')}
            </Button>
            <Button type="button" touchHeight onClick={handleWalkthroughComplete}>
              {t('connectComplete')}
            </Button>
          </div>
        </div>
      )}

      {phase === 'c-test' && (
        <>
          {/*
            T102 (US7 FR-008) — the 24h grace banner, shown while the old
            secret still verifies. Informational, and the wizard
            re-renders on every refresh inside the window, so it is a
            polite status rather than an assertive alert.
          */}
          {graceActiveUntilDisplay ? (
            <Alert
              tone="info"
              role="status"
              aria-live="polite"
              data-testid="grace-banner"
              title={t('graceBanner.title')}
            >
              {t('graceBanner.description', {
                graceActiveUntil: graceActiveUntilDisplay,
              })}
            </Alert>
          ) : null}

          {/*
            "View setup guide" (UX D-01) — the Zapier walkthrough stays
            reachable on step 3. A native disclosure drawn as the board's
            bordered row with a chevron; the walkthrough mounts only while
            it is open, so its 8 images are not fetched on every render.
          */}
          <details
            className="group rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] px-[var(--aura-space-4)]"
            onToggle={(e) =>
              setGuideOpen((e.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary
              className="flex min-h-12 cursor-pointer list-none items-center gap-[var(--aura-space-2)] font-medium [&::-webkit-details-marker]:hidden"
              aria-expanded={guideOpen}
            >
              <Icon
                name="chevron-right"
                size={16}
                className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              {t('viewSetupGuide')}
            </summary>
            {guideOpen ? <div className="pb-[var(--aura-space-4)]">{walkthrough}</div> : null}
          </details>

          <Card>
            <div className="flex flex-col gap-[var(--aura-space-4)]">
              {/*
                UX A-04 — a `<span id>` names each group: a `<label>` can
                only point at a form control, and these values are read
                and copied, not edited.
              */}
              <div
                className="flex flex-col gap-[var(--aura-space-2)]"
                role="group"
                aria-labelledby="webhook-url-label"
              >
                <span id="webhook-url-label" className="aura-text-label">
                  {t('webhookUrlLabel')}
                </span>
                <div className="flex min-w-0 items-center gap-[var(--aura-space-2)]">
                  <WebhookValueBox>{view.webhookUrl}</WebhookValueBox>
                  <CopyButton value={view.webhookUrl} label={t('copyUrl')} />
                </div>
              </div>

              <div
                className="flex flex-col gap-[var(--aura-space-2)]"
                role="group"
                aria-labelledby="webhook-secret-label"
              >
                <span id="webhook-secret-label" className="aura-text-label">
                  {t('secretLabel')}
                </span>
                <div className="flex min-w-0 flex-col gap-[var(--aura-space-2)] sm:flex-row sm:items-center">
                  <WebhookValueBox>
                    whsec_{'•'.repeat(16)}
                    {configured?.secretLastFour ?? ''}
                  </WebhookValueBox>
                  <Button
                    type="button"
                    variant="secondary"
                    icon="rotate-ccw"
                    touchHeight
                    className="max-sm:w-full"
                    onClick={() => setRotateOpen(true)}
                  >
                    {t('rotateButton')}
                  </Button>
                </div>
                {graceActiveUntilDisplay ? (
                  <Badge tone="accent" className="self-start">
                    {t('graceActiveUntil', {
                      timestamp: graceActiveUntilDisplay,
                    })}
                  </Badge>
                ) : null}
              </div>

              {/* Board: on phones a rule above, the button full width. */}
              <div className="pt-[var(--aura-space-1)] max-sm:border-t max-sm:border-[var(--aura-border-default)] max-sm:pt-[var(--aura-space-3)]">
                <TestWebhookButton onResolved={() => router.refresh()} />
              </div>
            </div>
          </Card>

          <RecentDeliveriesPanel
            deliveries={view.recentDeliveries}
            includeTestDeliveries={view.recentDeliveriesIncludeTests}
          />
        </>
      )}

      <RotateSecretDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        onRotationAcknowledged={handleRotationAcknowledged}
      />
    </div>
  );
}

// `formatGraceTimestamp` extracted to
// `src/lib/format-grace-timestamp.ts` so the rotate-secret dialog and
// any future grace-window surface share one implementation (Bangkok-
// pinned timezone, defensive Invalid Date fallback).
