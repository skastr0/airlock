# Airlock documentation

Airlock's documentation separates implemented proof from release contracts:

- [`DESIGN.md`](../DESIGN.md) — product thesis, four effect classes, the two
  repository laws, and the macOS-first v1 direction.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — complete candidate architecture and
  epistemic status.
- [`contracts/plan-runtime.md`](contracts/plan-runtime.md) — versioned
  Plan/runtime seam and total-lowering obligations.
- [`macos-v1.md`](macos-v1.md) — VM-enclosed, native-contained, and
  compatibility profiles.
- [`security-model.md`](security-model.md) — execution closure, endpoint
  brokerage, information labels, and persistent authority.
- [`acceptance.md`](acceptance.md) — the executable contract for claiming that
  macOS v1 replaces most shell usage for agents.
- [`vouch-first.md`](vouch-first.md) — first adoption slice without
  project-specific physics.
- [`feedback-disposition.md`](feedback-disposition.md) — what the collected
  architecture reviews changed, rejected, or left open.

The current implementation and proof level are stated in the repository
[`README.md`](../README.md). A v1 contract is not evidence that the code already
satisfies it.
