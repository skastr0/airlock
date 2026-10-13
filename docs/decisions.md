# Airlock decision log: kernel and security model

Research document, compiled Oct 13, 2026 from Quasar session history, the
Oct 11–13 Cursor transcripts, and git history. Status was checked against the
working tree at `d8bcd49`, which committed the release workflow, the
CHANGELOG and the package.json edits. It describes the decisions and their
record, not a specification; the code and its tests are the source of truth.

**How to read this.** The record runs from Jul 28 to Oct 13, 2026. Each entry
gives the decision in one line, the date, the source, its status and, when
implemented, where it lives in the code. "Operator" means the human owner.
Many rulings reached agents as relayed mail; when the operator's own words
could not be found, the entry says so.

**Status values.**
- **in force, implemented**: the code does it today.
- **in force, not yet implemented**: still the direction, but no code yet.
- **superseded (date)**: reversed or replaced. The replacing entry is named.
- **unclear**: the record is ambiguous.

**Source handles.** Sessions are named `provider …last9` of their Quasar id.
- `claude …6b8451a39`: Jul 28 founding conversation (Claude Fable). Its project key is a path, not the airlock repo.
- `codex …3fcbcb9f8`: Jul 29 design session; the other ~150 Jul 29–31 Codex ids are forks of it.
- `claude …df95be6f2`: Aug 2, Vouch/Composio direction (`aug02-user-messages.txt`).
- `claude …ad5eed8b7`: Aug 2 delegated implementation brief listing the "non-negotiable laws" of that phase.
- `prime …539cc11c6`: Aug 13 sealed-box briefs.
- `amp …29f658359`: Sep 4–5 Linux. `amp …e6de4fe89`: Sep 7–10 Linux usability and repositioning. `amp …161d8b7ee`: Sep 7 repositioning brief.
- `claude …71f8ef540`: Sep 26 "upgrades".
- `claude …e487c7465`: Oct 3–7 airlock-lead. `claude …a787bc111`: Oct 3–7 airlock-cloud. `claude …57cf83c06`: airlock-engineering.
- `claude …dd9a0d9be`: Oct 9 airlock-lead (`lead-oct09-user-messages.txt`; the "rulings in force" list).
- `cursor b88b7f01`: Oct 11 lead, solo. `cursor 391d7ece`: Oct 11–13 lead, solo. `cursor 0fab0de7`: Oct 11 sealed-install subagent.
- `git <sha>`: commit message or diff.

---

## Timeline at a glance

| date | what was decided |
|---|---|
| Jul 28 | Founding: four effect classes, Hold/Outbox/Ledger, two laws ("only the reaper unlinks", ratchet). Programs are not TypeScript. |
| Jul 29 | Airlock replaces the shell *for agents*. Verbs and nouns come from Unix. Airlock wraps existing binaries and never reimplements them. macOS first. Inert tool definitions. "Do NOT rush to invariants." |
| Aug 2 | Vouch and Composio push. Provider neutrality ("no ClickUp tools"). Dispatch classes with auto-commit reads. Linux beachhead. |
| Aug 13 | Sealed box: signed grant, opt-in, a daemon holds terminal authority. |
| Sep 4–5 | Full Linux native containment. |
| Sep 7 | Pivot: Airlock is an optional, powerful tool beside Bash and Python, not a straitjacket. Reviewed `change` workflow. |
| Sep 26 | Operator pushes back: "I wouldn't call it _optional_". |
| Oct 3 | Effect v4. Airlock-cloud idea from Vortex. |
| Oct 5 | No backward compatibility. Storage-agnostic kernel. "I dont care about laws": DESIGN.md deleted. No key manager. Airlock owns its Cloudflare story. |
| Oct 7 | JavaScript guest in a Worker Loader isolate (reversed two days later). Security seat added. |
| Oct 9 | Agents write `.air` everywhere. The CLI becomes a client like Cloudflare. Effects are capture/invoke/apply/request. Grants are `now`/`approved`; no request is ever `now`. JSON tool definitions removed. Whole-program review is critical. One receipt shape. |
| Oct 11 | Review/Plan cutover. Old engine and daemon deleted. Programs-only CLI. Workspace-only default policy. Reap keeps 7 days. Seal cannot grant decision verbs. "Just say filesystem tools, and virtual tools." |
| Oct 13 | Live Cloudflare walk, 8 of 8 checks passed. npm publishing with trusted publishing in progress. |

---

## 1. Principles

**P1. Airlock exists so that an agent's destructive slip is a non-event.**
Jul 28, `claude …6b8451a39` and `git 6153459` (DESIGN.md). The founding incident: a test derived a path from the wrong root and truncated a real database with `>`. Status: in force (restated as the goal on Oct 9).

**P2. Airlock programs are not TypeScript.**
Jul 28, `claude …6b8451a39`. The operator: if an agent can still write a `node:fs` call, the guarantees are only behavioural ("pure data structure, json-like or a custom thing"). Reaffirmed Aug 2: ".air needed to be a language because a typescript DSL would support bypassing it". Status: in force, implemented in `src/core/language/*`. A two-day exception on Cloudflare is recorded in H9.

**P3. The language is deny-by-default: an Airlock program can reach only what the DSL exposes.**
Jul 29, `codex …3fcbcb9f8`: "an AIRLOCK program is built with airlock, executed with the airlock runtime". Status: in force, implemented. A program calls only declared tool contracts through the resolver (`src/core/language/run.ts`, `src/core/runner/ProgramRunner.ts`).

**P4. Airlock is for AI agents, not humans.**
Jul 29, `codex …3fcbcb9f8`: "I WAS NEVER FOR HUMANS". Status: in force.

