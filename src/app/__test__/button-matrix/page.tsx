import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';

// Force request-time evaluation so the guard below runs per request,
// not at static-generation time where it silently traps the route as a
// pre-rendered 404 (leaking the path into the build manifest).
export const dynamic = 'force-dynamic';

const VARIANTS = [
  'default',
  'outline',
  'secondary',
  'ghost',
  'destructive',
  'link',
] as const;

const SIZES = [
  'default',
  'xs',
  'sm',
  'lg',
  'icon',
  'icon-xs',
  'icon-sm',
  'icon-lg',
] as const;

/**
 * Dev/CI-only button matrix used by the E2E suite. Reachable when the
 * opt-in `ALLOW_TEST_ROUTES=1` env var is set (never set in Vercel
 * production). `NODE_ENV` alone is unreliable on Vercel because every
 * deployment — preview and production — ships with
 * `NODE_ENV=production`.
 *
 * **Unauthenticated by design** — the page skips the usual
 * `requireSession()` guard so headless E2E runs can hit it without
 * seeding a session cookie. Consequence: never set `ALLOW_TEST_ROUTES=1`
 * in any environment that carries real session cookies or real user
 * data. CI ephemeral deploys only.
 */
export default function ButtonMatrixPage() {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();

  return (
    <main className="p-6" id="main-content">
      <h1 className="text-h1 mb-4">Button matrix</h1>
      <p className="text-body mb-6 text-muted-foreground">
        {VARIANTS.length}×{SIZES.length}×2 = {VARIANTS.length * SIZES.length * 2} buttons.
      </p>
      <div className="grid gap-6">
        {(['enabled', 'disabled'] as const).map((state) => (
          <section key={state}>
            <h2 className="text-h2 mb-2 capitalize">{state}</h2>
            <table className="w-full text-body">
              <thead>
                <tr>
                  <th className="p-2 text-left">variant \ size</th>
                  {SIZES.map((s) => (
                    <th key={s} className="p-2 text-left">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VARIANTS.map((v) => (
                  <tr key={v}>
                    <th className="p-2 text-left font-medium">{v}</th>
                    {SIZES.map((s) => {
                      const isIcon = s.startsWith('icon');
                      return (
                        <td key={s} className="p-2">
                          <Button
                            variant={v}
                            size={s}
                            disabled={state === 'disabled'}
                            data-testid="button-cell"
                            data-variant={v}
                            data-size={s}
                            data-state={state}
                          >
                            {isIcon ? '★' : 'Btn'}
                          </Button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </main>
  );
}
