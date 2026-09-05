import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { nativeContainmentSupported } from "./support/NativeContainmentTest.ts"

const repository = resolve(import.meta.dirname, "..")
const corpus = join(repository, "examples", "parity", "corpus")

const developerTool = (name: string): string | undefined => {
  const located = process.platform === "darwin"
    ? spawnSync("/usr/bin/xcrun", ["-f", name], { encoding: "utf8" })
    : spawnSync("/usr/bin/which", [name], { encoding: "utf8" })
  if (located.status !== 0) return undefined
  const candidate = located.stdout.trim()
  return candidate.length > 0 && existsSync(candidate)
    ? realpathSync(candidate)
    : undefined
}

const gitExecutable = developerTool("git")
const makeExecutable = developerTool("make")
const checksumExecutable = process.platform === "darwin"
  ? "/sbin/md5"
  : "/usr/bin/md5sum"
const checksumArguments = process.platform === "darwin"
  ? ["-q", "package.tgz"]
  : ["package.tgz"]
const archiveDescendants = process.platform === "linux"
  ? ["/bin/sh", "/usr/bin/gzip"]
  : []

const Receipt = Schema.Struct({
  node_id: Schema.String,
  sequence: Schema.Number,
  state: Schema.String,
  error_tag: Schema.NullOr(Schema.String),
  output_artifacts: Schema.Array(Schema.String)
})

const ProcessResult = Schema.Struct({
  state: Schema.String,
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  receipts: Schema.Array(Receipt)
})

const ProgramReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: Schema.Literal("compatibility", "native-contained", "vm-enclosed"),
  workspace: Schema.String,
  result: Schema.Struct({
    state: Schema.Literal("succeeded", "failed", "partial"),
    result: Schema.Unknown,
    plans: Schema.Array(Schema.Struct({
      actionReference: Schema.String,
      nodes: Schema.Array(Schema.Struct({ kind: Schema.String }))
    }))
  })
})

type AgentProfile = "compatibility" | "native-contained"

const runAgent = (
  args: ReadonlyArray<string>,
  home: string,
  profile: AgentProfile,
  policy?: string
) => {
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  delete environment["AIRLOCK_POLICY_FILE"]
  environment["AIRLOCK_HOME"] = home
  environment["AIRLOCK_AGENT_PROFILE"] = profile
  if (policy !== undefined) environment["AIRLOCK_POLICY_FILE"] = policy
  return spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    timeout: 60_000
  })
}

const executeCorpus = (
  fixture: string,
  workspace: string,
  home: string,
  profile: AgentProfile,
  policy?: string,
  bindings: Readonly<Record<string, unknown>> = {}
) => {
  const canonicalWorkspace = realpathSync(workspace)
  const executed = runAgent([
    "run",
    join(corpus, fixture),
    "--workspace",
    canonicalWorkspace,
    "--bindings",
    JSON.stringify({ workspace: canonicalWorkspace, ...bindings })
  ], home, profile, policy)
  expect(
    executed.status,
    `${fixture}\nSTDERR:\n${executed.stderr}\nSTDOUT:\n${executed.stdout}`
  ).toBe(0)
  return Schema.decodeUnknownSync(ProgramReport)(JSON.parse(executed.stdout))
}

const writeNativePolicy = (
  root: string,
  workspace: string,
  executables: ReadonlyArray<string>,
  principal: string,
  executableEdges: ReadonlyArray<{
    readonly root: string
    readonly descendants: ReadonlyArray<string>
  }> = []
) => {
  const canonicalWorkspace = realpathSync(workspace)
  const policy = join(root, "policy.json")
  writeFileSync(policy, JSON.stringify({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "native-contained",
    principal,
    realm: "local",
    admittedBy: "operator:parity-agent-corpus",
    pathAllowlist: [`${canonicalWorkspace}/**`],
    executableAllowlist: executables,
    executableEdges,
    endpointAllowlist: []
  }))
  return policy
}

