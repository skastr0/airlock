import { Context, Effect, Layer, Result, Schema, Semaphore } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
  type FileHandle
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { AirlockHome } from "../AirlockHome.ts"
import { Ledger, LedgerEntry, LedgerFailed } from "../core/ledger/Ledger.ts"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"
import { reasonOf } from "../FailureText.ts"

/**
 * Append-only receipt history.
 *
 * A successful `record` means one schema-valid JSONL record has been written,
 * the ledger file has been fsynced, and its parent directory has been fsynced.
 * A realm-wide macOS descriptor lease serializes both readers and writers
 * across runtimes and processes.
 */
export class FileLedger extends Context.Service<
  FileLedger,
  {
    readonly record: (entry: LedgerEntry) => Effect.Effect<void, LedgerError>
    readonly entries: Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerError>
  }
>()("airlock/host/FileLedger") {}

const LedgerFilesystemOperation = Schema.Literals([
  "lock",
  "append",
  "close",
  "open",
  "quarantine",
  "read",
  "sync-directory",
  "sync-file",
  "truncate"
])
type LedgerFilesystemOperation = typeof LedgerFilesystemOperation.Type

export class LedgerFilesystemError extends Schema.TaggedError<LedgerFilesystemError>()(
  "LedgerFilesystemError",
  {
    operation: LedgerFilesystemOperation,
    path: Schema.String,
    reason: Schema.String
  }
) {}

export class LedgerDecodeError extends Schema.TaggedError<LedgerDecodeError>()(
  "LedgerDecodeError",
  {
    path: Schema.String,
    line: Schema.Finite,
    reason: Schema.String
  }
) {}

/**
 * Durable evidence that an incomplete final record was retained outside the
 * canonical journal before the journal was truncated to its last valid
 * newline. The first operation that discovers the fragment fails with this
 * receipt; a deliberate retry proceeds against the repaired journal.
 */
export class LedgerTailQuarantined extends Schema.TaggedError<LedgerTailQuarantined>()(
  "LedgerTailQuarantined",
  {
    path: Schema.String,
    quarantinePath: Schema.String,
    line: Schema.Finite,
    offset: Schema.Finite,
    bytes: Schema.Finite,
    sha256: Schema.String,
    reason: Schema.String
  }
) {}

export class LedgerQuarantineEvidence extends Schema.Class<LedgerQuarantineEvidence>(
  "LedgerQuarantineEvidence"
)({
  schemaVersion: Schema.Literal("airlock/ledger-quarantine/v1"),
  path: Schema.String,
  line: Schema.Finite,
  offset: Schema.Finite,
  bytes: Schema.Finite,
  sha256: Schema.String,
  rawBase64: Schema.String
}) {}

export type LedgerError =
  | LedgerFilesystemError
  | LedgerDecodeError
  | LedgerTailQuarantined

const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(LedgerEntry))
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(LedgerEntry))
const encodeQuarantine = Schema.encodeEffect(
  Schema.fromJsonString(LedgerQuarantineEvidence)
)

const errorCode = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined

class LedgerIoCause {
  readonly _tag = "LedgerIoCause"

  constructor(
    readonly operation: LedgerFilesystemOperation,
    readonly path: string,
    readonly cause: unknown
  ) {}
}

const ioStep = async <A>(
  operation: LedgerFilesystemOperation,
  path: string,
  run: () => Promise<A>
): Promise<A> => {
  try {
    return await run()
  } catch (cause) {
    if (cause instanceof LedgerIoCause) throw cause
    throw new LedgerIoCause(operation, path, cause)
  }
}

const withFile = async <A>(
  path: string,
  flags: string | number,
  mode: number | undefined,
  use: (handle: FileHandle) => Promise<A>
): Promise<A> => {
  const handle = await ioStep("open", path, () => open(path, flags, mode))
  let primaryFailure: unknown
  try {
    return await use(handle)
  } catch (cause) {
    primaryFailure = cause
    throw cause
  } finally {
    try {
      await handle.close()
    } catch (cause) {
      if (primaryFailure === undefined) {
        throw new LedgerIoCause("close", path, cause)
      }
    }
  }
}

