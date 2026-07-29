# Plan v1 kernel

Contract status: evidence-seeking. This is the canonical Schema-first, pure
planning seam for Airlock's first macOS runtime; callers use `src/plan/index.ts`.

The closed node set is `Capture`, `Invoke`, `Apply`, and `RequestExternal`.
`RequestExternal` records intent only. It does not perform I/O; a runtime
adapter must stage it through `Outbox`. `Apply` is similarly a planned local
delta; its adapter must delegate mutations to `Hold`.

The kernel owns typed draft/admitted plans, requirements, grants, handles,
runtime transitions, artifacts, receipts, tagged errors, deterministic DAG
ordering, execution closure, and JSON codecs. It contains no filesystem,
process, network, or policy adapter.

Non-goals: grant issuance and policy evaluation, locator resolution, digest
calculation, scheduling, persistence, retries, actual execution, and crash
reconciliation. Those belong to callers/adapters and must preserve this
component's contract.
