import { Context, Effect, Schema } from "effect"
import {
  PreparedPrivateWorkspace,
  PrivateWorkspaceRequest,
  type NativeWorkspaceError
} from "../platform/NativeWorkspace.ts"
import {
  ProcessRequest,
  ProcessReceipt,
  type ProcessError,
  type ProcessRunOptions
} from "../process/Process.ts"

export type NativeCellNetwork = "deny" | "allow"

export interface NativeExecutableBinding {
  readonly role: "root" | "descendant"
  readonly requested: string
  readonly launch: string
  readonly allowedPaths: ReadonlyArray<string>
  readonly workspaceRebased: boolean
}

export interface NativeCellLaunchRequest {
  readonly sourceWorkspace: string
  readonly privateWorkspace: string
  readonly tempPaths: ReadonlyArray<string>
  readonly privateTempDirectory: string
  readonly network: NativeCellNetwork
  readonly process: ProcessRequest
  readonly rootExecutable: NativeExecutableBinding
  readonly executableBindings: ReadonlyArray<NativeExecutableBinding>
}

export class CellUnavailable extends Schema.TaggedError<CellUnavailable>()(
  "CellUnavailable",
  { capability: Schema.String, reason: Schema.String }
) {}

export type NativeCellBackendError = CellUnavailable | NativeWorkspaceError | ProcessError

/**
 * Host glue below the shared Cell state machine. It may prepare disposable
 * bytes and launch a contained process, but never applies a delta to live state.
 */
export class NativeCellBackend extends Context.Tag("airlock/NativeCellBackend")<
  NativeCellBackend,
  {
    readonly preparePrivateWorkspace: (
      request: PrivateWorkspaceRequest
    ) => Effect.Effect<PreparedPrivateWorkspace, CellUnavailable | NativeWorkspaceError>
    readonly launchContained: (
      request: NativeCellLaunchRequest,
      options?: ProcessRunOptions
    ) => Effect.Effect<ProcessReceipt, CellUnavailable | ProcessError>
  }
>() {}
