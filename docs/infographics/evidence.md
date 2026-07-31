# Airlock architecture infographic — evidence

## Map brief

- **Question:** How does an agent request ordinary Unix work through Airlock,
  and where do authority, recovery, staging, and evidence enter?
- **Audience:** technical product builders evaluating or explaining Airlock.
- **Map family:** explanatory architecture and effect/finality map.
- **Output tier:** rendered 4:5 image with editable Typst source.
- **State boundary:** the main flow shows current implemented seams. The Plan
  algebra is labeled as an implemented candidate seam. The profile footer
  preserves current macOS limitations.
- **Confidence:** source-backed, with the caveats below.

## Architecture claims

| infographic claim | status | source |
|---|---|---|
| Airlock is the chamber between agents and the world | direct | [`DESIGN.md`](../../DESIGN.md#airlock--design) |
| Agents author structured actions; Airlock composes existing Unix programs | direct | [`DESIGN.md`](../../DESIGN.md#airlock--design) |
| Admission binds an admitted Plan, Grants, and resource bindings into ExecutionAuthority; Runtime receives that authority object | direct | [`src/admission/Admission.ts`](../../src/admission/Admission.ts), [`src/runtime/Runtime.ts`](../../src/runtime/Runtime.ts) |
| The candidate Plan algebra is exactly Capture, Invoke, Apply, and RequestExternal | direct | [`DESIGN.md`](../../DESIGN.md#plan-algebra-and-runtime-vocabulary), [`src/plan/Plan.ts`](../../src/plan/Plan.ts) |
| Capture is observation, Invoke computation, Apply managed mutation, and RequestExternal emission intent | direct | [`DESIGN.md`](../../DESIGN.md#the-four-effect-classes) |
| Invoke uses separate executable and argument fields; there is no command-string form | direct | [`DESIGN.md`](../../DESIGN.md#plan-algebra-and-runtime-vocabulary), [`src/process/Process.ts`](../../src/process/Process.ts) |
| Apply routes Airlock-owned managed changes through Hold | direct | [`DESIGN.md`](../../DESIGN.md#the-two-laws), [`src/Hold.ts`](../../src/Hold.ts) |
| RequestExternal stages inert intent; authorized Outbox commit crosses the wire | direct | [`DESIGN.md`](../../DESIGN.md#two-phase-everywhere), [`src/Outbox.ts`](../../src/Outbox.ts) |
| Possible external dispatch may end as uncertain and is not silently retried | direct | [`DESIGN.md`](../../DESIGN.md#two-phase-everywhere), [`src/Outbox.ts`](../../src/Outbox.ts) |
| Receipts are operational evidence rather than proof of semantic correctness | direct | [`ARCHITECTURE.md`](../../ARCHITECTURE.md#terms) |
| Only the Reaper unlinks | law, construction-tested | [`DESIGN.md`](../../DESIGN.md#1-only-the-reaper-unlinks), [`test/hold.test.ts`](../../test/hold.test.ts) |
| Explicit profiles may narrow authority and agent programs cannot widen it | law | [`DESIGN.md`](../../DESIGN.md#2-the-ratchet-law) |
| Compatibility retains ambient host authority and makes no containment claim | direct | [`DESIGN.md`](../../DESIGN.md#macos-first-v1), [`docs/macos-v1.md`](../macos-v1.md) |
| Native-contained uses a private workspace and denied network, but is not confidential or VM-equivalent | direct | [`DESIGN.md`](../../DESIGN.md#macos-first-v1), [`docs/macos-v1.md`](../macos-v1.md) |

## Important caveats

- “Agent-only” describes the product and harness threat model. It becomes a
  complete mediation claim only when the harness exposes no peer machine-effect
  path.
- The four-node Plan is an implemented candidate seam, not proof that every
  representative Unix workload decomposes without pressure.
- Compatibility-child writes and sends are not converted into Apply or
  RequestExternal, so they do not inherit Hold, Outbox, containment, or
  dispatch-uncertainty guarantees.
- Native-contained permits ambient host reads and does not establish
  confidentiality, VM equivalence, or complete execution closure.
- The infographic does not claim that Airlock currently replaces most shell
  usage for agents. The acceptance corpus has not yet earned that release
  claim.

## Ether visual provenance

The composition follows the sibling Ether **Deep-Field Technical** system:

- warm near-black ground `#0c0b0a`;
- off-white text `#e8e0d0`, secondary `#c8c0b0`, dim `#68604a`;
- amber signal `#f0b040` / `#ffe080`, with a single cyan calibration point;
- Big Shoulders display and Martian Mono body/data typography;
- asymmetry, structural negative space, registration evidence, long-exposure
  grain, and a text-free generated plate;
- deterministic typography over the plate through the canonical Ether Typst
  stage.

Sources:

- [`../ether/BRAND.md`](../../../ether/BRAND.md)
- [`../ether/brand-studio/typst/brand.typ`](../../../ether/brand-studio/typst/brand.typ)
- [`../ether/docs/brand/IMAGE-PROMPTING.md`](../../../ether/docs/brand/IMAGE-PROMPTING.md)
- [`../ether/docs/brand/ASSET-MANIFEST.md`](../../../ether/docs/brand/ASSET-MANIFEST.md)

Amber is the Ether house baseline and a justified hard-gate/recovery direction
for this artifact. This bundle does **not** claim that Airlock has received a
permanent registered project-hue assignment.

## Generated plate

- **Mode:** built-in image generation.
- **Use case:** `infographic-diagram`.
- **Role:** text-free background plate; the plate is illustrative, not
  architecture evidence.
- **Reference images:** Ether's approved
  `ig-story-signal-amber.png` and
  `house-amber-observer-header-alt-1.png`.
- **Workspace asset:** `assets/airlock-architecture-plate-v1.png`.
- **SHA-256:** `d536498460614c27ca73b359276235ee2d0636538ee55dadd0d397756eff9203`.

The prompt requested a 4:5 warm graphite field with an original partially
resolved instrument: an amber path crossing four measurement planes, a private
chamber, a retained recovery ring, an external boundary aperture, and one cyan
calibration node. It explicitly prohibited readable content, literal doors,
locks, spacecraft, centered portals, UI cards, circuit boards, generic AI
imagery, neon palettes, and decorative particle effects.

The final composition does not treat the generated planes or rings as
source-backed component nodes. They remain atmosphere and metaphor; the
deterministic overlay carries every architecture claim.

## Review record

- **Rendered artifact:** 1080×1350 PNG.
- **Rendered SHA-256:**
  `5105e62bb82ebe3b0e0c1c56128a404f1419e0ea71113b94cb0f1d728ac8884a`.
- **Integrity/provenance review:** pass after correcting the admission rail to
  end in `ExecutionAuthority` and qualifying Hold as retained recovery
  material for bounded undo.
- **Comprehension/accessibility review:** pass after adding explicit
  `Apply → Hold` and `RequestExternal → Outbox` connectors, increasing
  lower-third contrast and type size, shortening the profile caveat, and
  verifying both full-size and 360px-thumbnail hierarchy.
- **Render validation:** the checked-in PNG reproduces byte-for-byte from the
  checked-in Typst source with the documented Ether font path and
  `--ignore-system-fonts`.
- **Accessibility:** the alt-text companion was checked against the final
  render and source claims.
