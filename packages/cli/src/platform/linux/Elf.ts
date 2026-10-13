import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs"

const elfMagic = [0x7f, 0x45, 0x4c, 0x46] as const
const ptInterp = 3
const maxProgramHeaders = 4_096
const maxInterpreterBytes = 4_096

const readExactly = (fd: number, length: number, position: number) => {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, position + offset)
    if (count === 0) throw new Error("unexpected end of ELF file")
    offset += count
  }
  return bytes
}

const safeBigInt = (value: bigint, field: string) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the safe file-offset range`)
  }
  return Number(value)
}

/** Returns the canonical PT_INTERP object required by a dynamic ELF, if any. */
export const elfInterpreter = (path: string): string | undefined => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const status = fstatSync(fd)
    if (!status.isFile()) throw new Error(`${path} is not a regular file`)
    if (status.size < elfMagic.length) return undefined
    const prefix = readExactly(fd, elfMagic.length, 0)
    if (!elfMagic.every((byte, index) => prefix[index] === byte)) return undefined
    if (status.size < 64) throw new Error(`${path} has a truncated ELF header`)
    const header = readExactly(fd, 64, 0)

    const elfClass = header[4]
    const data = header[5]
    if (elfClass !== 1 && elfClass !== 2) throw new Error(`${path} has an unsupported ELF class`)
    if (data !== 1 && data !== 2) throw new Error(`${path} has an unsupported ELF byte order`)
    const little = data === 1
    const uint16 = (offset: number) => little
      ? header.readUInt16LE(offset)
      : header.readUInt16BE(offset)
    const programOffset = elfClass === 2
      ? safeBigInt(
          little ? header.readBigUInt64LE(32) : header.readBigUInt64BE(32),
          "ELF program-header offset"
        )
      : little ? header.readUInt32LE(28) : header.readUInt32BE(28)
    const entrySize = uint16(elfClass === 2 ? 54 : 42)
    const entryCount = uint16(elfClass === 2 ? 56 : 44)
    const minimumEntrySize = elfClass === 2 ? 56 : 32
    if (entrySize < minimumEntrySize || entryCount > maxProgramHeaders) {
      throw new Error(`${path} has an invalid ELF program-header table`)
    }

    for (let index = 0; index < entryCount; index++) {
      const entry = readExactly(fd, entrySize, programOffset + index * entrySize)
      const type = little ? entry.readUInt32LE(0) : entry.readUInt32BE(0)
      if (type !== ptInterp) continue
      const offset = elfClass === 2
        ? safeBigInt(
            little ? entry.readBigUInt64LE(8) : entry.readBigUInt64BE(8),
            "ELF interpreter offset"
          )
        : little ? entry.readUInt32LE(4) : entry.readUInt32BE(4)
      const length = elfClass === 2
        ? safeBigInt(
            little ? entry.readBigUInt64LE(32) : entry.readBigUInt64BE(32),
            "ELF interpreter length"
          )
        : little ? entry.readUInt32LE(16) : entry.readUInt32BE(16)
      if (length < 2 || length > maxInterpreterBytes) {
        throw new Error(`${path} has an invalid ELF interpreter length`)
      }
      const raw = readExactly(fd, length, offset)
      const terminator = raw.indexOf(0)
      if (terminator <= 0) throw new Error(`${path} has an invalid ELF interpreter path`)
      const interpreter = raw.subarray(0, terminator).toString("utf8")
      if (!interpreter.startsWith("/")) {
        throw new Error(`${path} has a non-absolute ELF interpreter path`)
      }
      return realpathSync(interpreter)
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}
