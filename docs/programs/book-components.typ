#import "/ether/brand-studio/typst/brand.typ": *

#let hu = hues.at("amber")
#let future-hu = hues.at("violet")
#let success = rgb("#9fd59f")
#let danger = rgb("#d8896f")

#let mono(
  body,
  size: 8pt,
  fill: ink-mid,
  weight: 400,
  tracking: 0pt,
) = text(
  font: f-mono,
  size: size,
  fill: fill,
  weight: weight,
  tracking: tracking,
  body,
)

#let status-color(status) = {
  if status == "RUNNABLE" {
    hu.accent
  } else if status == "PROOF" or status == "PROOF EXCERPT" {
    success
  } else if status == "CONTRACT MODEL" {
    cyan-signal
  } else if status == "EVIDENCE COMMANDS" {
    cyan-signal
  } else if status == "INTEGRATION SKETCH" or status == "FUTURE" {
    future-hu.accent
  } else if status == "CAVEAT" {
    danger
  } else {
    ink-mid
  }
}

#let chip(label, tone: none) = {
  let color = if tone == none { status-color(label) } else { tone }
  box(
    inset: (x: 6pt, y: 3pt),
    radius: 999pt,
    stroke: 0.55pt + color.transparentize(30%),
    fill: color.transparentize(91%),
  )[
    #mono(upper(label), size: 6.8pt, fill: color, weight: 600, tracking: 0.08em)
  ]
}

#let page-heading(number, title, status, deck, source: none) = {
  grid(
    columns: (auto, 1fr, auto),
    column-gutter: 9pt,
    align: (left + horizon, left + horizon, right + horizon),
    mono(number, size: 8pt, fill: hu.accent, weight: 600, tracking: 0.12em),
    rect(width: 100%, height: 0.7pt, fill: hu.dim),
    chip(status),
  )
  v(8pt)
  heading(
    level: 1,
    outlined: true,
    bookmarked: true,
  )[
    #text(
      font: f-display,
      size: 31pt,
      fill: ink,
      weight: 800,
      tracking: 0.01em,
    )[#upper(title)]
  ]
  v(3pt)
  box(width: 92%)[
    #mono(deck, size: 9.1pt, fill: ink-mid)
  ]
  if source != none {
    v(5pt)
    mono("SOURCE  /  " + source, size: 6.8pt, fill: ink-dim, tracking: 0.06em)
  }
  v(10pt)
}

#let numbered-code(code, first-line: 1, size: 7.35pt) = {
  let lines = code.split("\n")
  let cells = ()
  for index in range(lines.len()) {
    let line = lines.at(index)
    cells.push(
      align(
        right,
        mono(
          str(first-line + index),
          size: size - 0.25pt,
          fill: ink-dim,
        ),
      ),
    )
    cells.push(
      text(font: f-mono, size: size, fill: ink)[
        #raw(line)
      ],
    )
  }
  grid(
    columns: (20pt, 1fr),
    column-gutter: 8pt,
    row-gutter: 1.7pt,
    ..cells,
  )
}

#let code-block(
  path,
  title,
  status: none,
  size: 7.35pt,
  first-line: 1,
  end-line: none,
  top-rule: true,
) = {
  assert(status != none)
  let lines = read(path).trim().split("\n")
  let selected = if end-line == none {
    lines.slice(first-line - 1)
  } else {
    lines.slice(first-line - 1, end-line)
  }
  let code = selected.join("\n")
  block(
    width: 100%,
    breakable: false,
    inset: (x: 10pt, top: 8pt, bottom: 10pt),
    radius: 2.5pt,
    fill: bg-raised,
    stroke: (
      top: if top-rule { 1.2pt + hu.stroke } else { 0.6pt + border-c },
      rest: 0.6pt + border-c,
    ),
  )[
    #grid(
      columns: (1fr, auto),
      align: (left + horizon, right + horizon),
      mono(title, size: 7pt, fill: ink-dim, tracking: 0.04em),
      chip(status),
    )
    #v(8pt)
    #numbered-code(code, first-line: first-line, size: size)
  ]
}

#let inline-code-block(
  code,
  title,
  status: none,
  size: 7.35pt,
  first-line: 1,
) = {
  assert(status != none)
  block(
    width: 100%,
    breakable: false,
    inset: (x: 10pt, top: 8pt, bottom: 10pt),
    radius: 2.5pt,
    fill: bg-raised,
    stroke: (top: 1.2pt + hu.stroke, rest: 0.6pt + border-c),
  )[
    #grid(
      columns: (1fr, auto),
      align: (left + horizon, right + horizon),
      mono(title, size: 7pt, fill: ink-dim, tracking: 0.04em),
      chip(status),
    )
    #v(8pt)
    #numbered-code(code, first-line: first-line, size: size)
  ]
}

