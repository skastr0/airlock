#import "/ether/brand-studio/typst/brand.typ": *

// Airlock architecture infographic
// Compile from the Airlock repository:
// typst compile --root .. --font-path ../ether/brand-studio/fonts --ignore-system-fonts \
//   docs/infographics/airlock-architecture-v1.typ \
//   docs/infographics/airlock-architecture-v1.png \
//   --format png --ppi 72

#let plate = "/airlock/docs/infographics/assets/airlock-architecture-plate-v1.png"
#let hu = hues.at("amber")

#let mono-label(txt, size: 12pt, fill: ink-mid, tracking: 0.10em, weight: 500) = {
  text(
    font: f-mono,
    size: size,
    fill: fill,
    tracking: tracking,
    weight: weight,
  )[#txt]
}

#let effect-card(index, title, category, detail) = {
  box(
    width: 458pt,
    height: 132pt,
    inset: (left: 20pt, right: 18pt, top: 15pt, bottom: 13pt),
    fill: bg-deep.transparentize(7%),
    stroke: 0.8pt + border-c,
    radius: 3pt,
  )[
    #grid(
      columns: (43pt, 1fr),
      column-gutter: 12pt,
      align: (left + top, left + top),
      [
        #text(
          font: f-mono,
          size: 12pt,
          weight: 600,
          fill: hu.accent,
          tracking: 0.14em,
        )[#index]
        #v(6pt)
        #rect(width: 22pt, height: 2pt, fill: hu.stroke)
      ],
      [
        #text(
          font: f-display,
          size: 31pt,
          weight: 800,
          fill: ink,
          tracking: 0.01em,
        )[#upper(title)]
        #v(2pt)
        #mono-label(upper(category), size: 10.5pt, fill: hu.stroke, tracking: 0.13em)
        #v(6pt)
        #text(font: f-mono, size: 11.5pt, fill: ink-mid)[#detail]
      ],
    )
  ]
}

#let finality-panel(kicker, title, body) = {
  box(
    width: 458pt,
    height: 148pt,
    inset: (left: 20pt, right: 20pt, top: 15pt, bottom: 14pt),
    fill: bg-deep.transparentize(5%),
    stroke: (top: 1.2pt + hu.dim, rest: 0.7pt + border-c),
  )[
    #mono-label(upper(kicker), size: 10.5pt, fill: hu.stroke, tracking: 0.15em)
    #v(5pt)
    #text(font: f-display, size: 29pt, weight: 800, fill: ink)[#upper(title)]
    #v(4pt)
    #text(font: f-mono, size: 11.5pt, fill: ink-mid)[#body]
  ]
}

#let law(index, title, body) = {
  box(width: 458pt)[
    #grid(
      columns: (42pt, 1fr),
      column-gutter: 12pt,
      [
        #text(font: f-mono, size: 13pt, weight: 600, fill: hu.accent)[#index]
      ],
      [
        #mono-label(upper(title), size: 11.5pt, fill: ink, tracking: 0.08em, weight: 600)
        #v(5pt)
        #text(font: f-mono, size: 11.5pt, fill: ink-mid)[#body]
      ],
    )
  ]
}

