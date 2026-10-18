/**
 * RED stub — spec 123 slice 2. The implementation lands in the next commit.
 */
export interface CiE2eTarget {
  readonly databaseUrl: string | undefined;
  readonly unpooledUrl: string | undefined;
  readonly blocklistRaw: string | undefined;
  readonly nodeEnv: string | undefined;
  readonly branchName: string | undefined;
  readonly expectedHost: string | undefined;
  readonly expectedDirectHost: string | undefined;
  readonly created: string | undefined;
}

export interface SeedStep {
  readonly script: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SeedExport {
  readonly key: string;
  readonly value: string;
}

export const BLOCKLIST_PLACEHOLDERS: readonly string[] = [];
export const SEED_CHAIN: readonly SeedStep[] = [];

const notYet = (): never => {
  throw new Error('seed-ci-e2e: not implemented');
};

export function ciE2eTargetRefusal(_t: CiE2eTarget): string | null {
  return notYet();
}
export function childEnv(
  _base: Readonly<Record<string, string | undefined>>,
  _exported: Readonly<Record<string, string>>,
  _step: SeedStep,
): Record<string, string | undefined> {
  return notYet();
}
export function parseSeedExports(_stdout: string): {
  exports: SeedExport[];
  ignored: string[];
  otherLines: string[];
} {
  return notYet();
}
export function githubEnvChunk(_exports: readonly SeedExport[]): { masks: string[]; env: string } {
  return notYet();
}
export function bangkokYear(_now: Date): number {
  return notYet();
}
export function planYearRefusal(_years: readonly number[], _now: Date): string | null {
  return notYet();
}