#let callout(title, body, tone: "amber", compact: false) = {
  let color = if tone == "cyan" {
    cyan-signal
  } else if tone == "violet" {
    future-hu.stroke
  } else if tone == "danger" {
    danger
  } else if tone == "success" {
    success
  } else {
    hu.stroke
  }
  block(
    width: 100%,
    inset: if compact { (x: 9pt, y: 7pt) } else { (x: 11pt, y: 9pt) },
    radius: 2pt,
    fill: color.transparentize(94%),
    stroke: (left: 2pt + color, rest: 0.5pt + border-c),
  )[
    #mono(upper(title), size: 7.1pt, fill: color, weight: 600, tracking: 0.08em)
    #v(if compact { 3pt } else { 5pt })
    #mono(body, size: if compact { 7.35pt } else { 8pt }, fill: ink-mid)
  ]
}

#let two-notes(left, right, gap: 9pt) = grid(
  columns: (1fr, 1fr),
  column-gutter: gap,
  left,
  right,
)

#let effect-card(index, title, action, body) = {
  block(
    width: 100%,
    height: 82pt,
    inset: 9pt,
    fill: bg-raised,
    stroke: 0.6pt + border-c,
    radius: 2pt,
  )[
    #grid(
      columns: (22pt, 1fr),
      column-gutter: 7pt,
      [
        #mono(index, size: 8pt, fill: hu.accent, weight: 600)
        #v(4pt)
        #rect(width: 14pt, height: 1.5pt, fill: hu.stroke)
      ],
      [
        #text(font: f-display, size: 16pt, weight: 800, fill: ink)[#upper(title)]
        #v(2pt)
        #mono(action, size: 6.8pt, fill: hu.stroke, weight: 600)
        #v(3pt)
        #mono(body, size: 6.9pt, fill: ink-mid)
      ],
    )
  ]
}

#let flow-node(label, sub: none, tone: "plain", width: auto) = {
  let color = if tone == "active" {
    hu.accent
  } else if tone == "cyan" {
    cyan-signal
  } else if tone == "future" {
    future-hu.accent
  } else {
    ink
  }
  box(
    width: width,
    inset: (x: 8pt, y: 6pt),
    radius: 2pt,
    fill: bg-raised,
    stroke: 0.7pt + color.transparentize(35%),
  )[
    #align(center)[
      #mono(upper(label), size: 7pt, fill: color, weight: 600)
      #if sub != none {
        v(2pt)
        mono(sub, size: 5.9pt, fill: ink-dim)
      }
    ]
  ]
}

#let arrow(label: none, tone: "amber") = {
  let color = if tone == "dim" { ink-dim } else { hu.stroke }
  box(width: 26pt)[
    #align(center)[
      #line(length: 22pt, stroke: 0.8pt + color)
      #text(size: 8pt, fill: color)[>]
      #if label != none {
        v(2pt)
        mono(label, size: 5.5pt, fill: ink-dim)
      }
    ]
  ]
}

#let metric(label, value, note: none, tone: "amber") = {
  let color = if tone == "cyan" { cyan-signal } else { hu.accent }
  block(
    width: 100%,
    inset: 9pt,
    fill: bg-raised,
    stroke: 0.6pt + border-c,
    radius: 2pt,
  )[
    #mono(upper(label), size: 6.5pt, fill: ink-dim, tracking: 0.08em)
    #v(4pt)
    #text(font: f-display, size: 25pt, weight: 800, fill: color)[#value]
    #if note != none {
      v(3pt)
      mono(note, size: 6.7pt, fill: ink-mid)
    }
  ]
}

#let profile-card(name, posture, body, status, tone: "amber") = {
  let color = if tone == "future" { future-hu.stroke } else { hu.stroke }
  block(
    width: 100%,
    inset: 10pt,
    fill: bg-raised,
    stroke: (top: 1.2pt + color, rest: 0.6pt + border-c),
    radius: 2pt,
  )[
    #grid(
      columns: (1fr, auto),
      text(font: f-display, size: 18pt, weight: 800, fill: ink)[#upper(name)],
      chip(status),
    )
    #v(4pt)
    #mono(upper(posture), size: 6.7pt, fill: color, weight: 600, tracking: 0.07em)
    #v(6pt)
    #mono(body, size: 7.35pt, fill: ink-mid)
  ]
}

#let quote-line(body, tone: "amber") = {
  let color = if tone == "cyan" { cyan-signal } else { hu.accent }
  block(
    width: 100%,
    inset: (left: 12pt, right: 8pt, y: 8pt),
    stroke: (left: 2.4pt + color),
  )[
    #text(
      font: f-display,
      size: 19pt,
      fill: ink,
      weight: 700,
      tracking: 0.01em,
    )[#upper(body)]
  ]
}

#let source-line(body) = {
  mono("EVIDENCE  /  " + body, size: 6.6pt, fill: ink-dim, tracking: 0.04em)
}
