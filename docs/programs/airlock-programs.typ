#import "/ether/brand-studio/typst/brand.typ": *
#import "/airlock/docs/programs/book-components.typ": *

// Airlock Programs
// Compile from the Airlock repository:
// typst compile --root .. --font-path ../ether/brand-studio/fonts \
//   --ignore-system-fonts docs/programs/airlock-programs.typ \
//   output/pdf/airlock-programs.pdf --pdf-standard ua-1 \
//   --creation-timestamp 1785369600

#let plate = "/airlock/docs/infographics/assets/airlock-architecture-plate-v1.png"
#let infographic = "/airlock/docs/infographics/airlock-architecture-v1.png"
#let snippet-root = "/airlock/docs/programs/snippets/"

#set document(
  title: "Airlock Programs",
  author: "Airlock",
  description: "A source-backed field guide to structured Unix work for agents.",
  date: datetime(year: 2026, month: 7, day: 30),
)

#set page(
  paper: "a4",
  binding: left,
  margin: (
    inside: 19mm,
    outside: 16mm,
    top: 17mm,
    bottom: 18mm,
  ),
  fill: bg-deep,
  header-ascent: 8pt,
  footer-descent: 9pt,
  header: context {
    let current = counter(page).get().first()
    if current > 1 {
      grid(
        columns: (1fr, auto),
        mono(
          "AIRLOCK PROGRAMS",
          size: 6.6pt,
          fill: ink-dim,
          tracking: 0.10em,
        ),
        mono(
          "EXECUTABLE FIELD NOTES",
          size: 6.6pt,
          fill: ink-dim,
          tracking: 0.10em,
        ),
      )
      v(4pt)
      rect(width: 100%, height: 0.45pt, fill: border-c)
    }
  },
  footer: context {
    let current = counter(page).get().first()
    if current > 1 {
      rect(width: 100%, height: 0.45pt, fill: border-c)
      v(4pt)
      grid(
        columns: (1fr, auto, 1fr),
        align: (left + horizon, center + horizon, right + horizon),
        mono(
          "MACOS FIRST",
          size: 6.4pt,
          fill: ink-dim,
          tracking: 0.10em,
        ),
        circle(radius: 1.5pt, fill: hu.stroke),
        mono(
          counter(page).display("01"),
          size: 6.8pt,
          fill: ink-mid,
          weight: 600,
          tracking: 0.08em,
        ),
      )
    }
  },
)

#set text(
  font: f-mono,
  size: 9pt,
  fill: ink,
  lang: "en",
  region: "US",
)
#set par(leading: 0.72em, spacing: 0.72em)
#show heading.where(level: 1): it => it.body

// ---------------------------------------------------------------------------
// 01 / Cover
// ---------------------------------------------------------------------------

#place(
  top + left,
  dx: -19mm,
  dy: -17mm,
  image(
    plate,
    width: 210mm,
    height: 297mm,
    fit: "cover",
    alt: "Abstract amber and cyan technical instrument on a dark field.",
  ),
)
#place(
  top + left,
  dx: -19mm,
  dy: -17mm,
  rect(
    width: 210mm,
    height: 297mm,
    fill: gradient.linear(
      (bg-deep.transparentize(0%), 0%),
      (bg-deep.transparentize(4%), 48%),
      (bg-deep.transparentize(64%), 100%),
      angle: 105deg,
    ),
  ),
)

#v(5mm)
#eyebrow("source-backed companion", hue: "amber", size: 10pt)
#v(9mm)
#display("Airlock\nPrograms", size: 67pt, leading: 0.82em)
#v(7mm)
#box(width: 118mm)[
  #body-copy(
    "Structured Unix work between agents and the world.",
    size: 14pt,
    fill: ink-mid,
    leading: 0.76em,
  )
]
#v(10mm)
#inline-code-block(
  read(snippet-root + "19-plan.txt").trim(),
  "THE AUTHORING RAIL",
  status: "CONTRACT MODEL",
  size: 7.7pt,
)

#v(1fr)
#grid(
  columns: (1fr, auto),
  align: (left + bottom, right + bottom),
  [
    #mono(
      "MACOS FIRST  /  AGENT ONLY",
      size: 7pt,
      fill: ink-mid,
      tracking: 0.11em,
    )
    #v(3pt)
    #mono(
      "USABLE DEVELOPER PREVIEW  /  2026-07-30",
      size: 6.4pt,
      fill: ink-dim,
      tracking: 0.08em,
    )
  ],
  calib-matrix(hue: "amber", n: 3, cell: 6pt, gap: 3pt),
)

#pagebreak()

// ---------------------------------------------------------------------------
// 02 / Reader contract
// ---------------------------------------------------------------------------

#page-heading(
  "00",
  "How to read this book",
  "CAVEAT",
  "These pages show current program syntax without upgrading a developer preview into a shell-replacement claim.",
  source: "DESIGN.md  /  README.md  /  docs/macos-v1.md",
)