**P5. Replace the shell for agents: disable Bash in the harness and expose only Airlock.**
Jul 29, `codex …3fcbcb9f8`. Restated Aug 2 as "100% airlock usage" for a Vouch agent with "EVERY SINGLE tool" shut off. Status: **superseded Sep 7** by P6 for the local machine. For Cloudflare code mode it lives on in a narrower form: the agent's single tool runs `.air` (H9).

**P6. Do not try to replace Bash. Airlock is a powerful option for destructive or high-impact work, "rather than a straight jacket".**
Sep 7, `amp …e6de4fe89`. The operator's reason: agents can write Python, so blocking the shell is "nonsensical". Status: in force as positioning for the local machine. The README led with it until the Oct 13 rewrite (see C3).

**P7. Do not call it "optional"; it is the safety layer for agents making system changes.**
Sep 26, `claude …71f8ef540`: "I wouldn't call it _optional_ tool, really". An RFC followed (`docs/rfc/agent-change-safety.md`, git `dc4e944`). Status: **in force, implemented in the Oct 13 docs**. `README.md` and `ARCHITECTURE.md` said "an optional tool" until the Oct 13 rewrite. See C3.

**P8. "It's impossible for an agent to mess up alone. That is Airlock's goal."**
Oct 9, `claude …dd9a0d9be` (contract item 2). Status: in force. It drives the grant rules in A5 and the review rules in R4.

**P9. Verbs and nouns are informed by Unix, never by Vouch or any one project.**
Jul 29, `codex …3fcbcb9f8`, called "the most important invariant here". Extensions are the wrong approach; build primitives good enough that projects compose them. Status: in force, implemented. The machine tools are `file.*`, `process.run`, `http.get` and `http.stage` (`src/host/FilesystemTools.ts`).

**P10. Airlock does not implement libraries or replace Unix binaries; it wraps their execution in its physics.**
Jul 29, `codex …3fcbcb9f8`, stated as an "actual invariant". Example: `tar` becomes `run { executable: "/usr/bin/tar", args: [...] }`, not `archive.extract`. Status: in force, implemented as the `process.run` contract with executable and argument atoms. The Jul 29 idea of thin native wrappers over core tools (ls, rm, mv) survives as the `file.*` contracts.

**P11. Airlock must not ship provider-specific tools (ClickUp, Gmail, Composio).**
Aug 2, `aug02-user-messages.txt` (04:01): "airlock should NOT ship with 'clickup' tools… same principle of airlock no shipping with reimplementation of a bunch of unix tools". Status: in force, implemented. `src/` has no vendor tools. The Cloudflare example's mail tools are user-side "virtual tools".

**P12. Default to refusing; give agent authors strong, intentional tools to open things up.**
Oct 9, `claude …dd9a0d9be`. The operator flagged it "very high level direction, please do not treat this as law". Status: in force as direction. Partly implemented: author release/endorse flow rules (`src/core/contract/FlowRules.ts`, git `084630d`) and the workspace-only default policy (H6).

**P13. Code mode for Vortex visibly runs on Airlock, and the DSL is Airlock's own, with no split brain between local and cloud.**
Oct 9, `claude …dd9a0d9be`: "makes it ours, our DSL… improvements to airlock propagate through local dev / CLI and cloud". Status: in force. Implemented in Airlock (one runner in `src/core/runner`, used by the CLI and the Durable Object). Not yet started in Vortex.

---

## 2. Kernel: effects, laws, Hold, Outbox, Ledger

**K1. Every shell effect falls into four classes: observation, mutation, emission, computation.**
Jul 28, `git 6153459` DESIGN.md. The Plan nodes Capture, Apply, RequestExternal and Invoke followed on Jul 29 (`git 4eff1d4`). Status: in force, implemented. On Oct 9 contracts declare `effect: capture | invoke | apply | request` from the same definition as the Plan nodes (`git 492b5b2`; `src/core/contract/ToolContract.ts`, `src/core/plan/Plan.ts`).

**K2. Law 1: only the reaper unlinks.** Every mutation is a rename into Hold, and `Hold.reap` is the single deletion site.
Jul 28, `git 6153459`. Status: in force, implemented (`src/Hold.ts` reap; `test/authority-sites.test.ts` "has exactly one physical deletion"). It lost its "law" label on Oct 5 (X7) but is still enforced by test. On Oct 9 the rule caught a naming collision (`fs.remove` in `FileApplies.ts`), and the code was renamed rather than the test relaxed (`git 6357347`).

**K3. Law 2, the ratchet: zero-configuration behaviour is Bash parity, and restrictions are opt-in.**
Jul 28, `git 6153459`. Restated Aug 2 (`claude …ad5eed8b7`, "profiles only narrow") and Aug 13 (`prime …539cc11c6`, "Unsealed checkout stays today's Airlock (ratchet)"). Status: **superseded in practice on Oct 11** by H6: the CLI with no policy file now grants workspace file tools only, with no process and no network (`src/cli.ts:114-127`, git `b7cbd8a`). No operator ruling explicitly retired the law. Oct 9 P12 points the same way, and the Jul 29 deny-by-default framing (P3) was always in tension with it. `ARCHITECTURE.md` stated the ratchet until the Oct 13 rewrite. See C1.

**K4. Two-phase everywhere: the agent holds the reversible phase, and a runner or person holds the point of no return.**
Jul 28, `git 6153459`. Status: in force, implemented for files (Hold) and requests (Outbox). The `git push --force` quarantine-ref row was never built.

**K5. An emission waits "until hold expiry or affirmative commit"; the undo window is delayed dispatch.**
Jul 28, `git 6153459`. Built as the daemon's hold-expiry flush (Aug 13, `prime …539cc11c6` daemonOps `flush, hold-expiry`). Status: **superseded Oct 9 and Oct 11**. On Oct 9: "nothing leaves the system without a person" (A5). On Oct 11 `airlock serve` and the daemon were deleted because "nothing should be sent without a person approving it" (`cursor b88b7f01`; git `b7cbd8a`, `894e515`).

