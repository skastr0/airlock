/**
 * Parse-only corpus: no identifiers here are privileged commands. A future
 * lowering layer decides which action calls map to Airlock capabilities.
 */
export const restoreOrchestration = `
let snapshot = inspect_snapshot("nightly")
assert snapshot.complete, "snapshot must be complete"
let members = snapshot.members

for member in 0..2 {
  let target = members[member]
  assert target.enabled
  run({ action: "restore", source: target.archive, destination: target.path })
}

if verify_restore(snapshot) {
  emit({ action: "notify", message: "restore complete", after: 30s })
} else {
  return { status: "verification_failed" }
}
`

export const examples = { restoreOrchestration } as const