#quote-line("Airlock programs express structured Unix work. Existing Unix programs still do the work.")
#v(10pt)

#grid(
  columns: (1fr, 1fr),
  rows: (auto, auto),
  column-gutter: 9pt,
  row-gutter: 9pt,
  callout(
    "Runnable",
    "Checked-in current syntax or CLI surface. It may still require bindings, policy, fixtures, or a supported macOS profile.",
    tone: "success",
  ),
  callout(
    "Contract model",
    "Implemented typed architecture, shown as data or a rail. It is not Airlock source syntax.",
    tone: "cyan",
  ),
  callout(
    "Integration sketch",
    "Current language forms aimed at real OpenShell or Vouch work. The remote integration has not run end to end.",
    tone: "violet",
  ),
  callout(
    "Caveat",
    "A visible boundary on what the example proves. Compatibility is broad, native containment is narrow, and receipts are not omniscience.",
    tone: "danger",
  ),
)

#v(12pt)
#grid(
  columns: (1fr, 1fr, 1fr, 1fr),
  column-gutter: 7pt,
  effect-card("01", "Capture", "OBSERVATION", "Information enters."),
  effect-card("02", "Invoke", "COMPUTATION", "Existing code runs."),
  effect-card("03", "Apply", "MUTATION", "Managed state changes."),
  effect-card("04", "Request External", "EMISSION", "Intent stages."),
)

#v(12pt)
#two-notes(
  callout(
    "The two laws",
    "Only the Reaper unlinks. Explicit profiles may narrow authority; agent code cannot widen it.",
  ),
  callout(
    "What is not claimed",
    "No confidentiality claim for native-contained. No VM equivalence. No broad shell replacement claim yet.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("The generated plate is atmosphere. Every readable claim and code block is deterministic.")

#pagebreak()

// ---------------------------------------------------------------------------
// 03 / Install
// ---------------------------------------------------------------------------

#page-heading(
  "01",
  "Install. Probe. Inspect.",
  "RUNNABLE",
  "Start from a checkout, build the paired command surfaces, then ask Airlock to describe itself.",
  source: "README.md: Install from a checkout",
)

#code-block(
  snippet-root + "14-install.sh",
  "docs/programs/snippets/14-install.sh",
  status: "RUNNABLE",
  size: 8.1pt,
)

#v(11pt)
#grid(
  columns: (1fr, 1fr),
  column-gutter: 9pt,
  callout(
    "Supervisor surface",
    "`airlock` retains policy, raw maintenance, Hold, Outbox commit/cancel, undo, and reap authority.",
  ),
  callout(
    "Agent surface",
    "`airlock-agent` exposes programs, schemas, capabilities, and read-only state inspection - not terminal authority.",
    tone: "cyan",
  ),
)

#v(12pt)
#quote-line("The harness gives the agent airlock-agent, not a peer shell tool.")

#v(1fr)
#source-line("Current release requirement: macOS and Bun 1.3.11 or newer. The install prefix must be on PATH.")

#pagebreak()

// ---------------------------------------------------------------------------
// 04 / First program
// ---------------------------------------------------------------------------

#page-heading(
  "02",
  "Your first Airlock program",
  "RUNNABLE",
  "The executable is one field. Every argument is a separate atom. The runtime receives no command string.",
  source: "src/actions/Catalog.ts  /  src/process/Process.ts",
)

#code-block(
  snippet-root + "01-first.air",
  "docs/programs/snippets/01-first.air",
  status: "RUNNABLE",
  size: 8pt,
)

#v(10pt)
#inline-code-block(
  "airlock run hello.air \\\n  --workspace /tmp \\\n  --bindings '{\"workspace\":\"/tmp\"}'",
  "SUPERVISOR INVOCATION",
  status: "RUNNABLE",
  size: 8pt,
)

#v(11pt)
#two-notes(
  callout(
    "No implicit shell",
    "Airlock invokes `[executable, ...args]`. Metacharacters inside an argument remain literal at this seam.",
    tone: "cyan",
  ),
  callout(
    "Ambient host authority",
    "This example selects compatibility. Child reads, writes, sends, helpers, config, and descriptors are not contained.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Structured invocation removes shell parsing from orchestration; it does not make compatibility a sandbox.")

#pagebreak()

// ---------------------------------------------------------------------------
// 05 / Language
// ---------------------------------------------------------------------------

#page-heading(
  "03",
  "A small language around effects",
  "RUNNABLE",
  "Bindings supply values. Pure control chooses when to request actions. Neither can mint authority.",
  source: "src/language/ast.ts  /  src/language/evaluator.ts",
)

#code-block(
  snippet-root + "02-control.air",
  "docs/programs/snippets/02-control.air",
  status: "RUNNABLE",
  size: 7.8pt,
)