const writeFully = async (handle: FileHandle, bytes: Buffer) => {
  let offset = 0
  while (offset < bytes.length) {
    const written = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null
    )
    if (written.bytesWritten < 1) {
      throw new Error("write returned without making progress")
    }
    offset += written.bytesWritten
  }
}

const ioEffect = <A>(
  fallbackOperation: LedgerFilesystemOperation,
  fallbackPath: string,
  run: () => Promise<A>
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const failure =
        cause instanceof LedgerIoCause
          ? cause
          : new LedgerIoCause(fallbackOperation, fallbackPath, cause)
      return new LedgerFilesystemError({
        operation: failure.operation,
        path: failure.path,
        reason: reasonOf(failure.cause)
      })
    }
  })

const syncDirectory = async (directory: string) =>
  withFile(directory, "r", undefined, (handle) =>
    ioStep("sync-directory", directory, () => handle.sync())
  )

const appendDurably = (ledgerFile: string, bytes: Buffer) => {
  const directory = dirname(ledgerFile)
  return ioEffect("append", ledgerFile, async () => {
    await withFile(
      ledgerFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      0o600,
      async (handle) => {
        await ioStep("append", ledgerFile, () => writeFully(handle, bytes))
        await ioStep("sync-file", ledgerFile, () => handle.sync())
      }
    )
    // File fsync makes the bytes durable; directory fsync makes first
    // publication of the ledger name durable as well.
    await syncDirectory(directory)
  })
}

const createQuarantineDurably = (
  directory: string,
  quarantinePath: string,
  bytes: Buffer
) =>
  ioEffect("quarantine", quarantinePath, async () => {
    await withFile(
      quarantinePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      async (handle) => {
        await ioStep("quarantine", quarantinePath, () =>
          writeFully(handle, bytes)
        )
        await ioStep("sync-file", quarantinePath, () => handle.sync())
      }
    )
    // The evidence is durable before canonical history is shortened.
    await syncDirectory(directory)
  })

const truncateDurably = (ledgerFile: string, bytes: number) => {
  const directory = dirname(ledgerFile)
  return ioEffect("truncate", ledgerFile, async () => {
    await withFile(ledgerFile, "r+", undefined, async (handle) => {
      await ioStep("truncate", ledgerFile, () => handle.truncate(bytes))
      await ioStep("sync-file", ledgerFile, () => handle.sync())
    })
    await syncDirectory(directory)
  })
}

const readLedger = (ledgerFile: string) =>
  ioEffect("read", ledgerFile, async () => {
    try {
      return await readFile(ledgerFile)
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return Buffer.alloc(0)
      throw new LedgerIoCause("read", ledgerFile, cause)
    }
  })

/**
 * Normal appends do not scan an ever-growing journal. We inspect one byte and
 * parse history only on the exceptional path where the JSONL terminator is
 * absent.
 */
const hasTornTail = (ledgerFile: string) =>
  ioEffect("read", ledgerFile, async () => {
    try {
      return await withFile(ledgerFile, "r", undefined, async (handle) => {
        const info = await ioStep("read", ledgerFile, () => handle.stat())
        if (info.size < 1) return false
        const finalByte = Buffer.allocUnsafe(1)
        const read = await ioStep("read", ledgerFile, () =>
          handle.read(finalByte, 0, 1, info.size - 1)
        )
        if (read.bytesRead !== 1) {
          throw new LedgerIoCause(
            "read",
            ledgerFile,
            "could not read the final journal byte"
          )
        }
        return finalByte[0] !== 0x0a
      })
    } catch (cause) {
      if (
        cause instanceof LedgerIoCause &&
        errorCode(cause.cause) === "ENOENT"
      ) {
        return false
      }
      throw cause
    }
  })

