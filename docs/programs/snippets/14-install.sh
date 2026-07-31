bun install
bun run verify
bun run build:macos
sh scripts/install-macos.sh
export PATH="$HOME/.local/bin:$PATH"

airlock doctor
airlock actions
airlock schema plan
airlock-agent actions