#v(11pt)
#grid(
  columns: (1fr, 1fr, 1fr),
  column-gutter: 8pt,
  callout(
    "Finite",
    "List iteration snapshots a finite list. Range loops are half-open and bounded.",
    compact: true,
  ),
  callout(
    "Typed failure",
    "`assert` stops later work and preserves completed action evidence.",
    tone: "cyan",
    compact: true,
  ),
  callout(
    "No widening",
    "Bindings change data, never the supervisor-selected profile or grants.",
    tone: "danger",
    compact: true,
  ),
)

#v(11pt)
#inline-code-block(
  "airlock-agent run docs/programs/snippets/02-control.air \\\n  --workspace /tmp/airlock-demo \\\n  --bindings '{\n    \"enabled\": true,\n    \"expected\": 3,\n    \"writes\": [\n      {\"path\":\"a.txt\",\"content\":\"a\"},\n      {\"path\":\"b.txt\",\"content\":\"b\"},\n      {\"path\":\"c.txt\",\"content\":\"c\"}\n    ]\n  }'",
  "AGENT TOOL CALL",
  status: "RUNNABLE",
  size: 6.9pt,
)

#v(1fr)
#source-line("The evaluator has one injected world seam: ActionResolver.resolve(action, input).")

#pagebreak()

// ---------------------------------------------------------------------------
// 06 / Four effects
// ---------------------------------------------------------------------------

#page-heading(
  "04",
  "Four effects. One closed Plan.",
  "CONTRACT MODEL",
  "Actions lower into an implemented candidate Plan algebra before Admission binds any authority.",
  source: "src/plan/Plan.ts  /  docs/contracts/plan-runtime.md",
)

#inline-code-block(
  "PlanNode =\n    Capture\n  | Invoke\n  | Apply\n  | RequestExternal",
  "THE CLOSED ALGEBRA",
  status: "CONTRACT MODEL",
  size: 9pt,
)

#v(12pt)
#grid(
  columns: (1fr, 1fr),
  rows: (auto, auto),
  column-gutter: 9pt,
  row-gutter: 9pt,
  effect-card("01", "Capture", "file.read / glob / stat", "Provenance attaches at entry."),
  effect-card("02", "Invoke", "process.run", "A selected profile runs existing code."),
  effect-card("03", "Apply", "file.write / move / remove", "Hold performs the live transition."),
  effect-card("04", "Request External", "http.stage", "Outbox retains intent before dispatch."),
)

#v(14pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("ActionCall"),
    arrow(tone: "dim"),
    flow-node("PlanDraft", sub: "requirements"),
    arrow(),
    flow-node("Admission", tone: "active"),
    arrow(),
    flow-node("ExecutionAuthority", sub: "Plan + grants", tone: "cyan"),
  )
]

#v(12pt)
#two-notes(
  callout(
    "Implemented candidate seam",
    "The four nodes and total lowering exist. Representative completeness across Unix work remains a falsifiable hypothesis.",
    tone: "cyan",
  ),
  callout(
    "Only two laws",
    "The Plan algebra is not promoted into a law. The Reaper and ratchet remain the only frozen invariants.",
  ),
)

#v(1fr)
#source-line("A PlanDraft has unresolved requirements. ExecutionAuthority is the Runtime input.")

#pagebreak()

// ---------------------------------------------------------------------------
// 07 / Capture
// ---------------------------------------------------------------------------

#page-heading(
  "05",
  "Capture the workspace",
  "RUNNABLE",
  "Read, inspect, list, glob, and stat are explicit observations with resource requirements and artifacts.",
  source: "src/actions/Catalog.ts  /  examples/parity/filesystem.air",
)

#code-block(
  snippet-root + "03-capture.air",
  "docs/programs/snippets/03-capture.air",
  status: "RUNNABLE",
  size: 7.8pt,
)

#v(11pt)
#grid(
  columns: (1fr, 1fr, 1fr),
  column-gutter: 8pt,
  metric("Actions", "5", note: "inspect / read / list / glob / stat"),
  metric("Plan node", "Capture", note: "observation enters", tone: "cyan"),
  metric("Default realm", "local", note: "still admitted explicitly"),
)

#v(11pt)
#two-notes(
  callout(
    "What provenance buys",
    "Downstream artifacts can point back to the admitted locator and resource identity used for capture.",
    tone: "cyan",
  ),
  callout(
    "What it does not buy",
    "Native-contained currently permits ambient host reads. Observation evidence is not a confidentiality boundary.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Current formats: text, bytes, and JSON. Following symlinks in file.stat is rejected.")

#pagebreak()

// ---------------------------------------------------------------------------
// 08 / Invoke
// ---------------------------------------------------------------------------

#page-heading(
  "06",
  "Invoke without command construction",
  "RUNNABLE",
  "Literal argv replaces shell parsing at the Airlock boundary - including strings that look hostile to a shell.",
  source: "examples/parity/process-pipeline.air  /  src/process/Process.ts",
)

#code-block(
  snippet-root + "04-invoke-literal.air",
  "docs/programs/snippets/04-invoke-literal.air",
  status: "RUNNABLE",
  size: 7.8pt,
)

