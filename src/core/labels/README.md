# Label flow

This is a candidate domain capability, not an earned pristine component.

It centralizes a small, stable lattice that already appears at the Plan,
artifact, Cell, and endpoint seams: confidentiality only rises during ordinary
derivation; integrity only falls. Sinks enforce a release ceiling and a control
integrity floor. Declassification and endorsement need concrete,
scope-bound supervisor capability values and produce typed receipts.

The component is deliberately pure. Grant issuance, signature verification,
revocation, receipt persistence, endpoint admission, and profile enforcement
belong at interaction seams or platform adapters; they must not be invented in
this lattice.

It has not earned stronger status because tool definitions, endpoint brokers,
and cross-plan authority-laundering workloads have not yet demonstrated stable
selector, revocation, and persistence semantics. It does not claim per-byte
taint tracking, prevent a deliberately authorized executable from leaking
secret bytes, or prove that a serialized capability was issued by a supervisor.
Those are explicit seam responsibilities.
