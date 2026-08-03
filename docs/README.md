# Airlock documentation

Airlock's documentation separates implemented proof from release contracts:

- [`install.md`](install.md) — requirements, npm and checkout install paths, the
  paired supervisor/agent binary model, harness wiring, and Linux status.
- [`usage.md`](usage.md) — proof-run walkthrough of the `.air` language, the
  action vocabulary, profiles and policy, dispatch classes, Hold/Outbox
  operations, harness integration, the corpus harness, and the failure taxonomy.
- [`DESIGN.md`](../DESIGN.md) — product thesis, four effect classes, the two
  repository laws, and the macOS-first v1 direction.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — complete candidate architecture and
  epistemic status.
- [`contracts/plan-runtime.md`](contracts/plan-runtime.md) — versioned
  Plan/runtime seam and total-lowering obligations.
- [`macos-v1.md`](macos-v1.md) — implemented compatibility/native-contained
  profiles, paired release binaries, and the future VM direction.
- [`security-model.md`](security-model.md) — execution closure, endpoint
  brokerage, information labels, and persistent authority.
- [`acceptance.md`](acceptance.md) — the executable contract for claiming that
  macOS v1 replaces most shell usage for agents.
- [`vouch-first.md`](vouch-first.md) — first adoption slice without
  project-specific physics.
- [`rfc/dispatch-classes-and-provider-contract.md`](rfc/dispatch-classes-and-provider-contract.md)
  — candidate design for supervisor dispatch classes, tool-definition v2, and
  where a provider ecosystem attaches without entering the trust base.
- [`evidence/vouch-corpus.md`](evidence/vouch-corpus.md) — exact executed
  Vouch-derived evidence and remaining boundary.
- [`evidence/external-read-slice.md`](evidence/external-read-slice.md) — the
  executed `RequestExternal` read slice: staged intent, policy auto-commit
  through `Outbox.commit`, receipts, and its fixture-only boundary.
- [`evidence/linux-beachhead.md`](evidence/linux-beachhead.md) — containerized
  evidence that the two host primitives Hold and Outbox depend on exist on
  Linux, with the explicit no-containment, no-release non-claims.
- [`evidence/model-generated-corpus-v0.md`](evidence/model-generated-corpus-v0.md)
  — one executed model-authored corpus campaign, its per-task results, and why
  it supports no acceptance-rate claim.
- [`feedback-disposition.md`](feedback-disposition.md) — what the collected
  architecture reviews changed, rejected, or left open.
- [`infographics/`](infographics/) — source-backed Airlock architecture
  infographic, editable Typst composition, alt text, and visual provenance.
- [`programs/`](programs/) — the 24-page *Airlock Programs* executable field
  guide, its runnable snippets, editable Typst source, and publication evidence.

The current implementation and proof level are stated in the repository
[`README.md`](../README.md). A v1 contract is not evidence that the code already
satisfies it.
