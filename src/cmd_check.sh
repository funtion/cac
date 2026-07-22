# ── cmd: check ─────────────────────────────────────────────────

cmd_check() {
    _require_setup

    local verbose=false
    [[ "${1:-}" == "-d" || "${1:-}" == "--detail" ]] && verbose=true

    local current; current=$(_current_env)

    if [[ -z "$current" ]]; then
        echo "error: no active environment — run $(_green "cac env create <name>")" >&2; exit 1
    fi

    local env_dir="$ENVS_DIR/$current"
    local proxy; proxy=$(_parse_proxy "$(_read "$env_dir/proxy" "")")

    # Resolve version
    local ver; ver=$(_read "$env_dir/version" "")
    if [[ -z "$ver" ]] || [[ "$ver" == "system" ]]; then
        local _real; _real=$(_read "$CAC_DIR/real_claude" "")
        if [[ -n "$_real" ]] && [[ -x "$_real" ]]; then
            ver=$("$_real" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "?")
        else
            ver="?"
        fi
    fi

    local problems=()

    # ── header (neutral, no pass/fail yet) ──
    echo
    echo "  $(_bold "$current") $(_dim "(claude $ver)")"
    echo

    # ── wrapper check (instant) ──
    local claude_path; claude_path="$(command -v claude 2>/dev/null || true)"
    local _standard_bin; _standard_bin=$(_standard_claude_bin)
    if [[ "$claude_path" == "$_standard_bin" ]] && _is_cac_managed_claude_entry "$claude_path"; then
        echo "    $(_green "✓") wrapper    active $(_dim "at ~/.local/bin/claude")"
    else
        local _rc; _rc=$(_detect_rc_file)
        if [[ -n "$_rc" ]] && grep -q '# >>> cac' "$_rc" 2>/dev/null; then
            echo "    $(_yellow "⚠") wrapper    configured in ${_rc/#$HOME/~}; restart the shell"
        else
            _write_path_to_rc "$_rc" >/dev/null 2>&1 || true
            echo "    $(_yellow "⚠") wrapper    $(_dim "added standard user bins to ${_rc/#$HOME/~}")"
        fi
        problems+=("claude does not resolve through ~/.local/bin/claude")
    fi

    # ── symlink chain check (instant) ──
    local _link_ok=0 _link_total=0
    local _global_link="$CAC_DIR/bin/claude"
    local _standard_target=""
    _standard_target=$(readlink "$_standard_bin" 2>/dev/null || true)
    [[ -z "$_standard_target" ]] || _standard_target=$(_absolute_link_target "$_standard_bin" "$_standard_target" 2>/dev/null || echo "$_standard_target")
    (( _link_total++ )) || true
    if [[ -L "$_standard_bin" ]] && [[ "$_standard_target" == "$_global_link" ]]; then
        (( _link_ok++ )) || true
    else
        problems+=("~/.local/bin/claude symlink invalid")
    fi

    local _expected_launcher; _expected_launcher=$(_env_launcher_path "$current")
    (( _link_total++ )) || true
    if [[ -L "$_global_link" ]] && [[ "$(readlink "$_global_link" 2>/dev/null || true)" == "$_expected_launcher" ]] && [[ -x "$_expected_launcher" ]]; then
        (( _link_ok++ )) || true
    else
        problems+=("~/.cac/bin/claude symlink invalid")
    fi

    if [[ -n "$ver" ]] && [[ "$ver" != "?" ]] && [[ "$ver" != "system" ]]; then
        local _version_link; _version_link=$(_env_version_link_path "$current")
        local _expected_bin; _expected_bin=$(_version_binary "$ver")
        (( _link_total++ )) || true
        if [[ -L "$_version_link" ]] && [[ "$(readlink "$_version_link" 2>/dev/null || true)" == "$_expected_bin" ]] && [[ -x "$_expected_bin" ]]; then
            (( _link_ok++ )) || true
        else
            problems+=("environment Claude version symlink invalid")
        fi
    fi

    local _expected_config="$env_dir/.claude"
    (( _link_total++ )) || true
    if [[ -L "$HOME/.claude" ]] && [[ "$(readlink "$HOME/.claude" 2>/dev/null || true)" == "$_expected_config" ]] && [[ -d "$_expected_config" ]]; then
        (( _link_ok++ )) || true
    else
        problems+=("~/.claude symlink invalid")
    fi

    local _expected_json="$env_dir/.claude/.claude.json"
    if [[ "$_link_ok" -eq "$_link_total" ]]; then
        if [[ -L "$HOME/.claude.json" ]] && [[ "$(readlink "$HOME/.claude.json" 2>/dev/null || true)" == "$_expected_json" ]]; then
            echo "    $(_green "✓") symlinks   ${_link_ok}/${_link_total} valid $(_dim "+ .claude.json")"
        else
            echo "    $(_green "✓") symlinks   ${_link_ok}/${_link_total} valid"
        fi
    else
        echo "    $(_red "✗") symlinks   ${_link_ok}/${_link_total} valid"
    fi

    # ── telemetry shield (instant) ──
    local wrapper_file="$(_env_launcher_path "$current")"
    local wrapper_content=""
    [[ -f "$wrapper_file" ]] && wrapper_content=$(<"$wrapper_file")
    local telemetry_mode; telemetry_mode=$(_read "$env_dir/telemetry_mode" "transparent")
    # Normalize old names
    case "$telemetry_mode" in conservative) telemetry_mode="stealth" ;; aggressive) telemetry_mode="paranoid" ;; off) telemetry_mode="transparent" ;; esac
    local _tel_stealth_vars=("DISABLE_TELEMETRY" "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA")
    local _tel_paranoid_vars=(
        "CLAUDE_CODE_ENABLE_TELEMETRY" "DO_NOT_TRACK"
        "OTEL_SDK_DISABLED" "OTEL_TRACES_EXPORTER" "OTEL_METRICS_EXPORTER" "OTEL_LOGS_EXPORTER"
        "SENTRY_DSN" "DISABLE_ERROR_REPORTING" "DISABLE_BUG_COMMAND"
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "TELEMETRY_DISABLED" "DISABLE_TELEMETRY"
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"
    )
    if [[ "$telemetry_mode" == "transparent" ]]; then
        echo "    $(_dim "○") telemetry  transparent (no protection)"
    elif [[ "$telemetry_mode" == "paranoid" ]]; then
        local env_ok=0 env_total=${#_tel_paranoid_vars[@]}
        for var in "${_tel_paranoid_vars[@]}"; do
            [[ "$wrapper_content" == *"$var"* ]] && (( env_ok++ )) || true
        done
        if [[ "$env_ok" -eq "$env_total" ]]; then
            echo "    $(_green "✓") telemetry  paranoid ${env_ok}/${env_total} blocked"
        else
            echo "    $(_red "✗") telemetry  paranoid ${env_ok}/${env_total} blocked"
            problems+=("telemetry shield ${env_ok}/${env_total}")
        fi
    else
        local stealth_ok=0
        for var in "${_tel_stealth_vars[@]}"; do
            [[ "$wrapper_content" == *"$var"* ]] && (( stealth_ok++ )) || true
        done
        if [[ "$stealth_ok" -eq 2 ]]; then
            echo "    $(_green "✓") telemetry  stealth (1p blocked, features normal)"
        else
            echo "    $(_red "✗") telemetry  stealth ($stealth_ok/2)"
            problems+=("telemetry shield incomplete")
        fi
    fi

    # ── identity spoofing (consolidated) ──
    local os; os=$(_detect_os)
    local _id_ok=0 _id_total=0 _id_issues=()

    # fingerprint hook
    local _fp_ok=false
    if [[ -f "$CAC_DIR/fingerprint-hook.js" ]] && [[ -f "$env_dir/hostname" ]]; then
        local expected_hn; expected_hn=$(_read "$env_dir/hostname")
        local actual_hn
        actual_hn=$(NODE_OPTIONS="--require $CAC_DIR/fingerprint-hook.js" CAC_HOSTNAME="$expected_hn" \
            node -e "process.stdout.write(require('os').hostname())" 2>/dev/null || true)
        (( _id_total++ )) || true
        if [[ "$actual_hn" == "$expected_hn" ]]; then
            _fp_ok=true; (( _id_ok++ )) || true
        else
            _id_issues+=("fingerprint hook not working")
        fi
    fi
    # git email
    (( _id_total++ )) || true
    if [[ -f "$env_dir/git_email" ]]; then
        (( _id_ok++ )) || true
    else
        _id_issues+=("git email not spoofed")
    fi
    # repo hash
    (( _id_total++ )) || true
    if [[ -f "$env_dir/fake_git_remote" ]]; then
        (( _id_ok++ )) || true
    else
        _id_issues+=("repo hash not spoofed")
    fi
    # user_id tracking: sync from .claude.json after login (real userID wins)
    local _uid_ok=true
    local _config_dir="$ENVS_DIR/$current/.claude"
    local _cj="$_config_dir/.claude.json"
    [[ -f "$_cj" ]] || _cj="$HOME/.claude.json"
    if [[ -f "$_cj" ]]; then
        local _actual_uid
        _actual_uid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('userID',''))" "$_cj" 2>/dev/null || true)
        if [[ -n "$_actual_uid" ]]; then
            (( _id_total++ )) || true
            echo "$_actual_uid" > "$env_dir/user_id" 2>/dev/null || true
            (( _id_ok++ )) || true
        fi
    fi
    # billing header
    (( _id_total++ )) || true
    [[ "$wrapper_content" == *"CLAUDE_CODE_ATTRIBUTION_HEADER"* ]] && { (( _id_ok++ )) || true; } || _id_issues+=("billing header exposed")

    # display consolidated identity line
    local _id_extra=""
    [[ -f "$env_dir/persona" ]] && _id_extra=" + $(_read "$env_dir/persona")"
    if [[ "$_id_ok" -eq "$_id_total" ]]; then
        echo "    $(_green "✓") identity   ${_id_ok}/${_id_total} spoofed${_id_extra}"
    else
        echo "    $(_red "✗") identity   ${_id_ok}/${_id_total} spoofed${_id_extra}"
        for _ii in "${_id_issues[@]}"; do
            problems+=("$_ii")
        done
    fi

    # ── IPv6 leak detection ──
    local ipv6_leak=false
    if [[ "$os" == "macos" ]]; then
        local ipv6_addrs
        ipv6_addrs=$(ifconfig 2>/dev/null | grep -c "inet6 [2-3]" || true)
        [[ "$ipv6_addrs" -gt 0 ]] && ipv6_leak=true
    elif [[ "$os" == "linux" ]]; then
        local ipv6_addrs
        ipv6_addrs=$(ip -6 addr show scope global 2>/dev/null | grep -c "inet6" || true)
        [[ "$ipv6_addrs" -gt 0 ]] && ipv6_leak=true
    fi
    if [[ "$ipv6_leak" == "true" ]]; then
        echo "    $(_yellow "⚠") IPv6       global address detected (potential leak)"
    else
        echo "    $(_green "✓") IPv6       no global address"
    fi

    # ── warnings (only shown when relevant) ──
    if [[ -d "$HOME/.claude/telemetry" ]]; then
        local tel_files
        tel_files=$(find "$HOME/.claude/telemetry" -type f 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$tel_files" -gt 0 ]]; then
            echo "    $(_yellow "⚠") residual   $tel_files telemetry files in ~/.claude/telemetry/"
        fi
    fi
    local _claude_count
    _claude_count=$(pgrep -x "claude" 2>/dev/null | wc -l | tr -d '[:space:]') || _claude_count=0
    local _max_sessions; _max_sessions=$(_cac_setting max_sessions 10)
    if [[ "$_claude_count" -gt "$_max_sessions" ]]; then
        echo "    $(_yellow "⚠") sessions   $_claude_count running (threshold: $_max_sessions)"
    fi
    if [[ "$os" == "macos" ]]; then
        security find-generic-password -s "claude-code-credentials" >/dev/null 2>&1 && \
            echo "    $(_yellow "⚠") keychain   Trusted Device Token residual"
    fi

    # ── network check (slow — streaming output) ──
    local proxy_ip=""
    if [[ -n "$proxy" ]]; then
        if ! _proxy_reachable "$proxy"; then
            echo "    $(_red "✗") proxy      unreachable"
            problems+=("proxy unreachable: $proxy")
        else
            # Fast retry with dots: each attempt adds a dot
            local _ip_url _dots=""
            local _urls="https://api.ip.sb/ip https://ip.3322.net https://api.ipify.org https://ipinfo.io/ip https://api.ip.sb/ip"
            for _ip_url in $_urls; do
                _dots="${_dots}."
                printf "\r    · exit IP    $(_dim "detecting${_dots}")"
                proxy_ip=$(curl --proxy "$(_curl_proxy_url "$proxy")" --connect-timeout 3 --max-time 6 "$_ip_url" 2>/dev/null || true)
                [[ "$proxy_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
                proxy_ip=""
            done
            # Overwrite the "detecting..." line
            if [[ -n "$proxy_ip" ]]; then
                printf "\r    $(_green "✓") exit IP    $(_cyan "$proxy_ip")\033[K\n"
                # TZ vs exit IP consistency check
                local env_tz; env_tz=$(_read "$env_dir/tz" "")
                if [[ -n "$env_tz" ]] && [[ -n "$proxy_ip" ]]; then
                    local ip_tz
                    ip_tz=$(curl -s --proxy "$(_curl_proxy_url "$proxy")" --connect-timeout 5 "http://ip-api.com/json/$proxy_ip?fields=timezone" 2>/dev/null | \
                        python3 -c "import sys,json; print(json.load(sys.stdin).get('timezone',''))" 2>/dev/null || true)
                    if [[ -n "$ip_tz" ]] && [[ "$ip_tz" != "$env_tz" ]]; then
                        echo "    $(_yellow "⚠") TZ        mismatch: env=$env_tz, IP=$ip_tz"
                        problems+=("TZ mismatch: env=$env_tz vs IP=$ip_tz")
                    fi
                fi
            else
                printf "\r    $(_red "✗") exit IP    $(_dim "unable to verify via proxy")\033[K\n"
                problems+=("exit IP undetected via proxy")
            fi

            # TUN conflict detection
            if [[ -n "$proxy_ip" ]]; then
            local has_conflict=false
            local tun_procs="clash|mihomo|sing-box|surge|shadowrocket|v2ray|xray|hysteria|tuic|nekoray"
            local running
            if [[ "$os" == "macos" ]]; then
                running=$(ps aux 2>/dev/null | grep -iE "$tun_procs" | grep -v grep || true)
            else
                running=$(ps -eo comm 2>/dev/null | grep -iE "$tun_procs" || true)
            fi
            [[ -n "$running" ]] && has_conflict=true
            if [[ "$os" == "macos" ]]; then
                local tun_count; tun_count=$(ifconfig 2>/dev/null | grep -cE '^utun[0-9]+' || echo 0)
                [[ "$tun_count" -gt 3 ]] && has_conflict=true
            elif [[ "$os" == "linux" ]]; then
                ip link show tun0 >/dev/null 2>&1 && has_conflict=true
            fi

            if [[ "$has_conflict" == "true" ]]; then
                local relay_ok=false
                if _relay_is_running 2>/dev/null; then
                    local rport; rport=$(_read "$CAC_DIR/relay.port" "")
                    local relay_ip; relay_ip=$(curl --proxy "http://127.0.0.1:$rport" --connect-timeout 8 --max-time 12 https://api.ipify.org 2>/dev/null || true)
                    [[ -n "$relay_ip" ]] && relay_ok=true
                elif [[ -f "$CAC_DIR/relay.js" ]]; then
                    local _test_env; _test_env=$(_current_env)
                    if _relay_start "$_test_env" 2>/dev/null; then
                        local rport; rport=$(_read "$CAC_DIR/relay.port" "")
                        local relay_ip; relay_ip=$(curl --proxy "http://127.0.0.1:$rport" --connect-timeout 8 --max-time 12 https://api.ipify.org 2>/dev/null || true)
                        _relay_stop 2>/dev/null || true
                        [[ -n "$relay_ip" ]] && relay_ok=true
                    fi
                fi

                if [[ "$relay_ok" == "true" ]]; then
                    echo "    $(_green "✓") TUN        relay bypass active"
                else
                    local proxy_hp; proxy_hp=$(_proxy_host_port "$proxy")
                    local proxy_host="${proxy_hp%%:*}"
                    echo "    $(_red "✗") TUN        conflict — add DIRECT rule for $proxy_host"
                    problems+=("TUN conflict: add DIRECT rule for $proxy_host in proxy software")
                fi
            fi
            fi
        fi
    else
        echo "    $(_green "✓") mode       API Key (no proxy)"
    fi

    # ── summary ──
    echo
    if [[ ${#problems[@]} -eq 0 ]]; then
        echo "  $(_green "✓") all good"
    else
        for p in "${problems[@]}"; do
            echo "  $(_red "✗") $p"
        done
    fi
    echo

    # ── verbose mode ──
    if [[ "$verbose" == "true" ]]; then
        echo "  $(_bold "Identity")"
        echo "    $([[ "$_fp_ok" == "true" ]] && _green "✓" || _red "✗") hostname    $(_read "$env_dir/hostname" "—")"
        echo "    $([[ -f "$env_dir/git_email" ]] && _green "✓" || _yellow "⚠") git email   $(_read "$env_dir/git_email" "—")"
        echo "    $([[ -f "$env_dir/fake_git_remote" ]] && _green "✓" || _yellow "⚠") repo hash   $(_read "$env_dir/fake_git_remote" "—")"
        echo "    $([[ "$_uid_ok" == "true" ]] && _green "✓" || _yellow "⚠") user_id     $(_read "$env_dir/user_id" "—" | cut -c1-16)..."
        echo "    $([[ "$wrapper_content" == *"CLAUDE_CODE_ATTRIBUTION_HEADER"* ]] && _green "✓" || _yellow "⚠") billing     $([[ "$wrapper_content" == *"CLAUDE_CODE_ATTRIBUTION_HEADER"* ]] && echo "disabled" || echo "exposed")"
        [[ -f "$env_dir/persona" ]] && echo "    $(_green "✓") persona     $(_read "$env_dir/persona")"
        echo
        echo "  $(_bold "Details")"
        echo "    $(_dim "UUID")       $(_read "$env_dir/uuid")"
        echo "    $(_dim "stable_id")  $(_read "$env_dir/stable_id")"
        echo "    $(_dim "MAC")        $(_read "$env_dir/mac_address" "—")"
        echo "    $(_dim "machine_id") $(_read "$env_dir/machine_id" "—")"
        echo "    $(_dim "TZ")         $(_read "$env_dir/tz" "—")"
        echo "    $(_dim "LANG")       $(_read "$env_dir/lang" "—")"
        echo "    $(_dim "env")        ${env_dir/#$HOME/~}/.claude/"
        echo "    $(_dim "claude")     ~/.claude -> $(readlink "$HOME/.claude" 2>/dev/null || echo "—")"
        echo "    $(_dim "binary")     ${env_dir/#$HOME/~}/bin/claude -> $(readlink "$env_dir/bin/claude" 2>/dev/null || echo "—")"
        echo
        echo "  $(_bold "Telemetry") ($telemetry_mode mode)"
        if [[ "$telemetry_mode" == "transparent" ]]; then
            echo "    $(_dim "  no telemetry protection active")"
        fi
        local _vvars=("${_tel_stealth_vars[@]}")
        [[ "$telemetry_mode" == "paranoid" ]] && _vvars=("${_tel_paranoid_vars[@]}")
        for var in "${_vvars[@]}"; do
            if [[ "$wrapper_content" == *"$var"* ]]; then
                printf "    $(_green "✓") %s\n" "$var"
            else
                printf "    $(_red "✗") %s\n" "$var"
            fi
        done
        echo
        printf "  $(_bold "DNS block")  "
        if [[ -f "$CAC_DIR/cac-dns-guard.js" ]]; then
            _check_dns_block "statsig.anthropic.com"
        else
            echo "$(_red "✗")"
        fi
        printf "  $(_bold "mTLS")       "
        _check_mtls "$env_dir"
        echo
    fi
}
