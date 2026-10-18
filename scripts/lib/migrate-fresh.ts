/**
 * Fresh-DB migration mode — RED stub (spec 123 slice 2). Implemented next.
 */
export interface MigrationSqlRunner {
  unsafe(query: string, params?: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export interface MigrationSqlClient extends MigrationSqlRunner {
  begin<T>(fn: (tx: MigrationSqlRunner) => Promise<T>): Promise<T>;
}

export type MigrationMode = 'fresh' | 'normal';

export interface JournalMigration {
  readonly sql: readonly string[];
  readonly folderMillis: number;
  readonly hash: string;
}

export interface TaggedMigration extends JournalMigration {
  readonly tag: string;
}

export interface FreshMigrationResult {
  readonly applied: number;
  readonly skipped: number;
  readonly elapsedMs: number;
}

export async function decideMigrationMode(_client: MigrationSqlClient): Promise<MigrationMode> {
  throw new Error('not implemented');
}

export function attachJournalTags(
  _migrations: readonly JournalMigration[],
  _entries: ReadonlyArray<{ readonly tag: string }>,
): TaggedMigration[] {
  throw new Error('not implemented');
}

export async function applyFreshMigrations(
  _client: MigrationSqlClient,
  _migrations: readonly TaggedMigration[],
): Promise<FreshMigrationResult> {
  throw new Error('not implemented');
}
