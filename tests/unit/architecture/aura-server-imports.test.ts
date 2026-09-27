/**
 * Spec 122 — a server file never imports AURA's root barrel.
 *
 * Everything at `@jirawatpyk/aura-react` is a client module: a Server
 * Component that imports even one static Card from it turns it into a client
 * reference and pulls the barrel (~138 KB) into that route's bundle. Server
 * files take Card, Badge, StatusPill, Alert, EmptyState, Icon and
 * buttonClass from `@jirawatpyk/aura-react/server` (AURA 5.8, handoff #68);
 * anything interactive lives in a `'use client'` file that imports the root.
 * Type-only imports are erased at build time and are fine anywhere.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

/** Client-only modules that are not components, so they carry no directive. */
const CLIENT_ONLY_MODULES = new Set([
  // the toast facade: every importer is a client component (it calls toast in handlers)
  'src/lib/toast.ts',
]);

const ROOT_VALUE_IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+['"]@jirawatpyk\/aura-react['"]/m;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** True when the module's first statement is the `'use client'` directive. */
export function isClientModule(source: string): boolean {
  const code = source
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trimStart();
  return /^['"]use client['"]/.test(code);
}

export function importsAuraRoot(source: string): boolean {
  return ROOT_VALUE_IMPORT.test(source.replace(/\r/g, ''));
}

describe('AURA imports in server files (spec 122)', () => {
  it('no server file imports a value from the @jirawatpyk/aura-react root', () => {
    const files = sourceFiles(join(ROOT, 'src'));
    const rootImporters = files.filter((f) => importsAuraRoot(readFileSync(f, 'utf8')));
    // positive control: the scan must find the client importers, or it is not looking
    expect(rootImporters.length).toBeGreaterThan(20);
    const offenders = rootImporters
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
      .filter((rel) => !CLIENT_ONLY_MODULES.has(rel))
      .filter((rel) => !isClientModule(readFileSync(join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('control: tells a server file from a client one, and a value import from a type import', () => {
    const server = "/** doc */\nimport { Card } from '@jirawatpyk/aura-react';\r\n";
    const client = "/** doc */\n// note\n'use client';\nimport { Card } from '@jirawatpyk/aura-react';\n";
    expect(importsAuraRoot(server)).toBe(true);
    expect(isClientModule(server)).toBe(false);
    expect(isClientModule(client)).toBe(true);
    expect(importsAuraRoot("import type { CardProps } from '@jirawatpyk/aura-react';")).toBe(false);
    expect(importsAuraRoot("import { Card } from '@jirawatpyk/aura-react/server';")).toBe(false);
  });
});