**K6. Emissions touch the wire only inside `Outbox.commit`; there is never a second network site.**
Jul 28, original `AGENTS.md`. Status: **superseded Oct 5** by K7. The operator, asked to rule on moving `fetch` out of `Outbox.commit`, answered: "I dont care about laws, please remove docs / laws whatever crap" (`claude …e487c7465`).

**K7. The single network call lives in a host HTTP handler that acts only on a permit the kernel mints inside `commit`.** The permit is single-use and bound to the exact staged bytes.
Oct 5, git `c11dadb`, `426aaf0`. Status: in force, implemented (`src/host/HttpDispatcher.ts:157`, `src/core/outbox/Outbox.ts`; tests `core-permit`, `authority-sites`, `security-dispatch-permit`). Extended Oct 9: tool implementations get one-use live wire tokens bound to the admitted request (git `da66f2a`, `bc1a6a3`, `f12545e`, `7536c79`).

**K8. `uncertain` is terminal: a dispatch that may have reached the wire is never retried.**
Jul 29, git `3242783` ("crash-honest"). Status: in force, implemented (`src/core/outbox/Lifecycle.ts`).

**K9. The kernel is storage-agnostic: `src/core` imports only `effect`, and hosts supply ports (OutboxStore, Ledger, Dispatcher, Crypto) that must pass conformance suites.**
Oct 5, `claude …e487c7465`: "let's focus entirely on the storage agnostic core… powerful, type-safe". Status: in force, implemented (`src/core/**`, `src/core/testing/*Conformance.ts`, `test/core-boundary.test.ts`, `scripts/prove-core-portable.ts`).

**K10. The Ledger is append-only and converges: a lost append is repaired on the next touch, with no second dispatch.**
Oct 5, git `cc26a15`. Status: in force, implemented (`src/core/ledger/Ledger.ts`, `src/host` FileLedger).

**K11. The Plan algebra is closed at four nodes.** Definitions, profiles and integrations extend admission and adapters, never add node kinds. Commit, cancel and reap must never become a fifth agent primitive.
Jul 29, DESIGN.md (git `c4b4086`); restated Aug 2 (`claude …ad5eed8b7` law 5). Status: in force, implemented (`src/core/plan/Plan.ts`).

**K12. Invoke takes a separate executable and argument atoms; there is no command-string form.**
Jul 29, `codex …3fcbcb9f8`, git `44cc82b`, `6e5bf83`. Status: in force, implemented (`process.run` contract).

**K13. A read granted `now` is recorded in one step (one settled record plus one ledger line). Other effects keep the full lifecycle. Bytes are not kept by default.**
Oct 9, `claude …dd9a0d9be` ruling 8. Status: in force, implemented (git `08b90e0`, `4aa7563`, `e613c3b`, `0542347`; `src/core/outbox/Capture.ts`). The Oct 13 report says local reads measured 3.4–5.6 ms against a target under 5 ms.

**K14. Every local call is recorded like a cloud emission, and `maxDispatchesPerRun` is deleted.**
Oct 9, `claude …dd9a0d9be` ruling 8. Status: in force, implemented (no `maxDispatchesPerRun` remains in `src/`).

**K15. A replayed read whose content digest differs fails loudly.**
Oct 9, `claude …dd9a0d9be` ruling 8. Status: in force, implemented. The operator has been asked whether to keep it; the question is still open on Oct 13 (`cursor 391d7ece`).

**K16. A declared compensation is not a guaranteed way back. It is only offered as the undo, and running it needs approval.**
Oct 9, `claude …dd9a0d9be` item 2 refinement. Status: in force, implemented (git `4f4da0b`, `b041c13`; ToolGrant refuses `now` for any request).

**K17. When a grant expires, forward work stops; nothing is reversed. A run whose grant lapses mid-call ends as `grant_expired`.**
Oct 9 (git `89fe681`, `63accdd`); the race was fixed Oct 11 (git `ab56aa0`, `cursor b88b7f01`). Status: in force, implemented (`src/core/session/ToolSession.ts`, `src/core/runner/ProgramRunner.ts`).

**K18. Hold keeps replaced bytes for 7 days, and `airlock reap` refuses anything younger.**
Oct 11, `cursor 391d7ece`. The agent added this unasked, reasoning that each receipt promises `heldUntil`. Status: in force, implemented (`src/cli.ts:109`, `:393-402`; git `14f1dd5`).

**K19. Every call returns one receipt: `state: done | staged | refused`.** `result` comes only with done, `refusal` only with refused, and `wayBack` only with done. There is no automatic unwrapping, and a refusal is a branchable value.
Oct 9, `claude …dd9a0d9be` ruling 12. Status: in force, implemented (`src/core/contract/Receipt.ts`, git `b4e0918`).

**K20. Artifacts are host state named by the digest of their bytes.**
Oct 9, ruling 10B; git `de78318`, `9a1d546`. Status: in force, implemented.

---

## 3. Authority: grants, policy, approvals, seals

**A1. Execution has profiles: `compatibility` (no confinement) and `native-contained` (opt-in sandbox).** Only the supervisor's policy picks the profile; a program cannot ask for a weaker one. Nothing silently falls back.
Jul 29, git `9f1bcf6`; Oct 9 ruling 5 ("confinement is the host's business"; an unsupported profile refuses). Status: in force, implemented (`src/host/FilesystemHost.ts:35-36`, `:249-252`; `vm-enclosed` is refused).

