# Airlock Programs

*Airlock Programs* is a source-backed, Ether-themed field guide to the current
Airlock authoring surface.

- [Published PDF](../../output/pdf/airlock-programs.pdf)
- [Editable Typst composition](airlock-programs.typ)
- [Reusable book components](book-components.typ)
- [Copyable source snippets](snippets/)
- [Publication evidence](evidence.md)

The 24-page guide moves from the smallest runnable program through Capture,
Invoke, Apply, Hold, the profile ratchet, Admission, a private native-contained
view, Outbox staging, and receipt semantics. Its final section translates three
Vouch workflows without adding Vouch-specific Airlock primitives.

## Status vocabulary

Every code block carries a status:

- `RUNNABLE` — accepted by the current parser or current CLI.
- `CONTRACT MODEL` — implemented architectural structure, not Airlock source
  syntax.
- `INTEGRATION SKETCH` — current syntax and lowering shape whose named external
  integration has not run end to end.
- `PROOF EXCERPT` — a selected projection of captured output with its evidence
  boundary stated beside it.
- `EVIDENCE COMMANDS` — commands that reproduce repository evidence; they are
  not the evidence result by themselves.

The guide deliberately does not describe compatibility subprocesses as
contained, native-contained execution as confidential, staged HTTP intent as
dispatched, or the Vouch sketches as completed remote proofs.

## Build

From the Airlock repository root:

```sh
typst compile \
  --root .. \
  --font-path ../ether/brand-studio/fonts \
  --ignore-system-fonts \
  docs/programs/airlock-programs.typ \
  output/pdf/airlock-programs.pdf \
  --pdf-standard ua-1 \
  --creation-timestamp 1785369600
```

The build uses Typst 0.15, embeds the Ether fonts, and produces a tagged
PDF/UA-1 document. The fixed edition timestamp makes repeated publication
builds byte-for-byte reproducible. The only generated visual is the existing
source-backed architecture plate; all explanatory diagrams, labels, and code
are deterministic Typst composition.

## Validate the examples

The `.air` files under [`snippets/`](snippets/) are the exact source included in
the book. The publication gate parses every `.air` snippet with the checked-in
Airlock parser, validates shell and JSON companions, renders all 24 pages for
visual inspection, and runs:

```sh
bun run verify
```

See [`evidence.md`](evidence.md) for the exact claim boundary and review record.
