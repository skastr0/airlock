import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

const sourceRoot = resolve(import.meta.dirname, "..", "src")
const compact = (text: string) => text.replace(/\s+/g, "")
const site = (file: string, expression: string) => `${file}:${compact(expression)}`

// Exceptions are individual expressions with occurrence limits, never files.
// Every exception below carries only metadata or primitive escaping inside
// the exact writer; none may encode a tool input, result, or durable record.
const allowed = new Map<string, number>([
  // ExactJson handles -0 itself before invoking the native primitive writer.
  [site("core/ExactJson.ts", "JSON.stringify(value)"), 2],
  [site("core/ExactJson.ts", "JSON.stringify(key)"), 1],
  // Source formatting escapes only string literals and property names.
  [site("core/language/format.ts", "JSON.stringify(node.value)"), 1],
  [site("core/language/format.ts", "JSON.stringify(entry.key)"), 1],
  // Declaration text displays tool names and JSON Schema type literals.
  [site("core/airlock/Declaration.ts", "JSON.stringify(name)"), 1],
  [site("core/airlock/Declaration.ts", "JSON.stringify(value)"), 1],
  [site("core/airlock/Declaration.ts", 'JSON.stringify(schema["const"])'), 1],
  // Contract and decoder identities contain strings only.
  [site("core/contract/ToolContract.ts", 'JSON.stringify([spec.name, spec.version, "input"])'), 1],
  [site("core/contract/ToolContract.ts", 'JSON.stringify([spec.name, spec.version, "output"])'), 1],
  [site("core/contract/Flow.ts", "JSON.stringify([ref.name, ref.version])"), 1],
  [site("core/contract/FlowRules.ts", "JSON.stringify([rule.operation, rule.source.tool, rule.source.part, rule.source.field, rule.sink.tool, rule.sink.field, rule.mode, rule.from])"), 1],
  [site("core/contract/FlowRules.ts", "JSON.stringify([field, decoder.name, decoder.version])"), 1],
  [site("core/contract/FlowRules.ts", "JSON.stringify([...decoded.success].sort((a, b) => a.id.localeCompare(b.id)))"), 1],
  // Checked bindings and refinements are keyed by binding names and decoder identities.
  [site("core/language/check.ts", 'JSON.stringify(["binding", name])'), 1],
  [site("core/language/check.ts", "JSON.stringify([decoder.name, decoder.version])"), 1],
  [site("core/language/run.ts", 'JSON.stringify(["binding", name])'), 1],
  [site("core/review/Review.ts", 'JSON.stringify(["binding", name])'), 2],
  // Witness equality compares sets of provenance identifiers, all strings.
  [site("core/contract/RoleWitness.ts", "JSON.stringify([...new Set(left.provenance)].sort())"), 1],
  [site("core/contract/RoleWitness.ts", "JSON.stringify([...new Set(right.provenance)].sort())"), 1],
  // Labels and transition receipts contain enums, identifiers, and timestamps.
  [site("core/labels/Labels.ts", "Schema.encodeEffect(Schema.fromJsonString(InformationLabel))"), 1],
  [site("core/labels/Labels.ts", "Schema.decodeEffect(Schema.fromJsonString(InformationLabel))"), 1],
  [site("core/labels/Labels.ts", "Schema.encodeEffect(Schema.fromJsonString(LabelTransitionReceipt))"), 1],
  [site("core/labels/Labels.ts", "Schema.decodeEffect(Schema.fromJsonString(LabelTransitionReceipt))"), 1],
  // These are read-only decoders. Their encoders must use exactJsonCodec.
  [site("host/FileOutboxStore.ts", "Schema.decodeUnknownEffect(Schema.fromJsonString(EmissionRecord))"), 1],
  [site("host/FileOutboxStore.ts", "Schema.decodeUnknownEffect(Schema.fromJsonString(SealedDispatch))"), 1],
  // Ledger envelopes carry metadata; carried tool values use exactJsonText.
  [site("host/FileLedger.ts", "Schema.encodeEffect(Schema.fromJsonString(LedgerEntry))"), 1],
  [site("host/FileLedger.ts", "Schema.decodeEffect(Schema.fromJsonString(LedgerEntry))"), 1],
  [site("host/FileLedger.ts", "Schema.encodeEffect(Schema.fromJsonString(LedgerQuarantineEvidence))"), 1],
  [site("host/FileLedger.ts", "JSON.stringify(encoded)"), 1]
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
  const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && (
      (file.startsWith("core/") && !file.startsWith("core/testing/")) ||
      file.startsWith("cloudflare/") ||
      (file.startsWith("host/") && (file.endsWith("Store.ts") || file === "host/FileLedger.ts"))
    ))
  const counts = new Map<string, number>()
  const violations: string[] = []
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(join(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest, true)
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
