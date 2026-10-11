import { ToolGrantPolicy } from "../../src/core/admission/ToolGrant.ts"
import { portableToolHost } from "../../src/core/contract/PortableToolHost.ts"
import type { ToolContract } from "../../src/core/contract/ToolContract.ts"
import type { ReviewContext } from "../../src/core/review/Surface.ts"
import { ToolPolicy } from "../../src/core/session/ToolPolicy.ts"

/** Every contract granted unconditionally: review then checks types, bounds and flows only. */
export const reviewContext = (...contracts: ReadonlyArray<ToolContract.Any>): ReviewContext => ({
  contracts: Object.fromEntries(contracts.map((contract) => [contract.tag, contract])),
  decoders: {},
  host: portableToolHost,
  policy: new ToolPolicy({
    toolGrants: contracts.map((contract) => new ToolGrantPolicy({ id: contract.tag, tool: contract.tag })),
    budget: { maxCalls: 1_000, maxInputBytes: 1_000_000 }
  })
})
