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
 * reference material via a "View setup guide" expandable.
 *
 * Receives server-loaded props from the page server component so the
 * first paint shows the correct state without a client-side fetch.
 */
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/members/copy-button';
import { WebhookSecretReveal } from './webhook-secret-reveal';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { TestWebhookButton } from './test-webhook-button';
import {
  RecentDeliveriesPanel,
  type RecentDeliveryRow,
} from './recent-deliveries-panel';

export interface WebhookConfigWizardProps {
  readonly webhookUrl: string;
  readonly secretConfigured: boolean;
  readonly secretLastFour?: string;
  readonly graceActiveUntil?: string | null;
  readonly ingestEnabled: boolean;
  readonly lastReceivedAt?: string | null;
  readonly recentDeliveries: ReadonlyArray<RecentDeliveryRow>;
  readonly includeTestDeliveries: boolean;
  /** Pre-rendered Phase B server component. */
  readonly walkthrough: ReactNode;
}

type Phase = 'a-generate' | 'a-reveal' | 'b-walkthrough' | 'c-test';

interface GeneratedSecret {
  readonly secret: string;
  readonly secretLastFour: string;
}

export function WebhookConfigWizard(props: WebhookConfigWizardProps) {
  const t = useTranslations('admin.integrations.eventcreate.wizard');
  const router = useRouter();

  // Initial phase derives from props: configured tenants land on
  // Phase C; fresh tenants land on Phase A.
  const initialPhase: Phase = props.secretConfigured ? 'c-test' : 'a-generate';
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [generated, setGenerated] = useState<GeneratedSecret | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const steps: StepperStep[] = [
    {
      id: 'a',
      label: t('phaseAStep'),
      status: phase.startsWith('a-')
        ? 'current'
        : props.secretConfigured || generated
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
      const res = await fetch(
        '/api/admin/integrations/eventcreate/generate-secret',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: '{}',
        },
      );
      if (res.status === 409) {
        // Round-6 verify-fix 2026-05-13 — 409 means the secret already
        // exists. Recovery flow: refresh server data + advance to
        // Phase C (masked-secret view) so the admin lands on the
        // configured surface instead of a dead-end toast.
        toast.error(t('generateAlreadyExists'));
        router.refresh();
        return;
      }
      if (!res.ok) {
        // Round-6 verify-fix 2026-05-13 — extract RFC 7807 `detail`
        // from the route's problem-body so 5xx vs 503 (read-only mode)
        // vs 404 (kill-switch) surface distinct copy.
        const problem = await res
          .clone()
          .json()
          .catch(() => null);
        const detail =
          problem && typeof problem === 'object' && 'detail' in problem
            ? (problem as { detail?: unknown }).detail
            : null;
        const message =
          typeof detail === 'string' && detail.length > 0
            ? detail
            : t('generateFailed');
        toast.error(message);
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

  return (
    <div className="space-y-6">
      <Stepper steps={steps} aria-label={t('stepsLabel')} />

      {phase === 'a-generate' && !props.secretConfigured && (
        <Card>
          <CardContent className="flex flex-col gap-4 py-6">
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
          {props.walkthrough}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPhase('a-reveal')}
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
          <Card>
            <CardContent className="flex flex-col gap-4 py-6">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  {t('webhookUrlLabel')}
                </span>
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                    {props.webhookUrl}
                  </code>
                  <CopyButton value={props.webhookUrl} label={t('copyUrl')} />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t('secretLabel')}</span>
                <div className="flex items-center gap-2">
                  <code className="rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                    whsec_{'•'.repeat(16)}
                    {props.secretLastFour ?? ''}
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
                {props.graceActiveUntil ? (
                  <Badge variant="secondary" className="self-start">
                    {t('graceActiveUntil', {
                      timestamp: props.graceActiveUntil,
                    })}
                  </Badge>
                ) : null}
              </div>

              <TestWebhookButton onResolved={() => router.refresh()} />
            </CardContent>
          </Card>

          <RecentDeliveriesPanel
            deliveries={props.recentDeliveries}
            includeTestDeliveries={props.includeTestDeliveries}
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