#stage(1080pt, 1350pt, bg: plate, hue: "amber")[
  // The generated plate is art; all readable claims remain deterministic.
  #place(
    top + left,
    rect(
      width: 1080pt,
      height: 970pt,
      fill: gradient.linear(
        (bg-deep.transparentize(0%), 0%),
        (bg-deep.transparentize(7%), 72%),
        (bg-deep.transparentize(80%), 100%),
        angle: 90deg,
      ),
    ),
  )

  #place(top + left, dx: 72pt, dy: 66pt)[
    #eyebrow("agent-only unix runtime · macos first", hue: "amber")
  ]

  #place(top + left, dx: 72pt, dy: 102pt)[
    #display("Airlock", size: 112pt, leading: 0.86em)
  ]

  #place(top + left, dx: 76pt, dy: 226pt)[
    #box(width: 760pt)[
      #text(font: f-mono, size: 18pt, fill: ink-mid)[
        The chamber between agents and the world.
      ]
      #v(8pt)
      #text(font: f-mono, size: 14pt, fill: ink-dim)[
        Agents author structured actions. Airlock composes existing Unix programs.
      ]
    ]
  ]

  #place(top + left, dx: 72pt, dy: 306pt)[
    #box(
      width: 936pt,
      height: 54pt,
      inset: (x: 18pt, y: 16pt),
      fill: bg-deep.transparentize(4%),
      stroke: 0.8pt + border-c,
    )[
      #grid(
        columns: (auto, 1fr, auto, 1fr, auto, 1fr, auto, 1fr, auto),
        align: center + horizon,
        mono-label("AGENT", size: 11.5pt, fill: ink),
        align(center)[#mono-label("→", size: 13pt, fill: hu.dim)],
        mono-label("ACTION CALL", size: 10.5pt, fill: ink),
        align(center)[#mono-label("→", size: 13pt, fill: hu.dim)],
        mono-label("PLAN DRAFT", size: 10.5pt, fill: ink),
        align(center)[#mono-label("→", size: 13pt, fill: hu.dim)],
        mono-label("ADMISSION", size: 10.5pt, fill: hu.accent),
        align(center)[#mono-label("→", size: 13pt, fill: hu.dim)],
        mono-label("EXECUTION AUTHORITY", size: 9.5pt, fill: ink),
      )
    ]
  ]

  #place(top + left, dx: 72pt, dy: 394pt)[
    #mono-label(
      "CLOSED PLAN · IMPLEMENTED CANDIDATE SEAM",
      size: 11pt,
      fill: ink-dim,
      tracking: 0.13em,
    )
  ]

  #place(top + left, dx: 72pt, dy: 424pt)[
    #grid(
      columns: (458pt, 458pt),
      rows: (132pt, 132pt),
      column-gutter: 20pt,
      row-gutter: 16pt,
      effect-card(
        "01",
        "Capture",
        "Observation",
        [Information enters with provenance.],
      ),
      effect-card(
        "02",
        "Invoke",
        "Computation",
        [Existing executable + args run under the selected profile.],
      ),
      effect-card(
        "03",
        "Apply",
        "Managed mutation",
        [Prior state enters Hold before the live binding changes.],
      ),
      effect-card(
        "04",
        "Request External",
        "Emission intent",
        [Durable HTTP intent stages in Outbox. It does not dispatch.],
      ),
    )
  ]

  // Apply lowers into Hold; RequestExternal lowers into Outbox.
  #place(top + left, dx: 301pt, dy: 704pt)[
    #line(start: (0pt, 0pt), end: (0pt, 22pt), stroke: 0.8pt + hu.dim)
  ]
  #place(top + left, dx: 779pt, dy: 704pt)[
    #line(start: (0pt, 0pt), end: (0pt, 22pt), stroke: 0.8pt + hu.dim)
  ]

  #place(top + left, dx: 72pt, dy: 726pt)[
    #grid(
      columns: (458pt, 458pt),
      column-gutter: 20pt,
      finality-panel(
        "local finality",
        "Hold",
        [Retains displaced state for bounded undo. Reaper discards recovery material later.],
      ),
      finality-panel(
        "external finality",
        "Outbox",
        [Stages intent. A separate commit crosses the wire; ambiguity stays uncertain.],
      ),
    )
  ]

  #place(top + left, dx: 72pt, dy: 900pt)[
    #box(
      width: 936pt,
      height: 50pt,
      inset: (x: 17pt, y: 15pt),
      fill: bg-deep.transparentize(8%),
      stroke: (top: 0.8pt + border-c, bottom: 0.8pt + border-c),
    )[
      #grid(
        columns: (auto, 1fr),
        column-gutter: 18pt,
        mono-label("RECEIPTS", size: 10.5pt, fill: hu.accent, tracking: 0.14em),
        mono-label(
          "ADMITTED · ATTEMPTED · OBSERVED · STAGED · CHANGED",
          size: 11.5pt,
          fill: ink-mid,
          tracking: 0.08em,
        ),
      )
    ]
  ]

  #place(top + left, dx: 72pt, dy: 980pt)[
    #box(
      width: 936pt,
      height: 104pt,
      inset: (x: 0pt, y: 16pt),
      fill: bg-deep.transparentize(7%),
      stroke: (top: 1pt + hu.dim, bottom: 1pt + hu.dim),
    )[
      #grid(
        columns: (458pt, 458pt),
        column-gutter: 20pt,
        law("LAW 01", "Only the Reaper unlinks", [Managed removal first renames prior state into Hold.]),
        law("LAW 02", "The ratchet", [Explicit profiles may narrow authority; agent code cannot widen it.]),
      )
    ]
  ]

  #place(bottom + left, dx: 72pt, dy: -94pt)[
    #box(
      width: 936pt,
      inset: (top: 13pt, bottom: 13pt),
      fill: bg-deep.transparentize(4%),
      stroke: (top: 0.8pt + border-c),
    )[
      #grid(
        columns: (94pt, 1fr),
        column-gutter: 16pt,
        mono-label("V1 SCOPE", size: 10pt, fill: hu.stroke, tracking: 0.14em),
        text(font: f-mono, size: 11.5pt, fill: ink-mid)[
          compatibility: ambient child effects, no Hold/Outbox guarantee ·
          native-contained: private workspace + network denied; not confidential
        ],
      )
    ]
  ]

  #place(bottom + left, dx: 72pt, dy: -42pt)[
    #box(width: 936pt)[
      #grid(
        columns: (1fr, auto),
        mono-label(
          "MACOS FIRST · AGENT ONLY",
          size: 10pt,
          fill: ink-dim,
          tracking: 0.14em,
        ),
        mono-label(
          "UNIX TOOLS REMAIN UNIX TOOLS",
          size: 10pt,
          fill: ink-dim,
          tracking: 0.14em,
        ),
      )
    ]
  ]
]
