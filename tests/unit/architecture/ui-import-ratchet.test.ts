/**
 * Spec 122 FR-008 / FR-017 — the AURA import ratchet
 * (contracts/lint-ratchet.md, `eslint.ui-ratchet.mjs`).
 *
 * Since US13 the legacy kit (`src/components/ui`) is deleted and its import is
 * banned everywhere in `src/**` and `tests/**`, with `sonner`, `cmdk` and
 * AURA's own date formatter.
 *
 * Each ban is proven to FIRE through the real `eslint.config.mjs`, not by
 * reading the config text: a lint rule that a later flat-config block shadows
 * is silent, and silence reads like approval (see auth-barrel.test.ts). The
 * paths below sample every kind of file the old per-phase list covered and
 * several it never did (lib, modules, test fixtures, tests), so a later block
 * that dropped the ban for one of them shows up here.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const RULE = '@typescript-eslint/no-restricted-imports';

async function ratchetHits(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

/** One path per area: the shell, both portals, components, lib, modules, the fixtures and the tests. */
const PATHS = [
  'src/components/layout/staff-shell.tsx',
  'src/app/(auth-public)/admin/sign-in/page.tsx',
  'src/app/(member)/portal/invoices/page.tsx',
  'src/app/(staff)/admin/members/page.tsx',
  'src/app/(staff)/admin/invoices/[invoiceId]/page.tsx',
  'src/app/(staff)/admin/renewals/page.tsx',
  'src/app/(staff)/admin/broadcasts/new/page.tsx',
  'src/app/test-fixtures/aura-admin/page.tsx',
  'src/components/broadcast/compose-form.tsx',
  'src/lib/some-helper.ts',
  'src/modules/members/infrastructure/some-adapter.ts',
  'tests/unit/components/some-view.test.tsx',
  'tests/e2e/some-flow.spec.ts',
] as const;

describe('UI import ratchet (spec 122, global since US13)', () => {
  const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";
  const legacyBarrel = "import { Button } from '@/components/ui';\nexport const B = Button;\n";

  it.each(PATHS)('%s cannot import the legacy kit', async (path) => {
    const hits = await ratchetHits(legacy, path);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('@jirawatpyk/aura-react');
  });

  it('bans the kit folder itself, not only its files', async () => {
    expect(await ratchetHits(legacyBarrel, 'src/components/members/some-card.tsx')).toHaveLength(1);
  });

  it('positive control: an AURA import in the same file passes', async () => {
    const code = "import { Button } from '@jirawatpyk/aura-react';\nexport const B = Button;\n";
    for (const path of PATHS) expect(await ratchetHits(code, path)).toEqual([]);
  });

  it('bans sonner everywhere, in source and in tests', async () => {
    const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
    expect(await ratchetHits(code, 'src/components/some-form.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'tests/unit/some-form.test.tsx')).toHaveLength(1);
  });

  it('bans cmdk everywhere (both palettes and every picker are on AURA Command / Combobox)', async () => {
    const code = "import { Command } from 'cmdk';\nexport const C = Command;\n";
    expect(await ratchetHits(code, 'src/components/shell/palette.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'src/components/ui/command.tsx')).toHaveLength(1);
  });

  it.each(['formatDate', 'useFormatDate'])('bans AURA %s (our formatter is canonical)', async (name) => {
    const code = `import { ${name} } from '@jirawatpyk/aura-react';\nexport const f = ${name};\n`;
    const hits = await ratchetHits(code, 'src/components/some-view.tsx');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('format-date-localised');
  });

  it('one import carrying several bans reports each of them', async () => {
    const code =
      "import { toast } from 'sonner';\nimport { Button } from '@/components/ui/button';\nexport const x = [toast, Button];\n";
    expect(await ratchetHits(code, 'src/app/(staff)/admin/page.tsx')).toHaveLength(2);
  });
});
