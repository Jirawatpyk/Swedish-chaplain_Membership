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
import { Alert, Card, Icon } from '@jirawatpyk/aura-react/server';

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
    // Spec 122 US9c — AURA (server): the English-only notice is an info
    // note, each step a Card with its number in an accent circle.
    <section
      className="flex flex-col gap-[var(--aura-space-4)]"
      aria-labelledby="zapier-walkthrough-heading"
    >
      <h2 id="zapier-walkthrough-heading" className="aura-text-h3">
        {t('title')}
      </h2>

      <Alert tone="info" role="note">
        {t('englishOnlyNotice')}
      </Alert>

      {/* role="list": preflight's list-style:none drops the list role in Safari. */}
      <ol role="list" aria-label={t('stepsLabel')} className="flex flex-col gap-[var(--aura-space-3)]">
        {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((step) => (
          <li key={step}>
            <Card>
              <div className="flex flex-col gap-[var(--aura-space-3)] sm:flex-row sm:items-start">
                <div
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--aura-fg-accent)] font-semibold text-[var(--aura-bg-surface)]"
                >
                  {step}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-[var(--aura-space-2)]">
                  <h3 className="font-semibold">{t(`step${step}.title`)}</h3>
                  <p className="text-[var(--aura-fg-secondary)]">
                    {step === 4
                      ? // Round-6 verify-fix 2026-05-13 (UX M-02) — the URL in mono.
                        t.rich('step4.body', {
                          webhookUrl,
                          code: (chunks) => (
                            <code className="aura-text-mono rounded-[var(--aura-radius-sm)] bg-[var(--aura-bg-surface-hover)] px-[var(--aura-space-1)] [overflow-wrap:anywhere]">
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
                      <figure>
                        {isStub ? (
                          <div
                            role="img"
                            aria-label={t(`step${step}.alt`)}
                            className="flex aspect-video w-full flex-col items-center justify-center gap-[var(--aura-space-2)] rounded-[var(--aura-radius-md)] border border-dashed border-[var(--aura-border-default)] bg-[var(--aura-bg-canvas)] p-[var(--aura-space-6)] text-center text-[var(--aura-fg-secondary)]"
                          >
                            <Icon name="image" size={40} className="opacity-50" />
                            <span className="font-medium">{t(`step${step}.alt`)}</span>
                            <span className="aura-text-caption">
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
                            className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]"
                            sizes="(max-width: 640px) 100vw, 600px"
                          />
                        )}
                      </figure>
                    );
                  })()}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}
