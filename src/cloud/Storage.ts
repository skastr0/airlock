/**
 * The part of a Durable Object's storage these adapters use, typed
 * structurally so this package depends on no Cloudflare type package. A
 * SQLite-backed Durable Object's `ctx.storage` satisfies it as it is.
 */
export type SqlValue = ArrayBuffer | string | number | null

export interface SqlCursor<Row> {
  toArray(): Array<Row>
  readonly rowsWritten: number
}

export interface DurableSql {
  exec<Row extends Record<string, SqlValue>>(query: string, ...bindings: Array<SqlValue>): SqlCursor<Row>
}

export interface DurableStorage {
  readonly sql: DurableSql
  /** Runs `closure` as one SQLite transaction; a throw rolls it back. */
  transactionSync<Result>(closure: () => Result): Result
}

/**
 * Creates the tables once. It is idempotent, so every adapter runs it when it
 * is built and a host needs no separate migration step.
 *
 * `state` is stored beside the record so that the compare-and-set in
 * `transition` and the filter in `list` are done by SQLite, not after decoding.
 * `ledger.key` is unique; SQLite treats NULLs as distinct, so entries without
 * a key are always appended.
 */
export const ensureSchema = (storage: DurableStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS airlock_emission (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      record TEXT NOT NULL,
      dispatch_digest TEXT NOT NULL,
      dispatch TEXT NOT NULL,
      response BLOB
    ) WITHOUT ROWID
  `)
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS airlock_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      entry TEXT NOT NULL
    )
  `)
}
