# Security model

> Status: v1 security contract. Airlock is a reference monitor for
> agent-originated machine effects, not an intent oracle.

## Trust boundary

Untrusted:

- agent output and Airlock program source;
- project files and instructions;
- locators, arguments, downloaded artifacts, and tool output;
- tool definitions before validation and integrity admission;
- existing executables beyond their admitted execution closure.

Trusted:

- host OS/hypervisor primitives in the advertised profile;
- Airlock runtime implementation and terminal authorities;
- grant/policy issuer and explicit promotion authorities;
- durable Hold, Outbox, Artifact, and Journal storage;
- integrity identities admitted by the active Plan.

Any filesystem/process/network tool exposed beside Airlock is a bypass and
invalidates the enclosed claim.

## Execution closure

An executable handle binds a transitive closure:

```text
root/image + executable + loader/shebang chain
+ libraries + environment + configuration
+ descendants + helpers + hooks + plugins
+ pagers/editors/credential helpers/lifecycle scripts
+ filesystem/endpoint/secret grants + limits + lifetime
```

Native containment pre-binds or mediates later execution. Unknown execution is
denied. VM containment may run unknown guest code because the entire guest
remains inside the realm and its host seams are brokered.

Inherited descriptors, ambient environment/config, daemonization, foreign
process attachment, and background descendants cannot escape the closure.

## Persistent authority laundering

Authority can flow across Plans through persistent state:

```text
low-authority plan writes hook/config/executable
  → later high-authority plan consumes it
  → old bytes exercise new authority
```

Airlock classifies execution-adjacent and authority-bearing resources:
executables/search paths, definitions, policy/runtime state, hooks/plugins,
build/package scripts, tool/SCM/startup configuration, launch agents/services,
credential helpers, trust stores, and grant sources.

Persistence preserves provenance and integrity. Apply cannot turn agent bytes
into trusted authority. A later resolver must see the origin across runs and
restarts. Integrity promotion requires a separate supervisor endorsement and
receipt. Head-tool definitions should suppress ambient configuration and hooks
where the underlying tool supports it.

## Confidentiality and integrity

```text
Confidentiality = public < project < private < secret
Integrity       = untrusted < project < operator < runtime
```

Labels attach to observations, artifacts, streams, secrets, definitions,
executables, handles, endpoint sinks, and derived output. Composition joins
confidentiality upward and integrity downward.

- An endpoint declares a confidentiality release ceiling.
- An authority-bearing control input declares minimum integrity.
- Declassification and endorsement are separate, supervisor-granted,
  narrowly scoped, receipted operations.
- Ordinary agent code cannot lower confidentiality or raise integrity.
- Raw secret projection is a disclosed capability, not a declassification.

This is conservative node-level flow, not per-byte taint. A protocol- or
format-aware component can claim more precision only with executable evidence.

Compatibility observes labels without restricting by default. Enclosed
profiles enforce the harness-selected label policy.

## Endpoint broker

Contained code has no ambient host network or host Unix socket. At commit,
Outbox requests a bounded lease:

```text
intent/plan + destination selector + protocol class
+ DNS/redirect/proxy rules + budgets
+ confidentiality ceiling + expiry/revocation
```

The broker evaluates every resolution, redirect, and connection and receipts
the actual destination. VM loopback is guest-local. Host sockets are absent.
Brokered Unix sockets reject descriptor import so peers cannot pass unmodeled
authority.

A transport broker proves an invocation received bounded endpoint authority.
It does not prove high-level protocol semantics. Protocol-aware brokers may
earn narrower receipts and idempotency evidence. Existing tools continue to
implement Git, HTTP, SSH, package, Docker, and database protocols.

Prefer non-extractable credential capabilities—sign or authorize a frozen,
admitted request—over giving raw secret bytes to arbitrary code.

## Two doors and information flow

No process simultaneously holds live managed-state mutation authority and
unmanaged endpoint authority. A networked Cell writes only its private view;
after endpoint closure, its delta is validated and applied separately.

This rule does not prevent:

- confidential read plus external write;
- persistent state gaining authority later; or
- intentional disclosure to a broadly admitted executable.

The label and persistent-authority contracts cover those dimensions.

## Honest limits

Airlock does not protect against kernel/hypervisor/administrator compromise,
a harness bypass, deliberately broad grants, remote consequences after
dispatch, supply-chain malice inside admitted authority, unsupported resource
semantics, or side channels outside the backend's advertised envelope.

If Airlock cannot prove whether dispatch happened, the result is `uncertain`.
If it cannot provide managed-state recovery semantics, the resource is
unsupported or receives a weaker explicitly named contract.
