# Vouch-first adoption

> Status: first adoption contract, not a Vouch-specific architecture.

## Why Vouch goes first

Vouch supplies a real agent workload with local snapshots, external transport,
credentials, validation, replacement, and recovery. It exercises all four
Airlock effect classes and both terminal authorities without requiring a new
physics node.

Vouch is an acceptance corpus, not the source of Airlock vocabulary. No
`Vouch*` Plan constructor, runtime operation, resource kind, or terminal
authority is permitted.

## Vertical slice

```text
snapshot → upload → restore → validate → replace
```

Candidate general lowering:

| Vouch step | general Airlock composition |
|---|---|
| inspect source state | `Capture` labeled files/metadata and bind identities |
| create snapshot | `Invoke` an existing archive/tool closure in a private view; capture artifact |
| upload | `RequestExternal` with a frozen invocation; `Outbox.commit` issues endpoint/credential leases; capture receipt |
| restore candidate | `Invoke` existing tool into a private view; produce `LocalDelta` |
| validate | `Invoke` validation closure with no live mutation authority; capture result |
| replace | `Apply` validated delta through Hold |
| recover conflict/failure | typed reconciliation or another recoverable `Apply`; never guessed success |

Credentials should be brokered as non-extractable capabilities when the
provider/tool seam permits it. Raw projection is an explicit compatibility
fallback.

## Adoption stages

1. Observe real Vouch shell work with shell still available.
2. Shadow-lower every effect to Plan and measure translation/task coverage,
   unsupported semantics, definition demand, and granularity cost.
3. Run the vertical slice in `vm-enclosed` with the agent receiving only
   Airlock.
4. Run the enforceable subset in `native-contained` and publish the capability
   difference.
5. Add definitions only for repeated, stable actions; definitions remain inert
   and authority-free.
6. Freeze the initial vocabulary and run an unrelated held-out repository
   workload.
7. Remove Vouch's direct shell permission only after the full macOS acceptance
   contract earns strong confidence.

## Required evidence

- no Vouch-specific Plan/runtime node;
- every live local replacement through Hold;
- every external activation through Outbox and EndpointBroker;
- secret/credential disclosure recorded at the actual precision;
- complete execution closure for archive, validation, and transport tools;
- persisted restore output cannot become trusted policy/config/execution
  without endorsement;
- byte/metadata recovery for the supported resource envelope;
- honest partial/uncertain outcomes across crash injection;
- completion, escape, latency, and resource metrics against the direct-shell
  baseline.

## Overfitting tripwire

If the Vouch slice requires a new primitive, the first response is to test
whether it is:

1. pure composition missing from the authoring language;
2. a resource or endpoint classification missing from Admission;
3. a lifecycle transition missing from the trusted runtime;
4. an adapter/tool definition; or
5. genuinely new physics.

Only the fifth can contest the closed algebra, and it requires an unrelated
Unix counterexample plus contract review.