/**
 * The bytes appended at or after `from`, or `undefined` when the journal is
 * now shorter than `from` (a torn tail was quarantined) and must be re-read.
 */
const readAppended = (ledgerFile: string, from: number) =>
  ioEffect("read", ledgerFile, async () => {
    try {
      return await withFile(ledgerFile, "r", undefined, async (handle) => {
        const info = await ioStep("read", ledgerFile, () => handle.stat())
        if (info.size < from) return undefined
        const bytes = Buffer.allocUnsafe(info.size - from)
        let filled = 0
        while (filled < bytes.length) {
          const read = await ioStep("read", ledgerFile, () =>
            handle.read(bytes, filled, bytes.length - filled, from + filled)
          )
          if (read.bytesRead === 0) break
          filled += read.bytesRead
        }
        return bytes.subarray(0, filled)
      })
    } catch (cause) {
      if (
        cause instanceof LedgerIoCause &&
        errorCode(cause.cause) === "ENOENT"
      ) {
        return Buffer.alloc(0)
      }
      throw cause
    }
  })

/** The `key` of one journal line, if it is a keyed entry. */
const keyOfLine = (line: Buffer): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(line.toString("utf8"))
    return typeof parsed === "object" && parsed !== null && "key" in parsed &&
        typeof parsed.key === "string"
      ? parsed.key
      : undefined
  } catch {
    // An undecodable line is reported by `entries`; it carries no key.
    return undefined
  }
}

type JournalSplit = Readonly<{
  readonly completeBytes: number
  readonly completeLines: ReadonlyArray<Buffer>
  readonly tail: Buffer
}>

const splitJournal = (raw: Buffer): JournalSplit => {
  const finalNewline = raw.lastIndexOf(0x0a)
  const completeBytes = finalNewline < 0 ? 0 : finalNewline + 1
  const completeLines: Array<Buffer> = []
  let cursor = 0
  while (cursor < completeBytes) {
    const newline = raw.indexOf(0x0a, cursor)
    completeLines.push(raw.subarray(cursor, newline))
    cursor = newline + 1
  }
  return {
    completeBytes,
    completeLines,
    tail: raw.subarray(completeBytes)
  }
}

const decodeLine = (
  ledgerFile: string,
  bytes: Buffer,
  line: number
): Effect.Effect<LedgerEntry, LedgerDecodeError> => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (cause) {
    return Effect.fail(
      new LedgerDecodeError({
        path: ledgerFile,
        line,
        reason: `invalid UTF-8: ${reasonOf(cause)}`
      })
    )
  }
  if (text.trim().length === 0) {
    return Effect.fail(
      new LedgerDecodeError({
        path: ledgerFile,
        line,
        reason: "empty JSONL record"
      })
    )
  }
  return decodeEntry(text).pipe(
    Effect.mapError(
      (cause) =>
        new LedgerDecodeError({
          path: ledgerFile,
          line,
          reason: reasonOf(cause)
        })
    )
  )
}

const decodeCompleteLines = (
  ledgerFile: string,
  lines: ReadonlyArray<Buffer>
) =>
  Effect.forEach(lines, (line, index) =>
    decodeLine(ledgerFile, line, index + 1)
  )

const quarantineTail = Effect.fnUntraced(function* (
  ledgerFile: string,
  split: JournalSplit
) {
  const line = split.completeLines.length + 1
  const sha256 = createHash("sha256").update(split.tail).digest("hex")
  const quarantinePath =
    `${ledgerFile}.corrupt.${split.completeBytes}.` +
    `${sha256.slice(0, 16)}.${randomUUID()}.json`
  const evidence = new LedgerQuarantineEvidence({
    schemaVersion: "airlock/ledger-quarantine/v1",
    path: ledgerFile,
    line,
    offset: split.completeBytes,
    bytes: split.tail.length,
    sha256,
    rawBase64: split.tail.toString("base64")
  })
  const encoded = yield* encodeQuarantine(evidence).pipe(
    Effect.mapError(
      (cause) =>
        new LedgerDecodeError({
          path: ledgerFile,
          line,
          reason: `cannot encode quarantine evidence: ${reasonOf(cause)}`
        })
    )
  )

  yield* createQuarantineDurably(
    dirname(ledgerFile),
    quarantinePath,
    Buffer.from(`${encoded}\n`, "utf8")
  )
  yield* truncateDurably(ledgerFile, split.completeBytes)
  return new LedgerTailQuarantined({
    path: ledgerFile,
    quarantinePath,
    line,
    offset: split.completeBytes,
    bytes: split.tail.length,
    sha256,
    reason: "incomplete final JSONL record was quarantined before repair"
  })
})