const expectProcessReceipts = (
  value: unknown,
  expectedCount: number
) => {
  const process = Schema.decodeUnknownSync(ProcessResult)(value)
  expect(process.state).toBe("succeeded")
  expect(process.receipts).toHaveLength(expectedCount)
  expect(process.receipts.map(({ sequence }) => sequence))
    .toEqual(Array.from({ length: expectedCount }, (_, index) => index + 1))
  expect(process.receipts.every(({ state }) => state === "succeeded")).toBe(true)
  expect(process.receipts.every(({ error_tag }) => error_tag === null)).toBe(true)
  return process
}

const nodeKinds = (report: typeof ProgramReport.Type) =>
  report.result.plans.flatMap(({ nodes }) => nodes.map(({ kind }) => kind))

describe("agent-only host shell-parity corpus", () => {
  it.skipIf(
    !["/usr/bin/git", "/usr/bin/grep", "/usr/bin/wc"].every(existsSync)
  )(
    "observes, searches, pipes artifacts, and checks a repository under a supervisor-pinned compatibility profile",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-observe-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      mkdirSync(join(workspace, "src"), { recursive: true })
      writeFileSync(join(workspace, "README.md"), "Airlock corpus\n")
      writeFileSync(join(workspace, "src", "app.ts"), "// TODO: first\nexport const app = true\n")
      writeFileSync(join(workspace, "src", "lib.ts"), "// TODO: second\nexport const lib = true\n")
      execFileSync("/usr/bin/git", ["init", "-q"], { cwd: workspace })
      execFileSync("/usr/bin/git", ["add", "."], { cwd: workspace })
      execFileSync(
        "/usr/bin/git",
        ["-c", "user.name=Corpus", "-c", "user.email=corpus@airlock.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"],
        { cwd: workspace }
      )
      writeFileSync(join(workspace, "notes.txt"), "untracked\n")

      const report = executeCorpus(
        "observe-repository.air",
        workspace,
        home,
        "compatibility"
      )
      expect(report.profile).toBe("compatibility")
      expect(report.result.state).toBe("succeeded")
      expect(nodeKinds(report)).toEqual([
        "Capture",
        "Capture",
        "Invoke",
        "Invoke",
        "Invoke",
        "Invoke"
      ])

      const Result = Schema.Struct({
        sources: Schema.Array(Schema.String),
        readme: Schema.String,
        status: Schema.Unknown,
        search: Schema.Unknown,
        match_count: Schema.Unknown,
        diff_check: Schema.Unknown
      })
      const result = Schema.decodeUnknownSync(Result)(report.result.result)
      expect(result.sources.map((path) => relative(realpathSync(workspace), path)).sort())
        .toEqual(["src/app.ts", "src/lib.ts"])
      expect(result.readme).toBe("Airlock corpus\n")
      expect(expectProcessReceipts(result.status, 1).stdout).toBe("?? notes.txt\n")
      expect(expectProcessReceipts(result.search, 1).stdout).toContain("src/app.ts:1:// TODO: first")
      expect(expectProcessReceipts(result.search, 1).stdout).toContain("src/lib.ts:1:// TODO: second")
      expect(Number(expectProcessReceipts(result.match_count, 1).stdout?.trim())).toBe(2)
      expect(expectProcessReceipts(result.diff_check, 1).stdout).toBe("")
      expect(existsSync(join(workspace, "build"))).toBe(false)
    }
  )

  it.skipIf(
    !nativeContainmentSupported ||
    !existsSync("/usr/bin/sed") ||
    gitExecutable === undefined
  )(
    "edits in a native Cell, applies through Hold, and validates the live Git diff",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-edit-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      mkdirSync(join(workspace, "src"), { recursive: true })
      writeFileSync(join(workspace, "src", "app.ts"), 'export const mode = "draft"\n')
      execFileSync("/usr/bin/git", ["init", "-q"], { cwd: workspace })
      execFileSync("/usr/bin/git", ["add", "."], { cwd: workspace })
      execFileSync(
        "/usr/bin/git",
        ["-c", "user.name=Corpus", "-c", "user.email=corpus@airlock.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"],
        { cwd: workspace }
      )
      const policy = writeNativePolicy(
        root,
        workspace,
        ["/usr/bin/sed", gitExecutable!],
        "agent:parity-edit"
      )
      const sedArguments = process.platform === "darwin"
        ? ["-i", "", "s/draft/ready/g", "src/app.ts"]
        : ["-i", "s/draft/ready/g", "src/app.ts"]

      const report = executeCorpus(
        "edit-repository.air",
        workspace,
        home,
        "native-contained",
        policy,
        {
          git_executable: gitExecutable!,
          sed_executable: "/usr/bin/sed",
          sed_arguments: sedArguments
        }
      )
      expect(report.profile).toBe("native-contained")
      expect(nodeKinds(report)).toEqual([
        "Invoke", "Apply",
        "Capture",
        "Invoke", "Apply",
        "Invoke", "Apply"
      ])

      const Result = Schema.Struct({
        edited: Schema.Unknown,
        content: Schema.String,
        diff: Schema.Unknown,
        diff_check: Schema.Unknown
      })
      const result = Schema.decodeUnknownSync(Result)(report.result.result)
      expect(result.content).toBe('export const mode = "ready"\n')
      expect(readFileSync(join(workspace, "src", "app.ts"), "utf8"))
        .toBe('export const mode = "ready"\n')
      expectProcessReceipts(result.edited, 2)
      const diff = expectProcessReceipts(result.diff, 2)
      expect(diff.stdout).toContain('-export const mode = "draft"')
      expect(diff.stdout).toContain('+export const mode = "ready"')
      expect(expectProcessReceipts(result.diff_check, 2).stdout).toBe("")

      const held = runAgent(["held"], home, "native-contained", policy)
      expect(held.status, held.stderr).toBe(0)
      const acts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
        target: Schema.String,
        status: Schema.String,
        hasPayload: Schema.Boolean
      })))(JSON.parse(held.stdout))
      expect(acts).toContainEqual(expect.objectContaining({
        target: join(realpathSync(workspace), "src"),
        status: "held",
        hasPayload: true
      }))
    }
  )

  it.skipIf(
    !nativeContainmentSupported ||
    !["/usr/bin/tar", checksumExecutable, ...archiveDescendants].every(existsSync)
  )(
    "creates, verifies, and extracts an archive through existing Unix tools",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-archive-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      mkdirSync(join(workspace, "package", "src"), { recursive: true })
      writeFileSync(join(workspace, "package", "config.json"), '{"mode":"contained"}\n')
      writeFileSync(join(workspace, "package", "src", "main.txt"), "archive payload\n")
      const policy = writeNativePolicy(
        root,
        workspace,
        ["/usr/bin/tar", checksumExecutable],
        "agent:parity-archive",
        archiveDescendants.length === 0
          ? []
          : [{ root: "/usr/bin/tar", descendants: archiveDescendants }]
      )

      const report = executeCorpus(
        "archive-roundtrip.air",
        workspace,
        home,
        "native-contained",
        policy,
        {
          archive_descendants: archiveDescendants,
          checksum_executable: checksumExecutable,
          checksum_arguments: checksumArguments
        }
      )
      expect(nodeKinds(report)).toEqual([
        "Invoke", "Apply",
        "Invoke", "Apply",
        "Apply",
        "Invoke", "Apply",
        "Capture",
        "Capture"
      ])

      const Result = Schema.Struct({
        packed: Schema.Unknown,
        checksum: Schema.Unknown,
        destination: Schema.Unknown,
        unpacked: Schema.Unknown,
        entries: Schema.Array(Schema.String),
        config: Schema.String
      })
      const result = Schema.decodeUnknownSync(Result)(report.result.result)
      expectProcessReceipts(result.packed, 2)
      expect(expectProcessReceipts(result.checksum, 2).stdout)
        .toMatch(/^[0-9a-f]{32}(?:  package\.tgz)?\n$/)
      expectProcessReceipts(result.unpacked, 2)
      expect(result.config).toBe('{"mode":"contained"}\n')
      expect(result.entries.map((path) => relative(realpathSync(workspace), path)).sort())
        .toEqual([
          "extracted/package",
          "extracted/package/config.json",
          "extracted/package/src",
          "extracted/package/src/main.txt"
        ])
      expect(readFileSync(
        join(workspace, "extracted", "package", "src", "main.txt"),
        "utf8"
      )).toBe("archive payload\n")
      expect(existsSync(join(workspace, "package.tgz"))).toBe(true)
    }
  )

  it.skipIf(!nativeContainmentSupported || gitExecutable === undefined)(
    "initializes, authors, stages, commits, and verifies a local Git repository",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-git-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      mkdirSync(workspace)
      const policy = writeNativePolicy(
        root,
        workspace,
        [gitExecutable!],
        "agent:parity-git"
      )

      const report = executeCorpus(
        "local-git-workflow.air",
        workspace,
        home,
        "native-contained",
        policy,
        { git_executable: gitExecutable! }
      )
      expect(nodeKinds(report)).toEqual([
        "Invoke", "Apply",
        "Apply",
        "Apply",
        "Apply",
        "Invoke", "Apply",
        "Invoke", "Apply",
        "Invoke", "Apply",
        "Invoke", "Apply"
      ])

      const Result = Schema.Struct({
        initialized: Schema.Unknown,
        source_directory: Schema.Unknown,
        readme: Schema.Unknown,
        feature: Schema.Unknown,
        staged: Schema.Unknown,
        committed: Schema.Unknown,
        head: Schema.Unknown,
        status: Schema.Unknown
      })
      const result = Schema.decodeUnknownSync(Result)(report.result.result)
      expectProcessReceipts(result.initialized, 2)
      expectProcessReceipts(result.staged, 2)
      expectProcessReceipts(result.committed, 2)
      expect(expectProcessReceipts(result.head, 2).stdout)
        .toMatch(/^[0-9a-f]{40}\nairlock corpus commit\n$/)
      expect(expectProcessReceipts(result.status, 2).stdout).toBe("")
      expect(readFileSync(join(workspace, "src", "feature.txt"), "utf8"))
        .toBe("feature bytes\n")
      expect(execFileSync(
        "/usr/bin/git",
        ["rev-list", "--count", "HEAD"],
        { cwd: workspace, encoding: "utf8" }
      )).toBe("1\n")
    }
  )

  it.skipIf(
    !nativeContainmentSupported ||
    makeExecutable === undefined ||
    !["/usr/bin/awk", "/bin/test", "/bin/mkdir"].every(existsSync)
  )(
    "runs a descendant-owning build tool and commits its generated report",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-build-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      mkdirSync(join(workspace, "src"), { recursive: true })
      writeFileSync(
        join(workspace, "src", "app.ts"),
        "export const one = 1\nexport const two = 2\nconst hidden = 3\n"
      )
      writeFileSync(
        join(workspace, "Makefile"),
        [
          ".PHONY: verify",
          "verify:",
          "\t@/bin/mkdir -p build",
          "\t@/usr/bin/awk 'BEGIN { count=0 } /export/ { count++ } END { print count }' src/app.ts > build/export-count.txt",
          "\t@/bin/test \"$$('/usr/bin/tr' -d '[:space:]' < build/export-count.txt)\" = \"2\"",
          "\t@/usr/bin/printf 'verified\\n'",
          ""
        ].join("\n")
      )
      const policy = writeNativePolicy(
        root,
        workspace,
        [makeExecutable!],
        "agent:parity-build",
        [
          {
            root: makeExecutable!,
            descendants: [
              "/bin/sh",
              "/bin/bash",
              "/bin/mkdir",
              "/usr/bin/awk",
              "/bin/test",
              "/usr/bin/tr",
              "/usr/bin/printf"
            ]
          }
        ]
      )

      const report = executeCorpus(
        "build-check.air",
        workspace,
        home,
        "native-contained",
        policy,
        { make_executable: makeExecutable! }
      )
      expect(nodeKinds(report)).toEqual([
        "Invoke",
        "Apply",
        "Capture",
        "Capture"
      ])

      const Result = Schema.Struct({
        built: Schema.Unknown,
        count: Schema.String,
        report: Schema.Struct({
          kind: Schema.String,
          bytes: Schema.Number
        })
      })
      const result = Schema.decodeUnknownSync(Result)(report.result.result)
      expect(expectProcessReceipts(result.built, 2).stdout).toBe("verified\n")
      expect(result.count).toBe("2\n")
      expect(result.report).toMatchObject({ kind: "file", bytes: 2 })
      expect(readFileSync(join(workspace, "build", "export-count.txt"), "utf8"))
        .toBe("2\n")
    }
  )
})
