AIRLOCK_POLICY_FILE=/absolute/policy.json \
  airlock run /absolute/create.air \
  --workspace /absolute/workspace \
  --profile native-contained \
  --bindings '{"workspace":"/absolute/workspace"}'

airlock held
airlock undo