#v(12pt)
#grid(
  columns: (1fr, auto, 1fr),
  align: center + horizon,
  flow-node("/usr/bin/printf", sub: "executable", tone: "cyan", width: 100%),
  arrow(label: "distinct"),
  flow-node(
    "[\"%s\", \"literal; touch...\"]",
    sub: "argument atoms",
    tone: "active",
    width: 100%,
  ),
)

#v(11pt)
#two-notes(
  callout(
    "Structured streams",
    "stdin is discard, inherit, inline text, or an ArtifactId. stdout and stderr are capture, discard, or inherit.",
    tone: "cyan",
  ),
  callout(
    "Ambient host authority",
    "The literal string is safe from implicit shell parsing, but the compatibility child remains broadly empowered.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("An explicitly admitted interpreter may still interpret its own input. Airlock does not infer intent.")

#pagebreak()

// ---------------------------------------------------------------------------
// 09 / Artifact pipeline
// ---------------------------------------------------------------------------

#page-heading(
  "07",
  "A pipeline is an artifact graph",
  "RUNNABLE",
  "Captured stdout becomes named input to the next Invoke. No pipe syntax or intermediary shell process is required.",
  source: "examples/parity/process-pipeline.air  /  test/parity-process.test.ts",
)

#code-block(
  snippet-root + "05-pipeline.air",
  "docs/programs/snippets/05-pipeline.air",
  status: "RUNNABLE",
  size: 7.1pt,
)

#v(10pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("grep", sub: "Invoke"),
    arrow(label: "stdout"),
    flow-node("artifact/selected", tone: "cyan"),
    arrow(label: "stdin"),
    flow-node("tr", sub: "Invoke"),
  )
]

#v(10pt)
#two-notes(
  callout(
    "Explicit dataflow",
    "The artifact id carries bytes and provenance. Process order follows declared dependency. This is not an atomic pipeline.",
    tone: "cyan",
  ),
  callout(
    "Proof receipt",
    "Executed output: `2:needle second` became `2:NEEDLE SECOND`; both displayed Invokes succeeded.",
    tone: "success",
  ),
)

#v(1fr)
#source-line("Output and the final returned value remain bounded by configured limits.")

#pagebreak()

// ---------------------------------------------------------------------------
// 10 / Tar
// ---------------------------------------------------------------------------

#page-heading(
  "08",
  "Unix programs stay Unix programs",
  "RUNNABLE",
  "Airlock does not implement archive semantics. It gives `/usr/bin/tar` a structured invocation and bounded authority.",
  source: "examples/parity/corpus/archive-roundtrip.air",
)

#code-block(
  snippet-root + "06-tar.air",
  "docs/programs/snippets/06-tar.air",
  status: "RUNNABLE",
  size: 7.45pt,
)

#v(11pt)
#grid(
  columns: (1fr, 1fr, 1fr, 1fr, 1fr),
  column-gutter: 6pt,
  flow-node("tar", sub: "archive"),
  flow-node("git", sub: "versioning"),
  flow-node("sed", sub: "editing"),
  flow-node("make", sub: "build"),
  flow-node("sqlite3", sub: "database"),
)

#v(11pt)
#two-notes(
  callout(
    "Pristine component",
    "The generic action is `process.run`. Tool definitions may improve ergonomics but cannot add authority or Plan constructors.",
    tone: "cyan",
  ),
  callout(
    "Native boundary",
    "Native-contained supports a narrower file/directory workload. Descendant executables must be declared.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("The archive algorithm remains tar's. Airlock owns admission, execution bounds, finality, and evidence.")

#pagebreak()

// ---------------------------------------------------------------------------
// 11 / Apply
// ---------------------------------------------------------------------------

#page-heading(
  "09",
  "Apply through Hold",
  "RUNNABLE",
  "Managed file actions perform admitted local changes. Hold displaces prior bindings before live state changes.",
  source: "src/Hold.ts  /  examples/parity/filesystem.air",
)

#code-block(
  snippet-root + "07-apply.air",
  "docs/programs/snippets/07-apply.air",
  status: "RUNNABLE",
  size: 7.15pt,
)

#v(10pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("live binding", sub: "rename prior", tone: "cyan"),
    arrow(),
    flow-node("Hold", sub: "retained state", tone: "active"),
    arrow(),
    flow-node("replacement", sub: "install live"),
  )
]

#v(10pt)
#two-notes(
  callout(
    "Law 01",
    "Only the Reaper unlinks. Managed removal or replacement first retains prior state through Hold.",
  ),
  callout(
    "Recovery boundary",
    "Undo is bounded by retained material, supported filesystem semantics, and conflict checks. Multi-entry ACID is not claimed.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Compatibility-child syscalls do not become Apply and receive no Hold guarantee.")

#pagebreak()

// ---------------------------------------------------------------------------
// 12 / rm -rf
// ---------------------------------------------------------------------------

