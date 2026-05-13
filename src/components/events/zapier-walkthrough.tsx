/**
 * T080 helper — Zapier walkthrough (8 steps, Phase B of the wizard).
 *
 * 8 numbered cards with EN-only screenshots (committed under
 * `public/walkthroughs/eventcreate-zapier/`) + per-step localised
 * narration (EN/TH/SV). The "Zapier UI is English only" notice
 * appears at the top per FR-025 + Session 2026-05-12 round 3 Q3 /
 * R12 (the chamber's TH/SV-speaking admin should expect the Zapier
 * web app itself to be EN; our narration translates the steps).
 *
 * Server component — pure render. The wizard orchestrator passes the
 * tenant-specific webhook URL so step 4 ("paste this URL into Zapier")
 * is self-explanatory.
 */
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { InfoIcon } from 'lucide-react';

export interface ZapierWalkthroughProps {
  readonly webhookUrl: string;
}

const STEP_COUNT = 8;

export async function ZapierWalkthrough({ webhookUrl }: ZapierWalkthroughProps) {
  const t = await getTranslations('admin.integrations.eventcreate.phaseB');

  return (
    <section className="space-y-4" aria-labelledby="zapier-walkthrough-heading">
      <h2 id="zapier-walkthrough-heading" className="text-h3 font-semibold">
        {t('title')}
      </h2>

      <Card className="border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/40">
        <CardContent className="flex items-start gap-3 py-3 text-sm">
          <InfoIcon className="size-4 shrink-0 text-blue-600" aria-hidden />
          <p>{t('englishOnlyNotice')}</p>
        </CardContent>
      </Card>

      <ol
        aria-label={t('stepsLabel')}
        className="space-y-4"
      >
        {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((step) => (
          <li key={step}>
            <Card>
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
                  {step}
                </div>
                <div className="flex-1 space-y-2">
                  <h3 className="font-semibold">{t(`step${step}.title`)}</h3>
                  <p className="text-sm text-muted-foreground">
                    {step === 4
                      ? // Round-6 verify-fix 2026-05-13 (UX M-02) —
                        // wrap the inline `webhookUrl` in `<code>` via
                        // ICU rich-text so the admin sees a monospace
                        // copy-affordance instead of the URL melting
                        // into the surrounding paragraph text.
                        t.rich('step4.body', {
                          webhookUrl,
                          code: (chunks) => (
                            <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                              {chunks}
                            </code>
                          ),
                        })
                      : t(`step${step}.body`)}
                  </p>
                  <figure className="space-y-1">
                    <Image
                      src={`/walkthroughs/eventcreate-zapier/step-${step}.png`}
                      alt={t(`step${step}.alt`)}
                      width={1280}
                      height={720}
                      className="rounded-md border bg-muted"
                      sizes="(max-width: 640px) 100vw, 600px"
                    />
                    {/*
                      Round-6 verify-fix 2026-05-13 (UX1) — placeholder
                      caption so the admin knows the .png is illustrative
                      pending the real Zapier capture (stakeholder
                      task T080a). The textual narration above carries
                      the actionable instruction; image is reference
                      only.

                      Round 2 MED-06 fix (2026-05-13) — upgraded from
                      `text-xs italic` to `text-sm not-italic` so
                      contrast against `text-muted-foreground` clears
                      WCAG 2.1 AA at small-text threshold (4.5:1 not
                      3:1 large-text). Italic dropped to recover the
                      ~0.3:1 perceived-contrast loss from oblique
                      stroke widths.

                      TODO [T080a]: remove `<figcaption>` and delete
                      `phaseB.imagePlaceholderNotice` from en/th/sv.json
                      when real captures land. Grep for `T080a` to
                      find this and related stakeholder-asset gates.
                    */}
                    <figcaption className="text-sm text-muted-foreground">
                      {t('imagePlaceholderNotice')}
                    </figcaption>
                  </figure>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}
