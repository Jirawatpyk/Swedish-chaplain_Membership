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
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { InfoIcon, ImageIcon } from 'lucide-react';

/**
 * Phase 5 review-fix (2026-05-13) — detect 75-byte placeholder stub
 * PNGs at build time so the walkthrough doesn't render a broken-image
 * icon + huge empty `<Image>` box when real screenshots have not yet
 * landed (T080a stakeholder gate). Threshold ≤1024 B is safe: a real
 * 1280×720 PNG is ≥40 KB, the stubs are exactly 75 B. The check is
 * cheap server-side (fs.statSync) and runs once per render.
 *
 * TODO [T080a]: when real Zapier screenshots are committed to
 * `public/walkthroughs/eventcreate-zapier/step-{1..8}.png`:
 *   1. The stub-detection switch flips automatically (no code change).
 *   2. Remove this helper + the dashed-placeholder branch below.
 *   3. Delete `phaseB.imagePlaceholderNotice` from en/th/sv.json.
 *   4. Drop the `node:fs` / `node:path` imports at the top of the
 *      file.
 * Grep for `T080a` to find every related stakeholder-asset gate.
 */
function isPlaceholderStub(absolutePath: string): boolean {
  try {
    if (!existsSync(absolutePath)) return true;
    const size = statSync(absolutePath).size;
    return size <= 1024;
  } catch {
    return true;
  }
}

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

      {/*
        Phase 5 review-fix (2026-05-13) — info banner uses
        `<Card size="sm">` so the compact padding comes from the Card
        root (12px py + 12px gap via the `data-[size=sm]:` rules) and
        CardContent no longer needs the `py-3` override that
        previously stacked on top of Card root's default 24px py.
      */}
      <Card size="sm" className="border-info/30 bg-info-surface">
        <CardContent className="flex items-start gap-3 text-sm">
          <InfoIcon className="size-4 shrink-0 text-info" aria-hidden />
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
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start">
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
                  {/*
                    Phase 5 review-fix (2026-05-13) — when the PNG is a
                    stub (≤1024 B placeholder, the T080a stakeholder
                    gate has not been completed), render a clean
                    skeleton placeholder instead of `<Image>`. next/
                    image with hardcoded 1280×720 would otherwise
                    reserve a giant gray box and show the browser's
                    broken-image icon at top-left (see
                    `docs/Bug/image (11).png`). The skeleton uses
                    `aspect-video` so the layout shape matches the
                    eventual 16:9 screenshot — zero CLS when real
                    PNGs land.
                  */}
                  {(() => {
                    const imgPath = `/walkthroughs/eventcreate-zapier/step-${step}.png`;
                    const absolutePath = join(
                      process.cwd(),
                      'public',
                      'walkthroughs',
                      'eventcreate-zapier',
                      `step-${step}.png`,
                    );
                    const isStub = isPlaceholderStub(absolutePath);
                    return (
                      <figure className="space-y-1">
                        {isStub ? (
                          <div
                            role="img"
                            aria-label={t(`step${step}.alt`)}
                            className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/40 p-6 text-muted-foreground"
                          >
                            <ImageIcon
                              className="size-10 opacity-50"
                              aria-hidden
                            />
                            <span className="text-sm font-medium">
                              {t(`step${step}.alt`)}
                            </span>
                            <span className="text-xs">
                              {t('imagePlaceholderNotice')}
                            </span>
                          </div>
                        ) : (
                          // Real screenshot — no figcaption. The placeholder
                          // copy at `imagePlaceholderNotice` is specific to
                          // the stub state and would mislead admins viewing
                          // real walkthrough images.
                          <Image
                            src={imgPath}
                            alt={t(`step${step}.alt`)}
                            width={1280}
                            height={720}
                            className="rounded-md border bg-muted"
                            sizes="(max-width: 640px) 100vw, 600px"
                          />
                        )}
                      </figure>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}
