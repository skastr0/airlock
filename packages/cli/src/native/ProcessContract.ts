import { Effect, Schema } from "effect"
import { defineToolContract } from "@skastr0/airlock"
import { ArtifactId } from "./Artifacts.ts"

/**
 * One process, as a tool contract. The call names an executable and its
 * argument atoms; there is no shell and no command string. How the process is
 * confined is not an input: the grant carries the profile and the host that
 * runs the call owns the Cell.
 *
 * Everything that decides what the process may do is public, so a grant can
 * bound it and a person asked to approve the call sees it. Text given on
 * standard input is content and is not.
 */

const Output = Schema.Literals(["capture", "discard"])

const Artifact = Schema.NullOr(Schema.Struct({
  id: ArtifactId,
  media_type: Schema.String,
  byte_length: Schema.Finite
}))

const strings = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([]))
)

export const ProcessRun = defineToolContract({
  name: "process.run",
  version: "1",
  effect: "invoke",
  input: Schema.Struct({
    /** Absolute path of the program to start. */
    executable: Schema.String,
    args: Schema.Array(Schema.String),
    /** The only other programs this one may start. */
    descendantExecutables: strings,
    cwd: Schema.String,
    env: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({}))
    ),
    timeoutMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
    /** Text for standard input. Without it, or an artifact, there is none. */
    stdin: Schema.optionalKey(Schema.String),
    /** An artifact of this run for standard input. */
    stdinArtifact: Schema.optionalKey(ArtifactId),
    stdout: Output.pipe(Schema.withDecodingDefaultKey(Effect.succeed("capture" as const))),
    stderr: Output.pipe(Schema.withDecodingDefaultKey(Effect.succeed("capture" as const))),
    outputLimitBytes: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(1_048_576))
    )
  }).pipe(
    Schema.check(Schema.makeFilter((input) =>
      input.stdin === undefined || input.stdinArtifact === undefined ||
      "provide at most one of stdin and stdinArtifact"
    ))
  ),
  /**
   * What the process did. A nonzero exit, a timeout and an output overflow
   * are results, not failures of the call.
   */
  output: Schema.Struct({
    outcome: Schema.Literals(["exited", "timed-out", "output-limit", "cancelled"]),
    exit_code: Schema.NullOr(Schema.Finite),
    signal: Schema.NullOr(Schema.String),
    stdout: Schema.NullOr(Schema.String),
    stderr: Schema.NullOr(Schema.String),
    stdout_artifact: Artifact,
    stderr_artifact: Artifact,
    /**
     * What a confined process changed, now in the working directory through
     * Hold. Empty when it changed nothing or did not exit cleanly, in which
     * case its changes were discarded. Null when the process ran unconfined:
     * what it changed is then unknown and cannot be put back.
     */
    merged: Schema.NullOr(Schema.Array(Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["created", "modified", "deleted"])
    })))
  }),
  public: [
    "executable", "args", "descendantExecutables", "cwd", "env", "timeoutMs", "stdinArtifact", "stdout", "stderr", "outputLimitBytes"
  ],
  resources: {
    executable: { kind: "executable", role: "root", rights: ["invoke"] },
    descendantExecutables: {
      kind: "executable",
      role: "descendant",
      parent: "executable",
      rights: ["execute"],
      collection: "each"
    },
    cwd: { kind: "path", rights: ["read", "write"] }
  }
})