/**
 * A schema-valid final fragment is a complete receipt whose newline was torn:
 * recover it by durably installing the terminator. An invalid fragment is
 * durably quarantined before removal and reported to the caller.
 *
 * Complete records are decoded before either repair, so corruption in the
 * middle is never skipped or silently rewritten.
 */
const normalizeTail = Effect.fnUntraced(function* (ledgerFile: string) {
  if (!(yield* hasTornTail(ledgerFile))) return

  const split = splitJournal(yield* readLedger(ledgerFile))
  yield* decodeCompleteLines(ledgerFile, split.completeLines)
  const tail = yield* decodeLine(
    ledgerFile,
    split.tail,
    split.completeLines.length + 1
  ).pipe(Effect.result)

  if (Result.isSuccess(tail)) {
    yield* appendDurably(ledgerFile, Buffer.from("\n"))
    return
  }

  return yield* Effect.fail(yield* quarantineTail(ledgerFile, split))
})

export const FileLedgerLive = Layer.effect(
  FileLedger,
  Effect.gen(function* () {
    const { ledgerFile } = yield* AirlockHome
    const lockRoot = dirname(ledgerFile)
    const lockFile = `${ledgerFile}.lock`
    const localMutex = yield* Semaphore.make(1)
    const lock = makeExclusiveFileLock<LedgerFilesystemError>({
      root: lockRoot,
      active: lockFile,
      onError: (operation, path, cause) =>
        new LedgerFilesystemError({
          operation: "lock",
          path,
          reason: `${operation}: ${reasonOf(cause)}`
        })
    })

    /*
     * Which keys are already in the journal, answered without reading it.
     *
     *   <ledger>.keys/<sha256 of key>   one empty marker per recorded key
     *   <ledger>.keys/scanned           journal length the markers cover
     *
     * A marker is written after its entry is durable and is not itself
     * flushed, so a crash can lose a marker but never invent one. A missing
     * marker is therefore checked against the journal bytes past `scanned`.
     * When that stretch grows past `rescanBytes`, every key in it is marked,
     * the markers are flushed, and only then does `scanned` move forward, so
     * the stretch read on a miss stays bounded however long the journal is.
     * The directory is created by the first keyed record.
     */
    const rescanBytes = 64 * 1024
    const keysDirectory = `${ledgerFile}.keys`
    const scannedFile = join(keysDirectory, "scanned")
    const markerOf = (key: string) =>
      join(keysDirectory, createHash("sha256").update(key).digest("hex"))
    const present = (target: string) =>
      ioEffect("read", target, async () => {
        try {
          await stat(target)
          return true
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return false
          throw cause
        }
      })
    const mark = (keys: ReadonlyArray<string>, durable = false) =>
      ioEffect("append", keysDirectory, async () => {
        await mkdir(keysDirectory, { recursive: true, mode: 0o700 })
        for (const key of keys) await writeFile(markerOf(key), "", { mode: 0o600 })
        if (durable) await withFile(keysDirectory, "r", undefined, (handle) => handle.sync())
      })
    const readScanned = ioEffect("read", scannedFile, async () => {
      try {
        const value = Number(await readFile(scannedFile, "utf8"))
        return Number.isSafeInteger(value) && value >= 0 ? value : 0
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return 0
        throw cause
      }
    })
    const writeScanned = (bytes: number) =>
      ioEffect("append", scannedFile, async () => {
        const next = `${scannedFile}.next-${randomUUID()}`
        await writeFile(next, String(bytes), { mode: 0o600 })
        await rename(next, scannedFile)
      })

    let scannedBytes: number | undefined
    const alreadyRecorded = Effect.fnUntraced(function* (key: string) {
      if (yield* present(markerOf(key))) return true
      scannedBytes ??= yield* readScanned
      let appended = yield* readAppended(ledgerFile, scannedBytes)
      if (appended === undefined) {
        // The journal is shorter than the markers claim to cover. They are
        // no longer evidence: set them aside and rebuild from the journal.
        yield* ioEffect("quarantine", keysDirectory, () =>
          rename(keysDirectory, `${keysDirectory}.stale-${randomUUID()}`))
        scannedBytes = 0
        appended = (yield* readAppended(ledgerFile, 0)) ?? Buffer.alloc(0)
      }
      const split = splitJournal(appended)
      const found = split.completeLines.flatMap((line) => {
        const lineKey = keyOfLine(line)
        return lineKey === undefined ? [] : [lineKey]
      })
      if (split.completeBytes > rescanBytes) {
        yield* mark(found, true)
        scannedBytes += split.completeBytes
        yield* writeScanned(scannedBytes)
      }
      return found.includes(key)
    })

    const recordCritical = Effect.fnUntraced(function* (entry: LedgerEntry) {
      const line = yield* encodeEntry(entry).pipe(
        Effect.mapError(
          (cause) =>
            new LedgerDecodeError({
              path: ledgerFile,
              line: 0,
              reason: `cannot encode receipt: ${reasonOf(cause)}`
            })
        )
      )
      yield* normalizeTail(ledgerFile)
      // A keyed entry is recorded exactly once: replaying it is a no-op.
      if (entry.key !== undefined && (yield* alreadyRecorded(entry.key))) return
      yield* appendDurably(ledgerFile, Buffer.from(`${line}\n`, "utf8"))
      if (entry.key !== undefined) yield* mark([entry.key])
    })

    const entriesCritical = Effect.fnUntraced(function* () {
      const split = splitJournal(yield* readLedger(ledgerFile))
      const entries = yield* decodeCompleteLines(
        ledgerFile,
        split.completeLines
      )
      if (split.tail.length === 0) return entries

      const tail = yield* decodeLine(
        ledgerFile,
        split.tail,
        split.completeLines.length + 1
      ).pipe(Effect.result)
      if (Result.isSuccess(tail)) {
        yield* appendDurably(ledgerFile, Buffer.from("\n"))
        return [...entries, tail.success]
      }

      return yield* Effect.fail(yield* quarantineTail(ledgerFile, split))
    })

    return FileLedger.of({
      // The descriptor must not be released while a non-cancellable Node I/O
      // promise still owns a journal transition. Waiting for the lease remains
      // interruptible; once admitted, the short durability transaction is not.
      record: (entry) =>
        lock
          .withLock(Effect.uninterruptible(recordCritical(entry)))
          .pipe(Semaphore.withPermit(localMutex)),
      entries: lock
        .withLock(Effect.uninterruptible(entriesCritical()))
        .pipe(Semaphore.withPermit(localMutex))
    })
  })
)

/**
 * The core Ledger port over the same file ledger. The kernel needs only
 * "durably recorded or not"; `cause` carries this adapter's error tag so host
 * code can route to the richer recovery through `FileLedger`.
 */
export const ledgerLayer: Layer.Layer<Ledger, never, FileLedger> = Layer.effect(
  Ledger,
  Effect.map(FileLedger, (file) => {
    const failed = (operation: "record" | "read") => (error: LedgerError) =>
      new LedgerFailed({ operation, cause: error._tag, reason: reasonOf(error) })
    return Ledger.of({
      record: (entry) => file.record(entry).pipe(Effect.mapError(failed("record"))),
      entries: file.entries.pipe(Effect.mapError(failed("read")))
    })
  })
)