#page-heading(
  "10",
  "Let rm be rm - remove finality instead",
  "PROOF",
  "The destructive executable runs inside the private view. Its deletion becomes a delta; Hold owns the live transition.",
  source: "examples/parity/native-destructive.air  /  test/parity-native-contained.test.ts",
)

#code-block(
  snippet-root + "08-rm-rf.air",
  "docs/programs/snippets/08-rm-rf.air",
  status: "RUNNABLE",
  size: 7.7pt,
)

#v(13pt)
#grid(
  columns: (1fr, auto, 1fr, auto, 1fr),
  align: center + horizon,
  flow-node("private view", sub: "rm -rf executes", tone: "cyan", width: 100%),
  arrow(label: "delta"),
  flow-node("Admission", sub: "revalidate", tone: "active", width: 100%),
  arrow(label: "Apply"),
  flow-node("Hold", sub: "recoverable live change", tone: "active", width: 100%),
)

#v(13pt)
#quote-line("The useful capability remains. In this supported native-contained workload, the irreversible path does not.")

#v(11pt)
#two-notes(
  callout(
    "Executed corpus",
    "The destructive native workload removes a directory through the private Cell, merges the delta, and restores it with supervisor undo.",
    tone: "success",
  ),
  callout(
    "Not syscall interception",
    "Running `/bin/rm -rf` in compatibility would retain ambient host mutation authority and sit outside this recovery envelope.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("This is the clearest example of Airlock physics around an existing Unix tool.")

#pagebreak()

// ---------------------------------------------------------------------------
// 13 / Profiles
// ---------------------------------------------------------------------------

#page-heading(
  "11",
  "Turn the ratchet",
  "CAVEAT",
  "Zero configuration stays broad. A supervisor-selected profile may narrow authority; agent code cannot select a weaker profile.",
  source: "DESIGN.md: The ratchet law  /  docs/macos-v1.md",
)

#grid(
  columns: (1fr, 1fr),
  column-gutter: 9pt,
  profile-card(
    "Compatibility",
    "Broad zero-config capability",
    "Existing host authority, configuration, descendants, descriptors, filesystem, and network remain available. No containment claim.",
    "IMPLEMENTED",
  ),
  profile-card(
    "Native-contained",
    "Explicit macOS narrowing",
    "Private workspace, live-write denial, network denial, delta generation, and Hold-backed Apply for the supported subset.",
    "IMPLEMENTED",
  ),
)

#v(9pt)
#profile-card(
  "VM-enclosed",
  "Stronger future enclosure",
  "Unavailable today. The CLI refuses this profile rather than silently falling back to compatibility.",
  "FUTURE",
  tone: "future",
)

#v(12pt)
#inline-code-block(
  "airlock exec \\\n  --executable /bin/echo \\\n  --arg \"hello world\" \\\n  --cwd /tmp\n\nairlock run create.air \\\n  --workspace /absolute/workspace \\\n  --profile native-contained",
  "THE RATCHET IS EXPLICIT",
  status: "RUNNABLE",
  size: 7.6pt,
)

#v(11pt)
#two-notes(
  callout(
    "Law 02",
    "Restrictions are opt-in. Once selected, missing enforcement fails closed; an Airlock program cannot widen the profile.",
  ),
  callout(
    "Native is not confidential",
    "The current Seatbelt profile permits ambient host reads and does not claim complete execution closure or VM equivalence.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Curation improves precision but never gates compatibility capability.")

#pagebreak()

// ---------------------------------------------------------------------------
// 14 / Admission
// ---------------------------------------------------------------------------

#page-heading(
  "12",
  "Admission owns authority",
  "RUNNABLE",
  "A supervisor-owned policy binds paths, executable identities, endpoint selectors, profile, and principal.",
  source: "src/admission/Admission.ts  /  README.md quickstart",
)

#code-block(
  snippet-root + "18-policy.json",
  "docs/programs/snippets/18-policy.json",
  status: "RUNNABLE",
  size: 7.65pt,
)

#v(11pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("PlanDraft", sub: "requirements"),
    arrow(),
    flow-node("Policy", sub: "supervisor", tone: "active"),
    arrow(),
    flow-node("ExecutionAuthority", sub: "bound handles", tone: "cyan"),
  )
]

#v(11pt)
#two-notes(
  callout(
    "Schema-first",
    "The policy, requirements, grants, handles, resolutions, and execution authority are decoded contracts - not CLI folklore.",
    tone: "cyan",
  ),
  callout(
    "No authority minting",
    "Program source and definitions cannot mint grants. This example policy authorizes only `/usr/bin/touch` in its listed workspace.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Runtime revalidates closure and grant lifetime at each node boundary.")

#pagebreak()

// ---------------------------------------------------------------------------
// 15 / Native private view
// ---------------------------------------------------------------------------

#page-heading(
  "13",
  "Compute in a private view",
  "RUNNABLE",
  "Native-contained runs the executable away from the live workspace, derives a supported delta, then asks Hold to apply it.",
  source: "src/cell/Cell.ts  /  docs/macos-v1.md",
)

