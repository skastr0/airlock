# Airlock Programs publication evidence

Edition: 2026-07-30

This record explains what the field guide demonstrates and what it does not.
It is deliberately narrower than a shell-replacement claim.

## Artifact contract

| Property | Result |
| --- | --- |
| Deliverable | `output/pdf/airlock-programs.pdf` |
| Source | `docs/programs/airlock-programs.typ` |
| Format | 24-page A4 portrait PDF |
| Accessibility | Tagged PDF/UA-1 with document metadata and alt text for the architecture plate |
| Typography | Ether `Big Shoulders` and `Martian Mono`, embedded at build time |
| Generated art | Existing `docs/infographics/assets/airlock-architecture-plate-v1.png`, used decoratively |
| Explanatory graphics | Deterministic Typst diagrams and typography |

The reproducible publication build produced:

```text
sha256:779f571540bbcba73d99857d8709271a2fd56d29a11b52d089672b7070283214
```

A second build with the same fixed edition timestamp was byte-for-byte
identical. Independent PDF parsing found 24 pages, extractable text on every
page, and the expected `Airlock Programs` title and `Airlock` author metadata.

## Code contract

The book includes thirteen `.air` programs, four shell command surfaces, one
Admission policy, one Plan contract model, one abridged receipt projection, and
one evidence-command block. The `.air` sources are stored separately under
[`snippets/`](snippets/) so the examples are copyable and parser-testable.

Validation covers:

1. every `.air` snippet parses with the current language implementation;
2. shell companions pass `sh -n`;
3. JSON companions decode as JSON;
4. the repository's complete `bun run verify` gate passes;
5. the PDF compiles as PDF/UA-1;
6. every rendered page is inspected for clipping, code legibility, hierarchy,
   status labeling, and source-to-claim traceability.

The publication run completed with 52 passing test files plus one skipped,
255 passing tests plus 16 skipped, and all four Bun/macOS boundary gates
passing. The first compatibility example also executed through
`airlock-agent`, returned `state: "succeeded"`, exited zero, captured
`hello from Airlock`, and produced two correlated artifacts.

## Claim matrix

| Surface | What the guide may say | Boundary retained in the guide |
| --- | --- | --- |
| Compatibility | Structured executable plus literal argv covers broad non-interactive Unix shapes | Child writes and sends retain ambient host authority and bypass Hold/Outbox |
| Native-contained | Supported local workspace deltas merge through Hold | Local integrity only; ambient reads, exact executable paths, and supported top-level delta |
| Managed actions | File actions are admitted and applied through current Plan/runtime contracts | Sequential actions are not a multi-entry transaction |
| Hold | Managed prior bindings remain retained until reap and may be undone when conflict checks permit | Live change is immediate; recovery ends at reap; runtime-private cleanup is not user undo |
| Outbox | `http.stage` creates durable local intent before wire authority | A supervisor commit is separate; cancellation never reverses a send; uncertainty remains possible |
| Receipts | Versioned records correlate admitted and observed orchestration facts | They do not prove semantic intent or application-level correctness |
| Vouch | Existing OpenShell, Python, SQLite, and archive work can be expressed as generic Airlock orchestration | The three programs are integration sketches, not executed remote Vouch replacement |

## Primary sources

- [`DESIGN.md`](../../DESIGN.md) — effect classes and repository laws.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — candidate architecture and
  epistemic status.
- [`macos-v1.md`](../macos-v1.md) — implemented profile mechanisms and current
  macOS boundary.
- [`security-model.md`](../security-model.md) — threat model and residual
  authority.
- [`acceptance.md`](../acceptance.md) — gates for a future strong
  shell-replacement claim.
- [`contracts/plan-runtime.md`](../contracts/plan-runtime.md) — Plan/runtime
  seam.
- [`evidence/parity-50.md`](../evidence/parity-50.md) — scripted repeatability
  corpus and its limits.
- [`evidence/vouch-corpus.md`](../evidence/vouch-corpus.md) — executed local
  Vouch-derived evidence and unproved remote boundary.
- [`infographics/evidence.md`](../infographics/evidence.md) — architecture plate
  visual provenance.

## Review record

The publication received separate visual-system and claim-boundary reviews.
The first visual review found one overflowing effect card, undersized Hold
labels, two over-dense Vouch pages, color-dependent terminal states, and an
undersized final architecture thumbnail. The revised edition fixes those
issues and expands the Vouch material into six readable pages.

The claim review required explicit status on every code block and sharpened the
compatibility, native-contained, Hold, Outbox, receipt, and Vouch boundaries.
Those corrections are part of the source, not post-publication commentary.
