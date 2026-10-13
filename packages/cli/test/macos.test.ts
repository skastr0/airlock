import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MacosPlatform,
  MacosPlatformLive
} from "../src/platform/macos/MacosPlatform.ts"
import { PrivateWorkspaceRequest } from "../src/platform/macos/contracts.ts"

const darwin = process.platform === "darwin"

describe.skipIf(!darwin)("macOS platform substrate", () => {
  it.effect("reports the native Cell boundary precisely instead of a single availability flag", () =>
    Effect.gen(function* () {
      const platform = yield* MacosPlatform
      const report = yield* platform.capabilityReport
      expect(report.platform).toBe("darwin")
      expect(report.schemaVersion).toBe("airlock/macos-capabilities/v2")
      expect(report.nativeContainment.seatbelt.posture).toBe(
        existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable"
      )
      expect(report.nativeContainment.privateWritableView.posture).toBe("enforced")
      expect(report.nativeContainment.liveWorkspaceWriteFence.posture).toBe(
        existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable"
      )
      expect(report.nativeContainment.deniedNetworkFence.posture).toBe(
        existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable"
      )
      expect(report.nativeContainment.ambientHostReads.posture).toBe("allowed")
      expect(report.nativeContainment.confidentiality.posture).toBe("not-provided")
      expect(report.nativeContainment.processCancellation.posture).toBe("bounded")
      expect(report.nativeContainment.processCancellation.caveats).toEqual(
        expect.arrayContaining([expect.stringContaining("daemonize")])
      )
      expect(report.vmEnclosure.backend.posture).toBe("not-provided")
    }).pipe(Effect.provide(MacosPlatformLive))
  )

  it.effect("inspects APFS and compares volume identity from device ids", () =>
    Effect.gen(function* () {
      const platform = yield* MacosPlatform
      const volume = yield* platform.inspectVolume(process.cwd())
      const match = yield* platform.sameVolume(process.cwd(), tmpdir())
      expect(volume.filesystem).toBe("apfs")
      expect(volume.apfs).toBe(true)
      expect(match.same).toBe(true)
    }).pipe(Effect.provide(MacosPlatformLive))
  )

  it.effect("prepares a private workspace and records the actual clone or copy strategy", () =>
    Effect.gen(function* () {
      const platform = yield* MacosPlatform
      const root = mkdtempSync(join(tmpdir(), "airlock-macos-"))
      const source = join(root, "source")
      const destination = join(root, "workspace")
      yield* Effect.sync(() => {
        mkdirSync(source)
        writeFileSync(join(source, "input.txt"), "original")
      })

      const receipt = yield* platform.preparePrivateWorkspace(
        new PrivateWorkspaceRequest({ source, destination })
      )
      expect(["clone", "copy"]).toContain(receipt.strategy)
      expect(receipt.sameVolume).toBe(true)
      expect(readFileSync(join(destination, "input.txt"), "utf8")).toBe("original")
      expect(existsSync(destination)).toBe(true)
    }).pipe(Effect.provide(MacosPlatformLive))
  )

  it.effect("refuses to overwrite a preexisting workspace", () =>
    Effect.gen(function* () {
      const platform = yield* MacosPlatform
      const root = mkdtempSync(join(tmpdir(), "airlock-macos-"))
      const source = join(root, "source")
      const destination = join(root, "workspace")
      yield* Effect.sync(() => {
        mkdirSync(source)
        mkdirSync(destination)
      })
      const error = yield* platform
        .preparePrivateWorkspace(new PrivateWorkspaceRequest({ source, destination }))
        .pipe(Effect.flip)
      expect(error._tag).toBe("WorkspaceDestinationExists")
    }).pipe(Effect.provide(MacosPlatformLive))
  )
})