**A2. Dispatch classes: the supervisor classes endpoint grants `read`, `mutate` or `irreversible-send`, and `read` + `commit: "auto"` auto-commits immediate API reads through `Outbox.commit`. A program can never select a class.**
Aug 2, `claude …df95be6f2` (the assistant's pick, adopted into the plan) and `claude …ad5eed8b7` law 3. Implemented by git `522ab68` and `3b1ad17`. Status: **superseded Oct 9** by A3 and A5: remote reads are `capture` contracts, and no request is ever automatic. Residue: `dispatchClass: "read"` and `committedBy: "policy-auto"` remain in `src/core/outbox/Records.ts:26,45` and `src/core/session/ToolSession.ts:291-296`, now used for host-reversible `now` calls. `docs/security-model.md:460-466` still describes `commit: "auto"`. See C2.

**A3. A remote read is a `capture`.**
Oct 9, ruling 1. This reverses the Aug 2 view that "an API call is RequestExternal, full stop" (`claude …df95be6f2` assistant). `http.get` is a capture (GET only, no query, fragment or credentials; fixed accept headers). `http.stage` is a request. Status: in force, implemented (git `e3b2ef5`).

**A4. One grant model.** Each tool gets its own grant under a shared `resources` ceiling per kind. Contracts mark resource fields. The host resolves each one to the real object before matching. A grant can only narrow. An unresolved resource is refused. Matchers are `within`, `subsetOf` and numeric `range`.
Oct 9, contract item 3 (the operator deferred to the seats, who picked option 2). Status: in force, implemented (`src/core/admission/ToolGrant.ts`, `ResourcePolicy.ts`; git `57f5d45`, `219d1ae`, `ba37cf5`, `ca90e41`).

**A5. A grant says `when: "now" | "approved"`. No `request` is ever `now`, with or without compensation: "nothing leaves the system without a person". `now` is allowed only for captures and host-reversible apply or invoke.**
Oct 9, contract item 2: "never allowed for irreversible send, it must always go through human in the loop approval". Status: in force, implemented. It is enforced in the type (`GrantTiming` in `src/core/admission/ToolGrant.ts:44-47`) and at policy load ("a request always requires approval, including a compensated request", `validateToolGrants`). Git `9463142`.

**A6. `process.run` may be `now` only under a confining profile. Under `compatibility` it always waits for approval. Compatibility itself is not removed.**
Oct 9, ruling 2. Status: in force, implemented (`src/host/FilesystemHost.ts:252`).

**A7. One `ToolPolicy` document per session. Old policy files and old sealed grants are refused, with no converter.**
Oct 9, ruling 9. The operator asked "are we consolidating the three documents into one?", and it was decided with the team. Status: in force, implemented (`src/core/session/ToolPolicy.ts`; BoxGrant v2 embeds it).

**A8. JSON tool definitions exist: Airlock loads inert definitions from known locations, so extensions do not ship in Airlock.**
Jul 29, `codex …3fcbcb9f8` (07:35, "OHHHHHHH THAT would allow for extensions"). Implemented as git `9fe8feb` and `25b91be`; v2 on Aug 2 (`928a41e`); pinned in the sealed catalog on Aug 13. Status: **superseded Oct 9** by A9.

**A9. Remove JSON tool definitions entirely, including the sealed catalog.** The operator: "let's remove this entirely, it's not worth the tradeoff of compromising the security model". Only the host declares actions.
Oct 9, contract item 4. Status: in force, implemented (git `9a781d6`, `f80fb9b`, `cfb487c`; `docs/security-model.md` "No tool definitions").

**A10. Credentials belong to the owner, outside Airlock. There is no key manager or secret resolver. Airlock refuses well-known credential names at staging, and the Secret template is deleted.**
Oct 5, `claude …a787bc111`. The operator: "beyond Airlock's concerns… We can potentially block well-known secret headers". Status: in force, implemented (git `06ccafb`, `b362bc4`, `d8f73b3`, `ada5a01`, `b829b8f`; `src/core/outbox/HttpIntent.ts`). On Oct 7–9 the security seat narrowed `code` so that only `code` beside `state` is refused (`claude …dd9a0d9be`, first message).

**A11. The agent's binary has no command that decides.**
Jul 29, git `eaa9dfe` (reduced agent surface); Aug 2 law 4 ("agent surface gains no terminal-authority verbs"). Status: in force, implemented (`src/cli.ts` `supervisorOnly`; `airlock-agent` lacks approve-plan, commit, cancel, undo and reap).

**A12. Sealed box: one signed document (box grant) pins the policy, the verbs and the binary digest.** It is opt-in. The verify key is on the box and the signing key never is. The unsealed checkout stays as it is.
Aug 13, `prime …539cc11c6`. Status: in force, implemented. It was rewritten on Oct 11 as `airlock/box-grant/v2` pinning a `ToolPolicy` (`src/core/admission/BoxGrant.ts`, git `b7cbd8a`, `cursor 0fab0de7`).

**A13. A daemon, running under a different uid from the agent, holds terminal authority: commit, reap, flush and hold-expiry.**
Aug 13, `prime …539cc11c6`. The first brief said "Do not start with the daemon"; it was built the same day, and the polish brief made it same-user. Status: **superseded Oct 11**. The daemon was deleted (git `b7cbd8a`, `894e515`), and a person decides with the unsealed `airlock` instead. Open consequence: a root person committing into an agent-owned home leaves root-owned files (`cursor 391d7ece`).

**A14. No seal can grant the decision verbs approve-plan, commit, cancel, undo or reap. A grant that names one is refused at startup.**
Oct 11, `cursor 391d7ece`, acting on `cursor 0fab0de7`'s finding. Status: in force, implemented. The BoxGrant verb schema lacks them (`BoxGrant.ts:16-26`; `cli.ts:95`; git `f547ac7`).

**A15. Data and control roles of a value are authenticated per run (role witnesses). Transplanted, misattributed and replayed witnesses are refused.**
Oct 9 (git `2a34008`, `df35d22`, `883b509`); attack tests landed Oct 11 (git `d157930`). Status: in force, implemented (`src/core/contract/RoleWitness.ts`).

**A16. Information labels: a confidentiality/integrity lattice, failing closed.**
Jul 29, git `fc246fa`. Oct 9 direction: data flow goes through `src/core/labels`. Status: in force, implemented. Review checks every argument against a sink policy (`src/core/review/Flow.ts`, `Review.ts`). `docs/security-model.md:388-391` still says labels are not enforced on the path. See C5.

**A17. The Cloudflare supervisor routes (approve, cancel) have no built-in login; putting one in front is the owner's job.**
Oct 11–13, `cursor 391d7ece`. Status: unclear. It is described as a gap, not a ruling.

---

## 4. Program review and Plans

**R1. Plan mode: every verb dry-runs to a concrete manifest, and execution binds to the manifest and halts on drift.**
Jul 28 roadmap, `git 6153459`. Status: superseded by R2/R3. It was realised as whole-program review.

**R2. Whole-program review before running is in scope and "critical".**
Oct 9, contract item 6: "Because we own it we must capitalize and push on what makes .air special as hard as possible". Status: in force, implemented Oct 11 (git `c18dc80`, `c7cf863`; `src/core/review/*`, `src/core/language/check.ts`). The runner goes parse → check → review → run.

**R3. Plan is the reviewed form of a `.air` program on every host.** A run-time call is an instance of a Plan node. A call that fits no node ends the run (`plan_mismatch`). Never re-review or widen.
Oct 9, contract item 7. The lead first proposed Plan as a local-only engine; the operator objected ("what's stopping cloud from using Plan and Runtime?"). Status: in force, implemented (`src/core/runner/ProgramRunner.ts`, `GuestRunner.ts` `plan_mismatch`). Gap: replay still matches calls by order in the run, not by Plan node (`cursor 391d7ece`, open).

**R4. One human approval of a Plan covers captures, host-reversible applies, and requests whose content the program fully fixes. A request whose content is unknown at review is staged and approved as an exact batch, however well validated.**
Oct 9, review decision A. The operator: you can't validate data that doesn't yet exist, but programs can chain decoders and validators. Status: in force, implemented (`src/core/session/ToolSession.ts:318` `committedBy: "reviewed-plan"`; `src/core/outbox/Outbox.ts:905`; `test/core-plan-approval.test.ts`).

**R5. Decoder and validator chains (trusted schemas, proofs attached to exact values, required by sinks) are built, but never replace the person.**
Oct 9, `claude …dd9a0d9be`. Status: in force, implemented (`src/core/contract/Decoder.ts`; git `088bde7`, `858d34a`).

**R6. Plan approvals are recorded in the Ledger and keyed by plan id; approving twice records once.**
Oct 11, `cursor b88b7f01` (the agent's design choice). Status: in force, implemented (`approve-plan` in `src/cli.ts`; `approvePlan` in `src/cloudflare/AirlockObject.ts`).

**R7. Aim for a sound type system, much smaller than TypeScript's, over plain syntax. Do not add FP notation for its own sake.**
Oct 9: the operator first asked for Effect/FP concepts, then: "I'm worried we're just making it FP just for the sake of making it FP… can we make its type system sound". Status: in force. Partly implemented: the checker types every program against the granted contracts before anything runs, and a seeded hostile corpus fuzzes the runner (`test/security-program-runner-fuzz.test.ts`, git `c345f6e`). No soundness claim has been stated yet. The language history is in [`language.md`](language.md).

**R8. A runner is bounded: code size, steps, nesting depth, value nodes, loop iterations, wall time. It ends with a fixed reason; program text never becomes a failure message.**
Oct 7–9, git `91bb0ac`, `51fc4c6`, `bda5bdb`. The Vortex question was whether `.air` is safe inside the Durable Object with no second isolate; the verdict was "safe with named hardening". Status: in force, implemented (`src/core/runner/Bounds.ts`, `GuestRunner.ts`).

**R9. Single-use Plan claim: a per-Plan claim file makes rerunning an admitted Plan fail closed.**
Jul 29, git `dc0636a`. Status: **superseded Oct 11**. The old Runtime was deleted (git `6ba69a8`), and replay is now keyed by run id. `docs/security-model.md:99-111` still describes it. See C4.

**R10. Reviewed local changes (`airlock change`).** The agent stages a frozen candidate and baseline. A person applies the exact digest, with checked undo and durable recovery. This workflow composes Hold directly, not Plan. The agent may only stage, review and check status.
Sep 7, `amp …161d8b7ee` and `amp …e6de4fe89`. The repositioning brief froze the CLI syntax. Status: in force, implemented (`src/change/*`; `change` in `src/cli.ts`; local only).

**R11. Change-safety RFC: `airlock rm --label`, reap preview, a Trash-like journey.**
Sep 25–26, `docs/rfc/agent-change-safety.md`. Status: not implemented, and **superseded Oct 11** by H5 (programs-only CLI; direct `rm` removed).

---

## 5. Hosts

**H1. macOS first, to settle the contracts and pristine components.**
Jul 29, `codex …3fcbcb9f8`: "it needs to work on macOS - why linux first?" Status: in force, implemented (Seatbelt, APFS clone, `renamex_np`).

**H2. Linux beachhead: `renameat2` and `flock` adapters plus Docker proofs, with no native containment claim; the operator's container is the enclosure.**
Aug 2, `claude …ad5eed8b7`, git `9939fdc`. Status: **superseded Sep 4–5** by H3.

**H3. Full Linux native containment with Bubblewrap ≥0.12, Landlock ABI ≥2 and seccomp; separate claims per platform.**
Sep 4, `amp …29f658359`: "fully implement airlock for Linux". Status: in force, implemented (git `02b0ce6`; `src/platform/linux/*`; `docs/linux-v1.md`).

**H4. Airlock owns its Cloudflare story end to end with Alchemy. A user supplies only contracts, their implementations and a policy; to Vortex, targeting Airlock should feel "almost as if they were targeting JavaScript". Leave room for other clouds.**
Oct 5, `claude …e487c7465` (operator answers at 23:12 and 23:14). Status: in force, implemented (`src/cloudflare/*`, `src/alchemy/*`, `examples/cloudflare/`; git `8e015bb`, `4d4bb39`, `0cd4d00`, `b521ddf`).

**H5. The CLI is a client of the kernel exactly like Cloudflare. It runs programs only; direct verbs (rm, write, send), `serve` and `runs` go away.**
The client idea is from Oct 9, `claude …dd9a0d9be` ("let's consolidate this so that the CLI is like a 'client'"). The programs-only cut is from Oct 11, `cursor b88b7f01`; the agent wrote "Programs only, as you said", but the operator's own words for it were not found (unclear origin). Status: in force, implemented (git `b7cbd8a`, `6ba69a8`; about 28,000 lines of the old engine deleted).

**H6. With no policy file, a program may read and change files in its workspace only. Changes go through Hold. A process or the network needs a policy that grants it.**
Oct 11, `cursor 391d7ece` (agent design, reported to the operator afterwards). Status: in force, implemented (`src/cli.ts:114-127` `workspacePolicy`). It supersedes the ratchet law K3 in practice. See C1.

**H7. One Airlock everywhere (`defineAirlock`); only the tools and the record store differ. Naming: "just say filesystem tools, and virtual tools". `localAirlock` is removed.**
Oct 11, `cursor b88b7f01`: "dude it's just airlock, right?!". Status: in force, implemented (git `0df6113`; `src/host/FilesystemTools.ts`, `FilesystemHost.ts`).

**H8. Effect v4 and the latest Bun; existing code is not sacred.**
Oct 3, `claude …e487c7465`: "effect v4 is the clear, unambiguous decision"; "don't hold existing code as sacred". Status: in force, implemented (`effect 4.0.0-rc.115`, `bun@1.4.2`).

**H9. Cloudflare code mode runs model-written JavaScript in a Worker Loader isolate behind a Durable Object, following the Vortex design.**
Oct 7, git `1b5af20`, `6f361f5`; research in `claude …b869bc14…`. Status: **superseded Oct 9**. The operator: "I had originally asked to have agents write .air, that's the whole point… having agents write a contrived, 'broken' js is worse by every metric. Vortex engineering lead was simply wrong". Git `5b785d4` deleted the JavaScript guest. `.air` now runs inside the Durable Object with no second isolate, which also removes the Worker Loader paid-plan dependency (`cursor 391d7ece`).

**H10. The Durable Object evaluates one program at a time, with a bounded waiting line.**
Oct 9, git `cfb487c`, `63f4a34`. Status: in force, implemented. Whether a stuck program occupying the object needs fixing is an open design question (Oct 13).

**H11. Prove it on a real Cloudflare account, then delete the deployment.**
Oct 11–13, `cursor 391d7ece`. Status: done Oct 13. Eight of eight live checks passed, including the step budget under the frozen clock (git `f547e52`). Both deployments were deleted.

**H12. `vm-enclosed` is future work; the CLI refuses it rather than falling back.**
Jul 29 DESIGN; still true. Status: in force, not yet implemented (no VM backend).

---

## 6. Integrations

**I1. Vouch is the first proving ground ("if airlock works for vouch… then it works for everything"), but Vouch never shapes Airlock's verbs.**
Jul 29, `codex …3fcbcb9f8`. Status: in force. A Vouch-shaped corpus and proofs exist (git `5e21939`, `af901f0`, `52d9b56`). This repo records no Vouch adoption.

**I2. Airlock becomes the code-mode substrate for Vouch agents doing heavy API work (Composio/MCP actions), not only Unix work.**
Aug 2, `claude …df95be6f2`. Status: in force, not yet implemented on the Vouch side. The Cloudflare runner (H4) is the closest vehicle.

**I3. Use Composio, but do not couple it to Airlock. An agent team writes a "vouch/composio" Airlock suite out of tree.**
Aug 2, `aug02-user-messages.txt` (04:01). Status: in force, not yet implemented (no out-of-tree suite recorded).

**I4. An EndpointProvider contract: the provider owns transport, credential custody and the catalog; Airlock owns admission, staging and the wire. Only a fixture provider ships.**
Aug 2, `docs/rfc/dispatch-classes-and-provider-contract.md` §3. Status: superseded in shape. Tool contracts with host implementations (Oct 5–9) replaced provider-fed v2 definitions. The credential split survives as A10.

**I5. MCP annotations such as `readOnlyHint` are never trusted.**
Aug 2, RFC §2.3. Status: in force; nothing in `src/` reads MCP metadata.

**I6. "airlock would _have_ to be an MCP, since as a CLI, you'd obviously require bash to run it."**
Aug 2, `aug02-user-messages.txt` (03:04). Status: unclear. No MCP server exists in `src/`. The Cloudflare code-mode tool (H4/H9) fills the role for hosted agents, but no ruling replaced this idea.

**I7. Vortex code mode runs `.air` on Airlock, not JavaScript. Vortex owns the hookup: teaching its model `.air`, sending programs, routing approvals to a person.**
Oct 9 and Oct 13, `claude …dd9a0d9be`, `cursor 391d7ece`. Status: in force, not yet implemented in Vortex. On Oct 13 the operator asked whether Vortex "can start implementing codemode against it now", and the agent said yes, once there is a push or publish.

**I8. Prism workflows are orthogonal: Airlock could expose them as backends; on Jul 28 Airlock was the "leaf altitude" of Prism.**
Jul 28 roadmap; Aug 2. Status: unclear. Nothing implemented.

**I9. Lean proofs: write theorem statements now and mechanize later; never claim a "verified runtime".**
Aug 2: the operator raised it, the assistant shaped it. Status: in force, not yet implemented. Statements only, in RFC §5.

---

## 7. Distribution

**D1. Ship a verified macOS binary pair, `airlock` (supervisor) and `airlock-agent`, with install and rollback scripts.**
Jul 29, git `f5c480b`, `ab25a5d`, `ad25387`. Status: in force, implemented (`scripts/install-macos.sh`, `build-macos.ts`). Linux equivalents followed Sep 5.

**D2. npm, Homebrew and notarization are out of scope for the sealed-box work.**
Aug 13, `prime …539cc11c6`. Status: superseded by D4.

**D3. Assume easy npm installation exists, and do not invent publishing.**
Sep 7, `amp …e6de4fe89` and `amp …161d8b7ee`. Status: superseded by D4.

**D4. Publish to git and npm. Set up GitHub CI and trusted publishing (OIDC, no token) right away.**
Oct 13, `cursor 391d7ece`: "imperative to set up github ci and trusted publishing immediately". The agent chose one package, `@skastr0/airlock` 0.1.0, with entry points `./core`, `./core/testing`, `./cloudflare` and `./alchemy`; it ships TypeScript source, requires Bun ≥1.4, and leaves docs out of the tarball. Status: in force, in progress. `.github/workflows/release.yml` (OIDC, protected `release` environment), `CHANGELOG.md` and the `package.json` edits are committed as `d8bcd49`. As this document was written, nothing was published and `origin/main` still stopped at Oct 7.

**D5. The kernel is consumable on its own as `@skastr0/airlock/core`, with conformance suites at `/core/testing`.**
Oct 5, ARCHITECTURE. Status: in force, implemented (`package.json` exports; `test/core-exports.test.ts`).

**D6. Pushing needs separate operator authorization.**
Standing rule, reaffirmed Oct 9. The operator authorized specific pushes on Oct 3 and Oct 5. A push was blocked by the auto-mode classifier on Oct 9. Status: in force. About 128 commits are unpushed as of Oct 13; the Oct 13 session was authorized to push.

---

## 8. Process

**X1. Build with Effect, following "pristine components, messy integrations".** Components are Schema-typed with tagged errors and tested invariants; the CLI is plain glue.
Jul 28–29, `claude …6b8451a39`, `codex …3fcbcb9f8`. Status: in force (`AGENTS.md`).

**X2. Treat what the operator says as intent and design direction unless strongly emphasized. "Do NOT rush to invariants"; adopt them only after "extreme, undeniable evidence".**
Jul 29, `codex …3fcbcb9f8` (06:45, 06:49). Status: in force. It sits awkwardly beside the Jul 28 "two laws", which were later dropped (X7).

**X3. Commit as you go and never deliver uncommitted work. Commit directly to main, with no branches.**
Jul 29, Aug 2 ("no branch, just commit to main"), Oct 5, Oct 11. Status: in force.

**X4. Signal-20 plain English: short answers without jargon, and decisions the operator can understand.**
Aug 2; Oct 11 ("this is far too dense and filled with jargon"). Status: in force.

**X5. No backward compatibility: one current shape per contract, no shims, no migration code.**
Oct 5, `claude …e487c7465`: "remove backwards compatiblity and all this nonsense, there's no v3 deploy". Status: in force (`AGENTS.md`). The Oct 5 commits `cadd450`, `c326b4a` and `60a871a` left one shape each.

**X6. Code and tests are the source of truth; documents describe them and never freeze the design. Enforce invariants in types and tests, not prose.**
Oct 5, git `b830a60`. Status: in force (`AGENTS.md`).

**X7. Drop the "two laws" and "frozen invariant" framing, and delete DESIGN.md.**
Oct 5, `claude …e487c7465`: "I dont care about laws… Design evolves and changes, I do NOT tolerate holding back on stupid markdown files". Status: in force, implemented (git `2b50f19`). It supersedes the Jul 28 `AGENTS.md` rules that named the laws.

**X8. Only questions that change what Airlock promises, or what an agent or user experiences, go to the operator, in conversation. Technical shape is decided by the team.**
Oct 9, `claude …dd9a0d9be`, after "stop sending signals for now… these are starting to be very confusing". Status: in force.

**X9. No worktrees. Seats share one checkout and commit through private git indexes, without micromanaging or pausing each other. Verify by extracting a SHA.**
Oct 9, `claude …dd9a0d9be`. Status: in force for multi-seat work.

**X10. A security seat does ordinary review, implementation and security tests, not a "gimmicky" adversarial role. A security or invariant test may be rewritten for a changed contract, never weakened or skipped.**
Oct 7, `claude …e487c7465`: "I don't believe adversarial reviews is that interesting". The test rule is from the Oct 9 seat briefs. Status: unclear on the first half. The seat was later briefed as an "adversarial reviewer", and the operator answered "resolved manually". The second half is in force (for example, the Oct 9 `fs.remove` fix renamed code instead of relaxing the test).

**X11. All agents may edit all files; coordinate instead of owning files.**
Oct 9, `lead-oct09` first messages. Status: in force.

---

## Reversals, in one place

| first decision | date | reversed by | date |
|---|---|---|---|
| Replace the shell for agents; expose only Airlock (P5) | Jul 29 | Not viable; a powerful option, not a straitjacket (P6) | Sep 7 |
| "Optional tool" positioning (P6 docs) | Sep 7 | "I wouldn't call it _optional_" (P7); docs updated Oct 13 | Sep 26 |
| Ratchet: zero-config is Bash parity (K3) | Jul 28 | Workspace-only default policy (H6), with no explicit ruling | Oct 11 |
| Emissions flush at hold expiry; daemon flush (K5, A13) | Jul 28 / Aug 13 | Nothing leaves without a person; daemon deleted | Oct 9 / Oct 11 |
| Only `Outbox.commit` holds `fetch` (K6) | Jul 28 | Host dispatcher behind a kernel permit (K7) | Oct 5 |
| Two frozen laws, DESIGN.md (K2, K3) | Jul 28 | No document freezes design; DESIGN.md deleted (X7) | Oct 5 |
| Inert JSON tool definitions, sealed catalog (A8) | Jul 29 / Aug 13 | Removed entirely (A9) | Oct 9 |
| Dispatch classes, auto-commit reads (A2) | Aug 2 | `capture` effect, `when: now/approved`, no request is ever now (A3, A5) | Oct 9 |
| API reads are RequestExternal (Aug 2) | Aug 2 | Remote reads are capture (A3) | Oct 9 |
| Linux: no native containment claim (H2) | Aug 2 | Full Bubblewrap, Landlock and seccomp (H3) | Sep 4 |
| Daemon holds terminal authority (A13) | Aug 13 | Daemon removed; a person uses unsealed `airlock` (A14) | Oct 11 |
| JavaScript guest in a Worker Loader isolate (H9) | Oct 7 | `.air` in the Durable Object; JavaScript guest deleted | Oct 9 |
| Secret references / resolver (lead assignment A) | Oct 5 | No key manager; refuse credential names (A10) | Oct 5 |
| Plan as a local-only private engine (lead proposal) | Oct 9 | Plan shared on every host (R3) | Oct 9 |
| Single-use Plan claim in Runtime (R9) | Jul 29 | Runtime deleted; replay by run id | Oct 11 |
| `airlock rm --label` change-safety CLI (R11) | Sep 25 | Programs-only CLI (H5) | Oct 11 |
| npm out of scope / "don't invent publishing" (D2, D3) | Aug 13 / Sep 7 | Publish with trusted publishing (D4) | Oct 13 |

---

## Contradictions between sources, and between the record and the code

**C1. The ratchet law against the CLI default.** `ARCHITECTURE.md:29-34` said "compatibility is the zero-configuration default and is Bash parity… the default never becomes stricter than Bash". The code's no-policy default (`src/cli.ts:114-127`) grants workspace file tools only; a process or the network needs a policy. No operator ruling retired the law; the change came from the Oct 11 agent and was reported afterwards. P12 and the Jul 29 deny-by-default framing (P3) support it. The Oct 13 documentation rewrite made the docs describe the code's default.

**C2. Dispatch classes are still described as live.** `docs/security-model.md:458-466` describes "`read`-class `commit: "auto"`" auto-commit as implemented. The Oct 9 rulings removed it, and `ToolGrant.ts` refuses `now` for every request. The vocabulary survives in code: `DispatchAuthorization.dispatchClass: "read"` and `committedBy: "policy-auto"` (`src/core/outbox/Records.ts`, `ToolSession.ts:291-296`) now label host-reversible `now` calls, not reads of the outside world.

**C3. "Optional tool" against the operator.** `README.md:9` and `ARCHITECTURE.md:10` called Airlock "an optional tool". On Sep 26 the operator rejected that word, and the Oct 9 goal ("impossible for an agent to mess up alone") and the new `package.json` description ("nothing leaves without a person's approval") point the other way. The Oct 13 documentation rewrite removed the word from both files.

**C4. The security model describes the deleted engine.** `docs/security-model.md:99-160` describes the Runtime run journal, the `.claims` single-use Plan claim, `RuntimeExecutionClaimRejected` and `ExecutionAuthority`. All were deleted on Oct 11 (git `6ba69a8`). Lines 113-127 ("the agent can author only the four Plan nodes") predate tool contracts and receipts.

**C5. Labels.** `docs/security-model.md:388-391` says the Plan/Runtime/Outbox path does not propagate or enforce labels. Review now imports and checks them (`src/core/review/Flow.ts`, `Review.ts`). The doc understates what the code does; how complete end-to-end enforcement is was not verified here.

**C6. Compatibility profile: "no profile any more" against the code.** The Oct 11 seal subagent (`cursor 0fab0de7`) wrote "there is no profile any more". In fact only the policy-wide compatibility flag was removed. `FilesystemProfile` still includes `compatibility`, and compatibility `process.run` always waits for approval (A6). Oct 9 ruling 2 said compatibility is not removed. The code agrees with Oct 9.

**C7. Laws in the Aug briefs against operator intent on invariants.** The Aug 2 and Aug 13 briefs call the laws "NON-NEGOTIABLE" and "frozen" (`claude …ad5eed8b7`, `prime …539cc11c6`). On Jul 29 the operator had said "Do NOT rush to invariants", and on Oct 5 "I dont care about laws". The briefs were agent-authored plans, not operator words.

**C8. Origin of "programs only".** On Oct 11 the agent wrote "Programs only, as you said" when removing `airlock rm/write/send`. No operator message saying it was found in the Oct 9–11 record. The nearest is "CLI is like a 'client'" (Oct 9).

**C9. Hold retention and the reap minimum were not requested.** The 7-day retention and refusal were added by the agent ("Two things I added that you didn't ask for"). They are consistent with receipts promising `heldUntil`, but have no operator ruling.

**C10. The security seat's role.** On Oct 7 the operator rejected an adversarial-review seat ("I don't believe adversarial reviews is that interesting"). The seat was then briefed as "an adversarial reviewer of the kernel…", and the operator answered "resolved manually". What was finally agreed is unclear.