#code-block(
  snippet-root + "09-native-touch.air",
  "docs/programs/snippets/09-native-touch.air",
  status: "RUNNABLE",
  size: 7.65pt,
)

#v(9pt)
#code-block(
  snippet-root + "15-native-run.sh",
  "docs/programs/snippets/15-native-run.sh",
  status: "RUNNABLE",
  size: 7.5pt,
  top-rule: false,
)

#v(11pt)
#grid(
  columns: (1fr, auto, 1fr, auto, 1fr),
  align: center + horizon,
  flow-node("fingerprint", sub: "live workspace", width: 100%),
  arrow(),
  flow-node("private Cell", sub: "network denied", tone: "cyan", width: 100%),
  arrow(label: "delta"),
  flow-node("Hold Apply", sub: "drift checked", tone: "active", width: 100%),
)

#v(11pt)
#callout(
  "Narrow evidence envelope",
  "Current native merge covers supported top-level regular-file or directory deltas. Hardlinks, special files, live foreign writers, ACL/xattr fidelity, and multi-entry atomicity remain outside the claim.",
  tone: "danger",
)

#v(1fr)
#source-line("Unavailable native enforcement never falls back to compatibility.")

#pagebreak()

// ---------------------------------------------------------------------------
// 16 / Outbox
// ---------------------------------------------------------------------------

#page-heading(
  "14",
  "Stage before the wire",
  "RUNNABLE",
  "RequestExternal creates durable local intent. A later supervisor action decides whether to cancel or dispatch.",
  source: "src/Outbox.ts  /  src/outbox/Contract.ts",
)

#code-block(
  snippet-root + "10-http-stage.air",
  "docs/programs/snippets/10-http-stage.air",
  status: "RUNNABLE",
  size: 7.6pt,
)

#v(9pt)
#code-block(
  snippet-root + "16-outbox.sh",
  "docs/programs/snippets/16-outbox.sh",
  status: "RUNNABLE",
  size: 7.65pt,
  top-rule: false,
)

#v(11pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("staged", sub: "inert"),
    arrow(label: "choose"),
    flow-node("cancel", sub: "before claim"),
    mono("OR", size: 7pt, fill: ink-dim, weight: 600, tracking: 0.08em),
    flow-node("commit", sub: "crosses wire", tone: "active"),
  )
]

#v(11pt)
#two-notes(
  callout(
    "Only commit dispatches",
    "Airlock-owned HTTP intent touches the wire only inside Outbox.commit. Node success means staged, not sent.",
  ),
  callout(
    "Honest uncertainty",
    "After a possible dispatch, ambiguity becomes `uncertain`; it is never automatic permission to retry.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("A direct supervisor commit can cross before holdUntil; flush is the operation that honors the waiting window.")

#pagebreak()

// ---------------------------------------------------------------------------
// 17-18 / Vouch snapshot
// ---------------------------------------------------------------------------

#page-heading(
  "15",
  "Vouch path I: snapshot",
  "INTEGRATION SKETCH",
  "OpenShell remains OpenShell. Python and SQLite retain their application semantics. Airlock structures the host orchestration.",
  source: "examples/vouch/snapshot.air  /  ../vouch/assets/box-runtime-v1.py",
)

#code-block(
  snippet-root + "11-vouch-snapshot.air",
  "docs/programs/snippets/11-vouch-snapshot.air:1-21",
  status: "INTEGRATION SKETCH",
  size: 8.25pt,
  first-line: 1,
  end-line: 21,
)

#v(12pt)
#two-notes(
  callout(
    "Structured controller call",
    "OpenShell is one admitted executable. Its subcommand, sandbox name, timeout, remote executable, and helper arguments stay distinct.",
    tone: "cyan",
  ),
  callout(
    "Compatibility - ambient",
    "OpenShell owns the remote effects; Outbox does not mediate them. Local process cancellation is not remote operation cancellation.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Snapshot phase. The existing Python helper retains SQLite and archive semantics.")

#pagebreak()

#page-heading(
  "15B",
  "Vouch snapshot: bring the artifact home",
  "INTEGRATION SKETCH",
  "A second structured invocation downloads the remote artifact. A managed observation records local archive metadata.",
  source: "examples/vouch/snapshot.air  /  examples/vouch/OPERATIONS.md",
)

#code-block(
  snippet-root + "11-vouch-snapshot.air",
  "docs/programs/snippets/11-vouch-snapshot.air:23-40",
  status: "INTEGRATION SKETCH",
  size: 8.4pt,
  first-line: 23,
  end-line: 40,
)

#v(14pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("remote archive", sub: "OpenShell"),
    arrow(label: "download"),
    flow-node("local archive", tone: "cyan"),
    arrow(label: "inspect"),
    flow-node("Capture receipt", tone: "active"),
  )
]

