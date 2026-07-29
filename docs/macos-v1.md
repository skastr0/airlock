# macOS v1 runtime contract

> Status: v1 release contract. Backend mechanisms are candidates until the
> acceptance evidence identifies the exact tested implementation.

## What ships first

Airlock v1 targets macOS. Apple silicon is the primary tested platform; the
standalone builder also emits an x86_64 target. The installation provides one
agent-facing RPC/CLI surface and three explicit profiles over the same Plan,
runtime, Hold, Outbox, label, and receipt contracts.

Profile selection is external to the agent and is part of the ratchet. A
selected contained profile never silently falls back to compatibility.

## Compatibility

`compatibility` is the zero-configuration profile:

- broad structured invocation under the user's existing host authority;
- unknown tools remain runnable;
- recovery, staging, labels, and receipts where they preserve capability;
- restrictions only when explicitly enabled;
- no containment or complete-mediation claim.

Automatic expiry-based Outbox flush, if enabled, is reported as a cancellation
window rather than an affirmative gate.

## VM-enclosed

`vm-enclosed` is the broad shell-replacement profile.

### Realm

- An Airlock-owned macOS VM has an identified base image.
- Each run uses a private working view; a persistent Cell has an explicit
  identity, lifetime, checkpoint, and cleanup policy.
- The guest receives no ambient host mount, host loopback, Unix socket,
  clipboard, keychain, launchd, Docker socket, device, or management channel.
- Host resources enter through typed brokers and runtime-minted handles.

### Files

- Declared host inputs are exposed read-only or materialized as labeled
  artifacts.
- Writable work occurs in the private guest view.
- The Cell emits a finite `LocalDelta`.
- The host validates expected identities, labels, resource kinds, liveness,
  and writable envelope.
- Only Hold applies the delta to live host state.

Guest unlink is disposal inside the private realm. It has no live-host meaning
until the resulting absence is represented in an admitted Apply.

### Execution

The complete execution closure remains inside the VM. Unknown guest binaries
and descendants may run, but they cannot acquire undeclared host handles or
broker leases. The Cell finishes only after its descendants exit or are
terminated.

Every process starts from the structured
`{ executable, args, stdin, stdout, stderr, timeout }` contract. `args` excludes
the executable; there is no shell text or implicit `argv[0]` convention in the
agent-facing seam.

### Endpoints

The guest has no ambient route to host or internet endpoints. Its gateway
accepts only EndpointBroker leases issued by `Outbox.commit`. The broker owns
DNS, redirects, proxies, destination checks, byte/connection/time budgets, and
actual-destination receipts.

## Native-contained

`native-contained` is the lower-overhead subset:

- private APFS-backed writable view;
- runtime-constructed environment and descriptors;
- owned process closure and resource budgets;
- admitted filesystem handles;
- only brokerable endpoint classes;
- no unknown/unmediated helper execution;
- all live changes still merge through Hold.

It is not a promise of VM equivalence. If the active macOS backend cannot
enforce a requested filesystem, process, endpoint, or descriptor property, the
capability is unavailable.

## Capability probe

Before a contained run, the runtime publishes a Schema-validated capability
report:

```text
platform and OS build
Airlock/runtime/backend versions
CPU architecture
profile
VM/native backend and base-image identity
supported resource kinds and metadata
supported endpoint classes and broker precision
execution-closure limitations
label enforcement
Hold volume/retention properties
known semantic coarsenings
evidence-suite version
```

The agent can inspect this report but cannot alter it. Plans bind its digest.
Backend drift between plan and run is a typed refusal.

## Failure posture

- Missing enforcement is `CapabilityUnavailable`, not a downgrade.
- A host/guest/broker crash reconciles to a proven terminal state,
  `recovery-required`, or `uncertain`.
- A VM loss cannot invent a successful Apply or dispatch.
- A dispatch that may have reached a recipient remains `uncertain`.
- Resource pressure invokes declared budgets and retention policy; it never
  silently destroys the last managed copy.

## v1 boundary

The public v1 claim is earned by `vm-enclosed`. Native-contained is published
as a capability matrix. Linux, remote realms, GUI automation, kernel/admin
work, and unsupported live or device state are later or explicitly excluded
surfaces.
