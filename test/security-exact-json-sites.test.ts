import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

const packages = ["airlock", "cli", "cloudflare"]
const files = packages.flatMap((pkg) => {
  const root = resolve(import.meta.dirname, "..", "packages", pkg, "src")
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file: join(pkg, "src", file), source: readFileSync(join(root, file), "utf8") }))
})
const compact = (text: string) => text.replace(/\s+/g, "")
const site = (file: string, expression: string) => `${file}:${compact(expression)}`

// Exceptions are individual expressions with occurrence limits, never files.
// Every exception below carries only metadata or primitive escaping inside
// the exact writer; none may encode a tool input, result, or durable record.
const allowed = new Map<string, number>([
  // ExactJson handles -0 itself before invoking the native primitive writer.
  [site(join("airlock", "src", "ExactJson.ts"), "JSON.stringify(value)"), 2],
  [site(join("airlock", "src", "ExactJson.ts"), "JSON.stringify(key)"), 1],
  // Source formatting escapes only string literals and property names.
  [site(join("airlock", "src", "language/format.ts"), "JSON.stringify(node.value)"), 1],
  [site(join("airlock", "src", "language/format.ts"), "JSON.stringify(entry.key)"), 1],
  // Declaration text displays tool names and JSON Schema type literals.
  [site(join("airlock", "src", "airlock/Declaration.ts"), "JSON.stringify(name)"), 1],
  [site(join("airlock", "src", "airlock/Declaration.ts"), "JSON.stringify(value)"), 1],
  [site(join("airlock", "src", "airlock/Declaration.ts"), 'JSON.stringify(schema["const"])'), 1],
  // Contract and decoder identities contain strings only.
  [site(join("airlock", "src", "contract/ToolContract.ts"), 'JSON.stringify([spec.name, spec.version, "input"])'), 1],
  [site(join("airlock", "src", "contract/ToolContract.ts"), 'JSON.stringify([spec.name, spec.version, "output"])'), 1],
  [site(join("airlock", "src", "contract/Flow.ts"), "JSON.stringify([ref.name, ref.version])"), 1],
  [site(join("airlock", "src", "contract/FlowRules.ts"), "JSON.stringify([rule.operation, rule.source.tool, rule.source.part, rule.source.field, rule.sink.tool, rule.sink.field, rule.mode, rule.from])"), 1],
  [site(join("airlock", "src", "contract/FlowRules.ts"), "JSON.stringify([field, decoder.name, decoder.version])"), 1],
  [site(join("airlock", "src", "contract/FlowRules.ts"), "JSON.stringify([...decoded.success].sort((a, b) => a.id.localeCompare(b.id)))"), 1],
  // Checked bindings and refinements are keyed by binding names and decoder identities.
  [site(join("airlock", "src", "language/check.ts"), 'JSON.stringify(["binding", name])'), 1],
  [site(join("airlock", "src", "language/check.ts"), "JSON.stringify([decoder.name, decoder.version])"), 1],
  [site(join("airlock", "src", "language/run.ts"), 'JSON.stringify(["binding", name])'), 1],
  [site(join("airlock", "src", "review/Review.ts"), 'JSON.stringify(["binding", name])'), 2],
  // Witness equality compares sets of provenance identifiers, all strings.
  [site(join("airlock", "src", "contract/RoleWitness.ts"), "JSON.stringify([...new Set(left.provenance)].sort())"), 1],
  [site(join("airlock", "src", "contract/RoleWitness.ts"), "JSON.stringify([...new Set(right.provenance)].sort())"), 1],
  // Labels and transition receipts contain enums, identifiers, and timestamps.
  [site(join("airlock", "src", "labels/Labels.ts"), "Schema.encodeEffect(Schema.fromJsonString(InformationLabel))"), 1],
  [site(join("airlock", "src", "labels/Labels.ts"), "Schema.decodeEffect(Schema.fromJsonString(InformationLabel))"), 1],
  [site(join("airlock", "src", "labels/Labels.ts"), "Schema.encodeEffect(Schema.fromJsonString(LabelTransitionReceipt))"), 1],
  [site(join("airlock", "src", "labels/Labels.ts"), "Schema.decodeEffect(Schema.fromJsonString(LabelTransitionReceipt))"), 1],
  // These are read-only decoders. Their encoders must use exactJsonCodec.
  [site(join("cli", "src", "host", "FileOutboxStore.ts"), "Schema.decodeUnknownEffect(Schema.fromJsonString(EmissionRecord))"), 1],
  [site(join("cli", "src", "host", "FileOutboxStore.ts"), "Schema.decodeUnknownEffect(Schema.fromJsonString(SealedDispatch))"), 1],
  // Ledger envelopes carry metadata; carried tool values use exactJsonText.
  [site(join("cli", "src", "host", "FileLedger.ts"), "Schema.encodeEffect(Schema.fromJsonString(LedgerEntry))"), 1],
  [site(join("cli", "src", "host", "FileLedger.ts"), "Schema.decodeEffect(Schema.fromJsonString(LedgerEntry))"), 1],
  [site(join("cli", "src", "host", "FileLedger.ts"), "Schema.encodeEffect(Schema.fromJsonString(LedgerQuarantineEvidence))"), 1],
  [site(join("cli", "src", "host", "FileLedger.ts"), "JSON.stringify(encoded)"), 1]
])

const member = (node: ts.Node): { owner: string; name: string } | undefined => {
  if (ts.isPropertyAccessExpression(node)) {
    return { owner: compact(node.expression.getText()), name: node.name.text }
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return { owner: compact(node.expression.getText()), name: node.argumentExpression.text }
  }
  return undefined
}

it("confines lossy JSON writers to exact primitive escaping and enumerated metadata sites", () => {
  const scanned = files.filter(({ file }) => file.endsWith(".ts") && (
    (file.startsWith(join("airlock", "src")) && !file.startsWith(join("airlock", "src", "testing"))) ||
    file.startsWith(join("cloudflare", "src")) ||
    (file.startsWith(join("cli", "src", "host")) && (file.endsWith("Store.ts") || file === join("cli", "src", "host", "FileLedger.ts")))
  ))
  const counts = new Map<string, number>()
  const violations: string[] = []
  for (const { file, source: text } of scanned) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      const access = member(node)
      const nativeWriter = access?.name === "stringify" &&
        ["JSON", "globalThis.JSON", 'globalThis["JSON"]', "globalThis['JSON']"].includes(access.owner)
      const schemaCodec = access?.name === "fromJsonString" && access.owner === "Schema"
      if (nativeWriter || schemaCodec) {
        // References passed to callbacks or aliases are rejected as well as calls.
        let expression = node
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          expression = node.parent
          // Bind codec exceptions to their decoder/encoder, so changing a
          // permitted read into a lossy write cannot inherit its exception.
          if (schemaCodec && ts.isCallExpression(expression.parent) && expression.parent.arguments.includes(expression as ts.Expression)) {
            expression = expression.parent
          }
        }
        const key = site(file, expression.getText(source))
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        if (count > (allowed.get(key) ?? 0)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          violations.push(`${file}:${line}: ${expression.getText(source)}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations, "Use exactJsonText/exactJsonCodec for tool values; review each metadata exception explicitly").toEqual([])
})
