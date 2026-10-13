# Airlock documentation

Airlock is a small typed language for agent code mode: every program is
reviewed before it runs, and nothing leaves without a person's approval. The
documentation separates the design as built from the candidate contracts that
reach further:

- [`usage.md`](usage.md) — writing and running a `.air` program, the tool
  policy, what may run at once, and the person's commands.
- [`install.md`](install.md) — installing from npm or a checkout, building and
  installing the paired binaries, harness wiring, and what actually ran.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the design as built: the pipeline,
  the storage-agnostic kernel, its ports, the host adapters (local CLI and
  Cloudflare Durable Object), and the tests that hold each property.
- [`decisions.md`](decisions.md) — the decision log: what was decided, when,
  and where it lives in the code, compiled from session history and git.
- [`language.md`](language.md) — the `.air` type system: what is known about a
  program before it runs, and the roadmap for what is not yet known.

## Security model and platform envelopes

- [`security-model.md`](security-model.md) — the current guarantee boundary and
  the candidate stronger contracts (execution closure, endpoint brokerage,
  information labels, persistent authority).
- [`macos-v1.md`](macos-v1.md) — the macOS compatibility/native-contained
  mechanisms and release envelope.
- [`linux-v1.md`](linux-v1.md) — Linux prerequisites, Bubblewrap/Landlock/
  seccomp mechanism, installation, verification, and exact limitations.
- [`acceptance.md`](acceptance.md) — the executable contract for claiming that
  macOS v1 replaces most shell usage for agents.
- [`evidence/`](evidence/) — executed evidence records, including the Debian
  beachhead for Linux native containment, distribution, and portable
  durability primitives, with explicit non-claims.

## Operational guides

- [`changes.md`](changes.md) — reviewed local changes: prepare with ordinary
  tools, then bind, review, apply exactly what was approved, and keep a
  receipt for checked undo.
- [`repeated-use-plan.md`](repeated-use-plan.md) — the plan for repeated use:
  discover, understand, approve, revisit, and reclaim from one Airlock home.
- [`local-sealed-box.md`](local-sealed-box.md) — an opt-in macOS recipe that
  builds the production sealed entrypoint, signs one grant, and publishes a
  same-user generation without privilege escalation.
- [`feedback-disposition.md`](feedback-disposition.md) — what the collected
  architecture reviews changed, rejected, or left open.
- [`infographics/`](infographics/) — source-backed Airlock architecture
  infographic, editable Typst composition, alt text, and visual provenance.
- [`programs/`](programs/) — the *Airlock Programs* executable field guide,
  its runnable snippets, editable Typst source, and publication evidence.

The current implementation and proof level are stated in the repository
[`README.md`](../README.md). A v1 contract is not evidence that the code
already satisfies it.
