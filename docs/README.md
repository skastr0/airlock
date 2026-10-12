# Airlock documentation

Airlock's documentation separates implemented proof from release contracts:

- [`install.md`](install.md) — requirements, npm and checkout install paths, the
  paired supervisor/agent binary model, harness wiring, and Linux status.
- [`usage.md`](usage.md) — writing and running a `.air` program, the tool
  policy, what may run at once, and the person's commands.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the design as built: the
  storage-agnostic kernel, its ports, the host adapters, and the tests that
  hold each property.
- [`macos-v1.md`](macos-v1.md) — the macOS compatibility/native-contained
  mechanisms and release envelope.
- [`linux-v1.md`](linux-v1.md) — Linux prerequisites, Bubblewrap/Landlock/
  seccomp mechanism, installation, verification, and exact limitations.
- [`security-model.md`](security-model.md) — execution closure, endpoint
  brokerage, information labels, and persistent authority.
- [`acceptance.md`](acceptance.md) — the executable contract for claiming that
  macOS v1 replaces most shell usage for agents.
- [`rfc/dispatch-classes-and-provider-contract.md`](rfc/dispatch-classes-and-provider-contract.md)
  — candidate design for supervisor dispatch classes, tool-definition v2, and
  where a provider ecosystem attaches without entering the trust base.
- [`evidence/linux-beachhead.md`](evidence/linux-beachhead.md) — direct Debian
  evidence for Linux native containment, distribution, and portable durability primitives, with explicit non-claims.
- [`feedback-disposition.md`](feedback-disposition.md) — what the collected
  architecture reviews changed, rejected, or left open.
- [`infographics/`](infographics/) — source-backed Airlock architecture
  infographic, editable Typst composition, alt text, and visual provenance.
- [`programs/`](programs/) — the 24-page *Airlock Programs* executable field
  guide, its runnable snippets, editable Typst source, and publication evidence.

The current implementation and proof level are stated in the repository
[`README.md`](../README.md). A v1 contract is not evidence that the code already
satisfies it.