#v(13pt)
#two-notes(
  callout(
    "Generic physics",
    "Invoke existing controller. Capture process evidence. Inspect the result. No Vouch-shaped Airlock primitive appears.",
    tone: "cyan",
  ),
  callout(
    "Remote proof missing",
    "The source parses and lowers today. A real OpenShell/Vouch snapshot run remains unproved.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Airlock does not claim the remote artifact is correct merely because download exited zero.")

#pagebreak()

// ---------------------------------------------------------------------------
// 19-20 / Vouch restore
// ---------------------------------------------------------------------------

#page-heading(
  "16A",
  "Vouch path II: stage restore input",
  "INTEGRATION SKETCH",
  "Inspect local evidence first, then upload with a structured controller invocation and an explicit deadline.",
  source: "examples/vouch/restore.air  /  examples/vouch/OPERATIONS.md",
)

#code-block(
  snippet-root + "12-vouch-restore.air",
  "docs/programs/snippets/12-vouch-restore.air:1-20",
  status: "INTEGRATION SKETCH",
  size: 8.35pt,
  first-line: 1,
  end-line: 20,
)

#v(13pt)
#two-notes(
  callout(
    "Precondition is visible",
    "The archive must exist and contain bytes before the upload request can begin.",
    tone: "cyan",
  ),
  callout(
    "Compatibility - ambient",
    "OpenShell owns upload behavior and remote effects. Outbox does not mediate this controller traffic.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("Local timeout bounds the controller process. It does not prove remote cancellation.")

#pagebreak()

// ---------------------------------------------------------------------------
// 20 / Vouch restore continuation
// ---------------------------------------------------------------------------

#page-heading(
  "16B",
  "Vouch restore: execute the existing helper",
  "INTEGRATION SKETCH",
  "The embedded Python command becomes literal argv to an existing helper, with captured streams and an explicit postcondition.",
  source: "examples/vouch/restore.air  /  ../vouch/assets/box-runtime-v1.py",
)

#code-block(
  snippet-root + "12-vouch-restore.air",
  "docs/programs/snippets/12-vouch-restore.air:22-44",
  status: "INTEGRATION SKETCH",
  size: 8.15pt,
  first-line: 22,
  end-line: 44,
)

#v(13pt)
#two-notes(
  callout(
    "What gets simpler",
    "Executable, argv, deadline, stdout, stderr, and the exit postcondition stay visible instead of hiding inside shell text.",
    tone: "cyan",
  ),
  callout(
    "What Airlock does not own",
    "Archive collision policy, SQLite correctness, OpenShell transport, and helper correctness remain existing-program semantics.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("A remote `/usr/bin/python3` argv atom is not a local descendant executable edge.")

#pagebreak()

// ---------------------------------------------------------------------------
// 21-22 / Vouch replace
// ---------------------------------------------------------------------------

#page-heading(
  "17A",
  "Vouch path III: preserve before replace",
  "INTEGRATION SKETCH",
  "The replacement route begins by running the snapshot program and refusing to continue if that phase fails.",
  source: "examples/vouch/replace.air  /  docs/vouch-first.md",
)

#code-block(
  snippet-root + "13-vouch-replace.air",
  "docs/programs/snippets/13-vouch-replace.air:1-15",
  status: "INTEGRATION SKETCH",
  size: 8.35pt,
  first-line: 1,
  end-line: 15,
)

#v(14pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto),
    align: center + horizon,
    flow-node("snapshot program", sub: "Invoke"),
    arrow(label: "assert"),
    flow-node("local archive", sub: "captured result", tone: "cyan"),
  )
]

#v(13pt)
#two-notes(
  callout(
    "Failure is a stop",
    "The assertion prevents later backup and staging requests after a failed snapshot result.",
    tone: "cyan",
  ),
  callout(
    "Still ambient",
    "The nested Airlock controller invocation uses compatibility in this sketch. Its internal remote effects are not contained here.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("This page proves program shape only, not a completed Vouch replacement.")

#pagebreak()

#page-heading(
  "17B",
  "Vouch replace: retain, then stage",
  "INTEGRATION SKETCH",
  "Local recovery and remote finality stay separate: retain a backup through Apply, then stage replacement intent.",
  source: "examples/vouch/replace.air  /  docs/vouch-first.md",
)

#code-block(
  snippet-root + "13-vouch-replace.air",
  "docs/programs/snippets/13-vouch-replace.air:17-35",
  status: "INTEGRATION SKETCH",
  size: 8.25pt,
  first-line: 17,
  end-line: 35,
)

#v(13pt)
#align(center)[
  #grid(
    columns: (auto, auto, auto, auto, auto),
    align: center + horizon,
    flow-node("backup", sub: "Apply / Hold", tone: "active"),
    arrow(),
    flow-node("staged intent", sub: "RequestExternal", tone: "cyan"),
    arrow(label: "later"),
    flow-node("commit", sub: "supervisor"),
  )
]

