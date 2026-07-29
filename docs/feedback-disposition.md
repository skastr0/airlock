# Architecture feedback disposition

Four independent model reviews and the earlier design discussion were
reconciled into the macOS-first v1 architecture. Review opinions are inputs,
not authority; repository laws and current implementation evidence remain the
ground truth.

## Consensus adopted

- Keep the core synthesis: typed plans, explicit grants, existing Unix tools,
  recoverable local changes, staged external intent, honest uncertainty, and
  durable receipts.
- Treat computation as enclosure rather than inventing a fifth world-boundary
  effect.
- Build/freeze Plan, Admission, Cell, Hold, Outbox, Journal, crash, and
  concurrency seams before polishing syntax.
- Require complete harness mediation before removing shell permission.
- Keep tool definitions inert; enforcement comes from the Cell and brokers,
  not declarations about opaque tool behavior.
- Measure real task completion, escape pressure, recovery, attribution,
  duplicate dispatch, uncertainty, latency, and resource cost.

## Corrections adopted

### Two algebras and three planes

Agent requests and trusted lifecycle transitions are different algebras.
Authoring, authority/lifecycle, and enforcement are separate planes.
`RequestExternal` lowers to local staging; Dispatch crosses the unmanaged
boundary.

### Capability parity is scoped

Universal Unix parity is not credible. v1 claims measured task parity inside a
published platform/profile/resource envelope with explicit exclusions.

### Execution is a closure

Executable identity alone is insufficient. Admission and containment cover
loaders, shebangs, configuration, libraries, descendants, hooks, plugins,
helpers, pagers, editors, credential discovery, environment, and descriptors.

### Two doors are not enough

Separating live mutation from endpoint authority does not prevent secret
exfiltration or an old low-authority write from executing under a later
high-authority Plan. Coarse confidentiality/integrity labels and persistent
authority classification are first-class contracts.

### Enclosed endpoints are brokered

Raw sockets produce weak hostname semantics and can import file descriptors
over Unix sockets. Contained v1 uses broker leases issued only by Outbox
commit. Receipts remain invocation-level unless Airlock actually mediates the
application protocol.

### Managed state includes liveness

A regular file may be live protocol state. The supported envelope requires
quiescence or a format-aware action; active database sidecars, foreign writers,
and advisory-lock semantics cannot be hand-waved.

### Granularity is a product constraint

Package/build deltas need transaction grouping and aggregated evidence without
weakening attribution or recovery. Hold/receipt overhead belongs in acceptance
metrics.

## Adjudications

### macOS first

Several reviews preferred Linux-first because its enforcement primitives are
easier to reason about. Product direction explicitly selects macOS first.
The architecture resolves the concern with a VM-enclosed default and an
honestly narrower native-contained profile; Linux follows v1.

### Airlock remains the agent language

Reviews disagreed between language-last, host-language SDKs, and a restricted
TypeScript surface. The final product surface remains Airlock. The sequencing
critique is accepted: Plan/runtime contracts and workload measurement precede
syntax, and the concrete language remains open until model reliability is
measured.

### The rename/Reaper law remains

One review proposed a backend-neutral recovery invariant using snapshots or
reflinks. The repository explicitly requires every live mutation verb to be a
rename and only Reaper to unlink. That law remains. Changing it later requires
an explicit architecture decision and construction evidence, not a silent
generalization.

### Curation does not gate compatibility

Contained profiles may require known execution contracts or brokerable
endpoints, but zero-config compatibility keeps unknown tools runnable and
ledgered. Curated definitions remove friction; they do not define all Unix
capability.

## Still open

- concrete language syntax and minimal model-reliable pure control;
- exact macOS VM image and native enforcement implementations;
- persistent Cell/checkpoint/owned endpoint semantics;
- the label selectors and promotion/declassification policy language;
- which endpoints earn protocol-aware brokers;
- resource liveness, metadata, and batch-delta operational envelopes;
- definition provenance/distribution and remote realm transport.

These remain questions or candidate mechanics. They are not elevated to
invariants by their presence in the architecture.
