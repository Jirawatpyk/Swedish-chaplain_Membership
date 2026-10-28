// RED stub: no host guard, no read-only transaction, no redaction.
import postgres from 'postgres';

export interface ReadOnlyClient {
  readonly host: string;
  query(text: string): Promise<readonly Record<string, unknown>[]>;
  end(): Promise<void>;
}

export function openReadOnlyClient(url: string, _blocklistRaw: string | undefined): ReadOnlyClient {
  const sql = postgres(url, { max: 1, ssl: 'require' });
  return {
    host: '',
    query: async (text) => [...(await sql.unsafe(text))] as Record<string, unknown>[],
    end: () => sql.end(),
  };
}

export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  return row;
}
