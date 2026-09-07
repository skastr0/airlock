import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"

export class ChangeError extends Schema.TaggedError<ChangeError>()("ChangeError", {
  operation: Schema.String,
  reason: Schema.String
}) {}

export const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ChangeError({ operation, reason: String(cause) }) })

export const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
export const Identity = Schema.Struct({ device: Schema.Number, inode: Schema.Number, birthtime: Schema.Number })
export type Identity = typeof Identity.Type
export const Entry = Schema.Struct({
  path: Schema.String, kind: Schema.Literal("file", "directory"), mode: Schema.Number,
  bytes: Schema.Number, digest: Digest
})
export const Tree = Schema.Struct({
  version: Schema.Literal("regular-tree/v1"), digest: Digest,
  kind: Schema.Literal("file", "directory"), entries: Schema.Array(Entry), bytes: Schema.Number
})
export type Tree = typeof Tree.Type
export const BoundTree = Schema.Struct({ tree: Tree, identity: Identity })
export type BoundTree = typeof BoundTree.Type
export const Parent = Schema.Struct({ path: Schema.String, identity: Identity })
export type Parent = typeof Parent.Type

// The private store is unencrypted. Ordinary permissions are preserved, not
// owner, ACLs, xattrs, flags or timestamps. External writers must be quiescent;
// these checks are not a filesystem CAS or protection from malicious same-UID code.
export const metadataPolicy = "ordinary-posix-mode/v1" as const
export const limits = { bytes: 64 * 1024 * 1024, entries: 4096, depth: 64, storage: 512 * 1024 * 1024, proposals: 128 }
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export const identity = (s: Stats): Identity => ({ device: s.dev, inode: s.ino, birthtime: s.birthtimeMs })
export const sameIdentity = (a: Identity, b: Identity) => a.device === b.device && a.inode === b.inode && a.birthtime === b.birthtime
export const exists = async (p: string) => {
  try { await lstat(p); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
    throw e
  }
}
export const sync = async (p: string) => {
  const h = await open(p, "r")
  try { await h.sync() } finally { await h.close() }
}
export const writeNew = async (p: string, data: string) => {
  const h = await open(p, "wx", 0o600)
  try { await h.writeFile(data); await h.sync() } finally { await h.close() }
  await sync(path.dirname(p))
}

/** Reject links in ancestors too; realpath alone would silently authorize them. */
export const canonical = async (p: string) => {
  const absolute = path.resolve(p)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink: ${cursor}`)
  }
  return realpath(absolute)
}
export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
export const bindTarget = async (raw: string, home: string): Promise<{ target: string, parent: Parent }> => {
  const absolute = path.resolve(raw)
  const parentPath = await canonical(path.dirname(absolute))
  const target = path.join(parentPath, path.basename(absolute))
  if (target === path.parse(target).root || overlaps(target, await canonical(home))) throw new Error("target overlaps AIRLOCK_HOME or root")
  const s = await lstat(parentPath)
  if (!s.isDirectory()) throw new Error("existing directory parent required")
  return { target, parent: { path: parentPath, identity: identity(s) } }
}
export const checkParent = async (target: string, parent: Parent, home: string) => {
  const actual = await bindTarget(target, home)
  if (actual.target !== target || actual.parent.path !== parent.path || !sameIdentity(actual.parent.identity, parent.identity)) throw new Error("parent binding drift")
}

/** Length-delimited JSON tuples in UTF-8 byte-name order; digest excludes identity/time/dir size. */
export const scan = async (root: string, destination?: string, byteLimit = limits.bytes): Promise<BoundTree> => {
  await canonical(root)
  const entries: Array<typeof Entry.Type> = []
  let bytes = 0
  let pathBytes = 0
  let device: number | undefined
  const walk = async (p: string, rel: string, depth: number): Promise<void> => {
    if (depth > limits.depth || entries.length >= limits.entries) throw new Error("tree depth/entry limit")
    pathBytes += Buffer.byteLength(rel)
    if (pathBytes > 256 * 1024) throw new Error("tree path storage limit")
    const before = await lstat(p)
    device ??= before.dev
    if (before.dev !== device || before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw new Error(`unsupported tree topology/kind: ${p}`)
    if ((before.mode & 0o7000) !== 0 || (before.isFile() && before.nlink !== 1)) throw new Error(`unsupported mode/hardlink: ${p}`)
    const kind = before.isFile() ? "file" as const : "directory" as const
    const mode = before.mode & 0o777
    const out = destination === undefined ? undefined : rel === "" ? destination : path.join(destination, rel)
    let contentDigest = hash("")
    if (kind === "file") {
      bytes += before.size
      if (bytes > Math.min(limits.bytes, byteLimit)) throw new Error("tree byte limit")
      const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bound = await h.stat()
        if (!sameIdentity(identity(bound), identity(before))) throw new Error("file binding changed")
        // Bounded read even if a concurrent writer grows the file.
        const content = Buffer.alloc(before.size)
        let offset = 0
        while (offset < content.length) {
          const read = await h.read(content, offset, content.length - offset, offset)
          if (read.bytesRead === 0) throw new Error("file shrank")
          offset += read.bytesRead
        }
        contentDigest = hash(content)
        if (out !== undefined) {
          const dest = await open(out, "wx", 0o600)
          try { await dest.writeFile(content); await dest.chmod(mode); await dest.sync() } finally { await dest.close() }
        }
      } finally { await h.close() }
    } else if (out !== undefined) await mkdir(out, { mode: 0o700 })
    entries.push({ path: rel, kind, mode, bytes: kind === "file" ? before.size : 0, digest: contentDigest })
    if (kind === "directory") {
      const names = await readdir(p, { encoding: "buffer" })
      names.sort(Buffer.compare)
      for (const name of names) {
        const text = Buffer.from(name).toString("utf8")
        if (!Buffer.from(text).equals(name)) throw new Error("non UTF-8 name")
        await walk(path.join(p, text), rel === "" ? text : `${rel}/${text}`, depth + 1)
      }
      if (out !== undefined) { await chmod(out, mode); await sync(out) }
    }
    const after = await lstat(p)
    if (!sameIdentity(identity(before), identity(after)) || before.mode !== after.mode || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("tree changed during observation")
  }
  const rootBefore = identity(await lstat(root))
  await walk(root, "", 0)
  const digest = hash(JSON.stringify(["regular-tree/v1", entries.map(e => [e.path, e.kind, e.mode, e.bytes, e.digest])]))
  return { tree: { version: "regular-tree/v1", digest, kind: entries[0]!.kind, entries, bytes }, identity: rootBefore }
}

export const snapshot = async (source: string, destination: string, byteLimit = limits.bytes) => {
  const first = await scan(source, destination, byteLimit)
  const second = await scan(source)
  const copied = await scan(destination)
  if (!sameIdentity(first.identity, second.identity) || first.tree.digest !== second.tree.digest || first.tree.digest !== copied.tree.digest) throw new Error("unstable snapshot")
  await sync(path.dirname(destination))
  return first
}
export const checkTree = async (p: string, expected: BoundTree | null) => {
  if (expected === null) { if (await exists(p)) throw new Error("expected absent target occupied"); return }
  const actual = await scan(p)
  if (!sameIdentity(actual.identity, expected.identity) || actual.tree.digest !== expected.tree.digest) throw new Error(`tree binding/content/mode drift: ${p}`)
}
