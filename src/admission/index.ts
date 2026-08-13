// Admission is a candidate pristine component: it owns the typed boundary
// between inert drafts and runtime-minted authority, but no platform I/O.
export * from "./Admission.ts"
// A versioned, supervisor-authored box grant. It is not wired to the CLI.
export * from "./BoxGrant.ts"
// Dispatch classes are grant-side only: this module owns the vocabulary, the
// canonical endpoint match, the auto-commit eligibility decision, and the
// typed refusal for agent-side text that tries to name a class.
export * from "./DispatchPolicy.ts"
// The supervisor-plane answer to "which staged nodes may commit without a
// further human act", shaped so no consumer can widen or re-derive a class.
export * from "./SupervisorDispatch.ts"
