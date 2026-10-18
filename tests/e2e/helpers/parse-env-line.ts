/**
 * RED: the parser exactly as `playwright.config.ts` had it inline, so the
 * failing cases are the real bug. Fixed next.
 */
export function parseEnvLine(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  const [, key, rawValue] = match;
  if (!key) return null;
  let value = rawValue ?? '';
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
