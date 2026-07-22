#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d /tmp/cac-transparent-entrypoint.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

test_home="$test_root/home"
native_bin="$test_home/.local/share/claude/versions/1.0.0"
managed_bin="$test_home/.cac/versions/1.0.0/claude"
env_dir="$test_home/.cac/envs/work"

mkdir -p "$test_home/.local/bin" "$(dirname "$native_bin")" \
    "$(dirname "$managed_bin")" "$env_dir/.claude" "$test_home/.claude"

printf '#!/usr/bin/env bash\necho native\n' > "$native_bin"
printf '#!/usr/bin/env bash\necho managed\n' > "$managed_bin"
chmod +x "$native_bin" "$managed_bin"
ln -s "$native_bin" "$test_home/.local/bin/claude"

printf 'work\n' > "$test_home/.cac/current"
printf '1.0.0\n' > "$env_dir/version"
printf '{}\n' > "$env_dir/.claude/settings.json"
printf '{}\n' > "$test_home/.claude.json"
cat > "$test_home/.bashrc" <<'EOF'
# >>> cac — Claude Code Cloak >>>
export PATH="$HOME/.cac/bin:$PATH"
# <<< cac — Claude Code Cloak <<<
EOF

test_path="$test_home/.local/bin:/usr/bin:/bin"
HOME="$test_home" SHELL=/bin/bash PATH="$test_path" "$repo_dir/cac" env ls >/dev/null
rc_after_first=$(<"$test_home/.bashrc")
HOME="$test_home" SHELL=/bin/bash PATH="$test_path" "$repo_dir/cac" env ls >/dev/null
[[ "$(<"$test_home/.bashrc")" == "$rc_after_first" ]]

resolved=$(HOME="$test_home" PATH="$test_path" /bin/bash -c \
    'source "$HOME/.bashrc"; command -v claude')
[[ "$resolved" == "$test_home/.local/bin/claude" ]]
[[ "$(readlink "$test_home/.local/bin/claude")" == "$test_home/.cac/bin/claude" ]]
[[ "$(readlink "$test_home/.cac/host/bin/claude")" == "$native_bin" ]]
[[ "$(tr -d '[:space:]' < "$test_home/.cac/real_claude")" == "$native_bin" ]]
! grep -q '\.cac/bin' "$test_home/.bashrc"
[[ "$(HOME="$test_home" PATH="$test_path" "$test_home/.local/bin/claude")" == "managed" ]]

HOME="$test_home" SHELL=/bin/bash PATH="$test_path" "$repo_dir/cac" stop >/dev/null
[[ "$(readlink "$test_home/.local/bin/claude")" == "$native_bin" ]]

HOME="$test_home" SHELL=/bin/bash PATH="$test_path" "$repo_dir/cac" work >/dev/null
[[ "$(readlink "$test_home/.local/bin/claude")" == "$test_home/.cac/bin/claude" ]]

HOME="$test_home" SHELL=/bin/bash PATH="$test_path" "$repo_dir/cac" \
    env create fresh -c 1.0.0 >/dev/null
fresh_telemetry=$(tr -d '[:space:]' < "$test_home/.cac/envs/fresh/telemetry_mode")
if [[ "$fresh_telemetry" != "transparent" ]]; then
    echo "expected new environment telemetry=transparent, got $fresh_telemetry" >&2
    exit 1
fi

echo "transparent entrypoint: ok"
