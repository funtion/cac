# ── cmd: delete (uninstall) ────────────────────────────────────────

cmd_delete() {
    echo "=== cac delete ==="
    echo

    local rc_file
    rc_file=$(_detect_rc_file)

    _remove_path_from_rc "$rc_file"

    # stop relay processes and routes
    if [[ -d "$CAC_DIR" ]]; then
        _relay_stop 2>/dev/null || true
        _restore_host_claude_files

        # stop docker port-forward processes
        if [[ -d /tmp/cac-docker-ports ]]; then
            for _pf in /tmp/cac-docker-ports/*.pid; do
                [[ -f "$_pf" ]] || continue
                kill "$(cat "$_pf")" 2>/dev/null || true
                rm -f "$_pf"
            done
            echo "  ✓ stopped docker port-forward processes"
        fi

        # fallback: clean up orphaned relay processes
        pkill -f "node.*\.cac/relay\.js" 2>/dev/null || true

        rm -rf "$CAC_DIR"
        echo "  ✓ deleted $CAC_DIR"
    else
        echo "  - $CAC_DIR does not exist, skipping"
    fi

    local method
    method=$(_install_method)
    echo
    if [[ "$method" == "npm" ]]; then
        echo "  ✓ cleared all cac data and config"
        echo
        echo "to fully uninstall the cac command, run:"
        echo "  npm uninstall -g claude-cac"
    else
        if [[ -f "$HOME/bin/cac" ]]; then
            rm -f "$HOME/bin/cac"
            echo "  ✓ deleted $HOME/bin/cac"
        fi
        echo "  ✓ uninstall complete"
    fi

    echo
    if [[ -n "$rc_file" ]]; then
        echo "please restart terminal or run source $rc_file for changes to take effect."
    else
        echo "please restart terminal for changes to take effect."
    fi
}
