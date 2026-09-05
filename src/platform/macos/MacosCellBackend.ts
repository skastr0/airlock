import { Context, Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import {
  NativeCellBackend,
  CellUnavailable,
  type NativeCellLaunchRequest
} from "../../cell/NativeCellBackend.ts"
import {
  PreparedPrivateWorkspace,
  type NativeWorkspaceError
} from "../NativeWorkspace.ts"
import { ProcessRequest, ProcessRunner } from "../../process/Process.ts"
import { MacosPlatform } from "./MacosPlatform.ts"
import {
  MacosUnavailable,
  VolumeInspectionFailed,
  WorkspacePreparationFailed
} from "./contracts.ts"

const sandboxExec = "/usr/bin/sandbox-exec"
const sbpl = (value: string) => JSON.stringify(value)

/** Seatbelt glue stays in the macOS adapter, outside the shared Cell contract. */
export const renderSeatbeltProfile = (
  privateWorkspace: string,
  tempPaths: ReadonlyArray<string>,
  network: "deny" | "allow",
  allowedExecutables: ReadonlyArray<string>
) => {
  const writable = [privateWorkspace, ...tempPaths]
    .map((path) => `(allow file-write* (subpath ${sbpl(path)}))`)
    .join(" ")
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    ...allowedExecutables.map(
      (executable) => `(allow process-exec (literal ${sbpl(executable)}))`
    ),
    "(allow file-read*)",
    writable,
    '(allow file-write* (literal "/dev/null"))',
    network === "deny" ? "(deny network*)" : "(allow network*)"
  ].join(" ")
}

const preparationError = (
  source: string,
  destination: string,
  error: MacosUnavailable | VolumeInspectionFailed | NativeWorkspaceError
): CellUnavailable | NativeWorkspaceError =>
  error instanceof MacosUnavailable
    ? new CellUnavailable({
        capability: "macOS workspace preparation",
        reason: `platform is ${error.platform}`
      })
    : error instanceof VolumeInspectionFailed
      ? new WorkspacePreparationFailed({ source, destination, cause: error.cause })
      : error

const launchContained = (
  runner: Context.Tag.Service<typeof ProcessRunner>,
  request: NativeCellLaunchRequest,
  options: Parameters<Context.Tag.Service<typeof ProcessRunner>["run"]>[1]
) => {
  if (process.platform !== "darwin") {
    return Effect.fail(
      new CellUnavailable({
        capability: "macOS Seatbelt",
        reason: `platform is ${process.platform}`
      })
    )
  }
  if (!existsSync(sandboxExec)) {
    return Effect.fail(
      new CellUnavailable({
        capability: "sandbox-exec",
        reason: "not present at /usr/bin/sandbox-exec"
      })
    )
  }
  const allowedExecutables = [
    ...new Set(request.executableBindings.flatMap((binding) => binding.allowedPaths))
  ]
  return runner.run(
    new ProcessRequest({
      ...request.process,
      executable: sandboxExec,
      env: {
        ...request.process.env,
        TMPDIR: request.privateTempDirectory,
        TMP: request.privateTempDirectory,
        TEMP: request.privateTempDirectory
      },
      args: [
        "-p",
        renderSeatbeltProfile(
          request.privateWorkspace,
          request.tempPaths,
          request.network,
          allowedExecutables
        ),
        request.rootExecutable.launch,
        ...request.process.args
      ],
      cwd: request.privateWorkspace
    }),
    options
  )
}

export const MacosCellBackendLive = Layer.effect(
  NativeCellBackend,
  Effect.gen(function* () {
    const platform = yield* MacosPlatform
    const runner = yield* ProcessRunner
    return NativeCellBackend.of({
      preparePrivateWorkspace: (request) =>
        platform.preparePrivateWorkspace(request).pipe(
          Effect.map(
            (receipt) => new PreparedPrivateWorkspace({
              source: receipt.source,
              destination: receipt.destination,
              strategy: receipt.strategy
            })
          ),
          Effect.mapError((error) =>
            preparationError(request.source, request.destination, error)
          )
        ),
      launchContained: (request, options) =>
        launchContained(runner, request, options)
    })
  })
)
