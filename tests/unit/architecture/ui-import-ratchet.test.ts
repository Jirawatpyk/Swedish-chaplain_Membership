/**
 * Spec 122 FR-008 — the AURA migration's import ratchet
 * (contracts/lint-ratchet.md, `eslint.ui-ratchet.mjs`).
 *
 * Each ban is proven to FIRE through the real `eslint.config.mjs`, not by
 * reading the config text: a lint rule that is shadowed by a later flat-config
 * block is silent, and silence reads like approval (see auth-barrel.test.ts).
 * The migrated-paths ban is exercised with a fixture glob appended through
 * `overrideConfig` (`MIGRATED_PATHS` must not carry a test-only entry), and
 * through the real list for the US1 shell.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { uiRatchet } from '../../../eslint.ui-ratchet.mjs';

const RULE = '@typescript-eslint/no-restricted-imports';
const FIXTURE_GLOB = 'src/__ratchet_fixture__/**';

async function ratchetHits(
  code: string,
  filePath: string,
  migratedPaths: readonly string[] = [],
): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    ...(migratedPaths.length > 0 ? { overrideConfig: uiRatchet(migratedPaths) } : {}),
  });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe('UI import ratchet (spec 122)', () => {
  it('bans sonner everywhere, in source and in tests', async () => {
    const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
    expect(await ratchetHits(code, 'src/components/some-form.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'tests/unit/some-form.test.tsx')).toHaveLength(1);
  });

  it.each(['formatDate', 'useFormatDate'])('bans AURA %s (our formatter is canonical)', async (name) => {
    const code = `import { ${name} } from '@jirawatpyk/aura-react';\nexport const f = ${name};\n`;
    const hits = await ratchetHits(code, 'src/components/some-view.tsx');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('format-date-localised');
  });

  it('allows the rest of @jirawatpyk/aura-react', async () => {
    const code = "import { Button } from '@jirawatpyk/aura-react';\nexport const B = Button;\n";
    expect(await ratchetHits(code, 'src/components/some-view.tsx')).toEqual([]);
  });

  it('bans cmdk everywhere except the legacy kit host (kept for the pickers until their modules migrate)', async () => {
    const code = "import { Command } from 'cmdk';\nexport const C = Command;\n";
    expect(await ratchetHits(code, 'src/components/shell/palette.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'src/components/ui/command.tsx')).toEqual([]);
  });

  it('keeps the global bans on the cmdk host', async () => {
    const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
    expect(await ratchetHits(code, 'src/components/ui/command.tsx')).toHaveLength(1);
  });

  describe('migrated paths', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";
    const file = 'src/__ratchet_fixture__/page.tsx';

    it('a path on AURA cannot import the legacy kit', async () => {
      const hits = await ratchetHits(legacy, file, [FIXTURE_GLOB]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('MIGRATED_PATHS');
    });

    it('control: the same import outside the list passes', async () => {
      expect(await ratchetHits(legacy, file)).toEqual([]);
    });

    it('the migrated block restates the global bans (flat config replaces, never merges)', async () => {
      const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
      expect(await ratchetHits(code, file, [FIXTURE_GLOB])).toHaveLength(1);
    });

    it('a file named as not-yet-migrated keeps the legacy kit until its phase', async () => {
      const eslint = new ESLint({ cwd: process.cwd(), overrideConfig: uiRatchet([FIXTURE_GLOB], [file]) });
      const [result] = await eslint.lintText(legacy, { filePath: file });
      expect((result?.messages ?? []).filter((m) => m.ruleId === RULE)).toEqual([]);
    });
  });

  describe('the US1 shell is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/components/layout/staff-shell.tsx',
      'src/components/shell/user-menu.tsx',
      'src/components/command-palette/command-palette.tsx',
      'src/components/auth/idle-warning-dialog.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('except the reason dialog, which moves with its callers (US5 / US12)', async () => {
      expect(await ratchetHits(legacy, 'src/components/shell/reason-confirmation-dialog.tsx')).toEqual([]);
    });
  });

  describe('the US2 auth pages are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(auth-public)/admin/sign-in/page.tsx',
      'src/app/(auth-public)/reset-password/[token]/page.tsx',
      'src/components/auth/sign-in-form.tsx',
      'src/components/auth/change-password-form.tsx',
      'src/components/auth/change-password-form-skeleton.tsx',
      'src/components/auth/password-strength.tsx',
      'src/components/auth/security-update-banner.tsx',
      'src/components/auth/auth-frame.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the user-admin screens in the same folder keep the legacy kit until US10', async () => {
      expect(await ratchetHits(legacy, 'src/components/auth/user-list-table.tsx')).toEqual([]);
    });
  });
});
