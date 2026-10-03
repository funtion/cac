#!/usr/bin/env python3
"""Exercise installer payloads and missing-hook diagnostics without changing HOME."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="cac-runtime-test-") as scratch:
    scratch = Path(scratch)
    served = scratch / "download"
    (served / "src").mkdir(parents=True)
    for name in ["cac", "src/fingerprint-hook.js", "src/relay.js"]:
        shutil.copy2(repo / name, served / name)
    stubs = scratch / "stubs"
    stubs.mkdir()
    curl = stubs / "curl"
    curl.write_text('''#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) dest="$2"; shift 2 ;;
        https://*) url="$1"; shift ;;
        *) shift ;;
    esac
done
cp "$CAC_TEST_PACKAGE/${url#https://example.invalid/}" "$dest"
''')
    curl.chmod(0o755)
    env = dict(os.environ, CAC_TEST_PACKAGE=str(served))
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    installer = (repo / "install.sh").read_text()
    payload = installer.split("# 2.", 1)[1].split("\n", 1)[1].split("# 3.", 1)[0]
    dest = scratch / "bin"
    subprocess.run(["bash", "-c", 'set -euo pipefail; BIN_DIR="$1"; REPO="https://example.invalid"; green() { :; };\n' + payload,
                    "test-install", str(dest)], env=env, check=True, capture_output=True)
    for name in ["cac", "fingerprint-hook.js", "relay.js"]:
        assert (dest / name).read_bytes() == (repo / name).read_bytes(), name

    source = (repo / "src/cmd_setup.sh").read_text()
    bootstrap = source.split("    # Patch all existing envs:", 1)[0] + "}\n_ensure_initialized\n"
    driver = dest / "cac"
    driver.write_text('''#!/usr/bin/env bash
set -euo pipefail
CAC_DIR="$1"; ENVS_DIR="$CAC_DIR/envs"; VERSIONS_DIR="$CAC_DIR/versions"
_write_dns_guard_js() { :; }
_write_blocked_hosts() { :; }
''' + bootstrap)
    runtime = scratch / "runtime"
    env["PATH"] = str(dest) + os.pathsep + env["PATH"]
    subprocess.run(["bash", str(driver), str(runtime)], env=env, check=True, capture_output=True)
    for name in ["fingerprint-hook.js", "relay.js"]:
        assert (runtime / name).read_bytes() == (repo / name).read_bytes(), name

    check = (repo / "src/cmd_check.sh").read_text()
    check = check.split("    # Missing or unreadable hooks", 1)[1].split("\n", 1)[1].split("    # user_id tracking:", 1)[0]
    env_dir = scratch / "env"
    env_dir.mkdir()
    (env_dir / "hostname").write_text("cac-test-device\n")
    driver_text = '''set -euo pipefail
CAC_DIR="$1"; env_dir="$2"
_read() { cat "$1"; }
check_identity() {
local _id_total=0 _id_ok=0 _id_issues=()
''' + check + '''
printf '%s/%s %s\n' "$_id_ok" "$_id_total" "${_id_issues[*]-}"
}
check_identity
'''
    for name,content,expected in [
        ("missing", None, "0/1 fingerprint hook missing or unreadable"),
        ("broken", "// no identity replacement\n", "0/1 fingerprint hook not working"),
        ("working", (repo / "src/fingerprint-hook.js").read_text(), "1/1"),
    ]:
        target = scratch / name
        target.mkdir()
        if content is not None:
            (target / "fingerprint-hook.js").write_text(content)
        result = subprocess.run(["bash", "-c", driver_text, "test-check", str(target), str(env_dir)],
                                check=True, capture_output=True, text=True)
        assert result.stdout.strip() == expected, (name, result.stdout)
    template = (repo / "src/templates.sh").read_text()
    user_block = template.split("# Usernames are used", 1)[1].split("\n", 1)[1].split('if [[ -r "$CAC_DIR/fingerprint-hook.js" ]]', 1)[0]
    user_env = dict(os.environ, USER="user-old", LOGNAME="user-old", CAC_USERNAME="user-old")
    result = subprocess.run(["bash", "-c", user_block + '\nprintf "%s:%s:%s" "$USER" "$LOGNAME" "${CAC_USERNAME-unset}"'],
                            env=user_env, check=True, capture_output=True, text=True)
    real_user = subprocess.check_output(["id", "-un"], text=True).strip()
    assert result.stdout == f"{real_user}:{real_user}:unset", result.stdout
print("installer payload, bootstrap copies, and missing/broken hook diagnostics: ok")
