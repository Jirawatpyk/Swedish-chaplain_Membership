/**
 * Vitest stub for `next/font/google`.
 *
 * Next.js resolves Google Fonts at build time via a special loader that
 * cannot run in jsdom / Vitest. Any test that transitively imports a
 * file using `next/font/google` (e.g. `src/app/layout.tsx`) would
 * otherwise throw "Geist is not a function" at module-eval time.
 *
 * This stub returns a factory that mimics the CSS-variable object
 * every font call produces, so that the layout module can be imported
 * without a running Next.js build context.
 *
 * Wired in `vitest.config.ts` via `resolve.alias` — do NOT import
 * from production code.
 */

function makeFontFactory(name: string) {
  return function font(_opts?: Record<string, unknown>): {
    variable: string;
    className: string;
    style: { fontFamily: string };
  } {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    return {
      variable: `--font-${slug}`,
      className: `font-${slug}`,
      style: { fontFamily: slug },
    };
  };
}

export const Geist = makeFontFactory('Geist');
export const Geist_Mono = makeFontFactory('Geist-Mono');
export const Inter = makeFontFactory('Inter');
export const Roboto = makeFontFactory('Roboto');
export const Sarabun = makeFontFactory('Sarabun');

// Default export: a proxy so any named Google Font works transparently.
const fontProxy = new Proxy(
  {},
  {
    get(_target, prop: string) {
      return makeFontFactory(prop);
    },
  },
);
export default fontProxy;