#v(13pt)
#two-notes(
  callout(
    "This program does not replace anything",
    "There is no commit, completion check, health gate, restore, endpoint broker, or remote Plan transport in the snippet.",
    tone: "danger",
  ),
  callout(
    "The important separation",
    "Hold can recover managed local backup state. It cannot undo a remote machine replacement after the recipient observes it.",
  ),
)

#v(1fr)
#source-line("Outbox cancellation applies before claim. Remote undo is a non-goal.")

#pagebreak()

// ---------------------------------------------------------------------------
// 23 / Agent surface and receipts
// ---------------------------------------------------------------------------

#page-heading(
  "18",
  "Receipts, not omniscience",
  "PROOF",
  "The agent gets a narrow command surface and correlated evidence. Receipts record operational fact, not semantic correctness.",
  source: "src/agent-cli.ts  /  src/runtime/Runtime.ts  /  test/parity-process.test.ts",
)

#grid(
  columns: (0.82fr, 1.18fr),
  column-gutter: 9pt,
  code-block(
    snippet-root + "17-agent-surface.sh",
    "THE AGENT SURFACE",
    status: "RUNNABLE",
    size: 7.05pt,
  ),
  code-block(
    snippet-root + "20-proof-receipt.json",
    "ABRIDGED EXECUTED OUTPUT",
    status: "PROOF EXCERPT",
    size: 6.85pt,
  ),
)

#v(11pt)
#callout(
  "Projection boundary",
  "This is a selected field projection from captured compact CLI output, not a standalone Schema-valid document. Program success still requires inspecting nested process state and outcome.",
  tone: "cyan",
  compact: true,
)

#v(9pt)
#grid(
  columns: (1fr, 1fr, 1fr),
  column-gutter: 8pt,
  callout(
    "[OK] Succeeded",
    "All requested current actions completed and returned evidence.",
    tone: "success",
    compact: true,
  ),
  callout(
    "[X] Failed",
    "Typed failure with completed records retained.",
    tone: "danger",
    compact: true,
  ),
  callout(
    "[~] Partial",
    "Earlier actions remain complete; no implied rollback.",
    tone: "violet",
    compact: true,
  ),
)

#v(11pt)
#two-notes(
  callout(
    "Replay is sealed",
    "A persistent run journal claims Plan identity before world work. Prior or concurrent execution rejects replay.",
    tone: "cyan",
  ),
  callout(
    "Evidence boundary",
    "Receipts show admitted, attempted, observed, staged, or changed work. They do not prove that opaque code fulfilled intent.",
    tone: "danger",
  ),
)

#v(1fr)
#source-line("A durable receipt for every possible crash point remains an acceptance gate.")

#pagebreak()

// ---------------------------------------------------------------------------
// 24 / Evidence and next work
// ---------------------------------------------------------------------------

#page-heading(
  "19",
  "What the evidence earns",
  "CAVEAT",
  "Airlock already covers meaningful agent scripting shapes. Strong shell-replacement confidence still depends on representative workload and adversarial evidence.",
  source: "README.md  /  docs/acceptance.md  /  docs/evidence/parity-50.md",
)

#code-block(
  snippet-root + "21-evidence.sh",
  "REPRODUCIBLE REPOSITORY GATES",
  status: "EVIDENCE COMMANDS",
  size: 7.8pt,
)

#v(11pt)
#grid(
  columns: (1fr, 1fr, 1fr, 1fr),
  column-gutter: 7pt,
  metric("Vitest files", "52", note: "+ 1 skipped"),
  metric("Vitest tests", "255", note: "+ 16 skipped"),
  metric("Parity programs", "11", note: "checked-in current set", tone: "cyan"),
  metric("Repeat executions", "50", note: "10 cases x 5", tone: "cyan"),
)

#v(11pt)
#two-notes(
  callout(
    "What works comprehensively enough to study",
    "Structured file work, captured processes, artifact pipelines, bounded control, native edits, archives, local Git, builds, recoverable recursive removal, and staged HTTP intent.",
    tone: "success",
  ),
  callout(
    "What remains before a strong claim",
    "Representative model-generated tasks, direct shell A/B evidence, wider crash/overlap injection, hostile closure tests, labels, endpoint brokerage, real remote Vouch, signing, and release provenance.",
    tone: "danger",
  ),
)

#v(11pt)
#quote-line("A strong foundation is visible. The release claim remains a gate, not a slogan.")

#v(1fr)
#grid(
  columns: (1fr, auto),
  align: (left + bottom, right + bottom),
  [
    #mono(
      "READ NEXT",
      size: 6.8pt,
      fill: hu.accent,
      weight: 600,
      tracking: 0.10em,
    )
    #v(4pt)
    #mono(
      "DESIGN.md  /  docs/macos-v1.md  /  docs/security-model.md\n"
        + "docs/acceptance.md  /  examples/parity  /  examples/vouch",
      size: 7pt,
      fill: ink-mid,
    )
  ],
  image(
    infographic,
    width: 45mm,
    height: 56.25mm,
    fit: "cover",
    alt: "Thumbnail of the Airlock architecture infographic.",
  ),
)
