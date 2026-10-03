#!/usr/bin/env bash
# install.sh — cac 一键安装脚本
set -euo pipefail

REPO="https://raw.githubusercontent.com/nmhjklnm/cac/master"
BIN_DIR="$HOME/bin"

# 颜色
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

echo "=== cac — Claude Code Cloak 安装 ==="
echo

# 1. 检查是否已通过 npm 安装
if command -v cac &>/dev/null; then
    local_cac=$(command -v cac)
    if [[ "$local_cac" == *"node_modules"* ]] || [[ -f "$(dirname "$local_cac" 2>/dev/null)/package.json" ]]; then
        red "⚠ 检测到已通过 npm 安装 claude-cac，请勿同时使用两种安装方式！"
        echo "  如需切换到 bash 安装，请先执行："
        echo "    npm uninstall -g claude-cac"
        exit 1
    fi
fi

# 2. 下载 cac 到 ~/bin
mkdir -p "$BIN_DIR"
printf "下载 cac 和运行时文件 ... "
curl -fsSL "$REPO/cac" -o "$BIN_DIR/cac"
for runtime_file in fingerprint-hook.js relay.js; do
    curl -fsSL "$REPO/src/$runtime_file" -o "$BIN_DIR/$runtime_file"
done
chmod +x "$BIN_DIR/cac"
green "✓"

# 3. 初始化（触发自动写入 PATH 到 shell rc 文件）
export PATH="$BIN_DIR:$PATH"
"$BIN_DIR/cac" env ls >/dev/null 2>&1 || true

echo
green "✓ 安装完成"
echo

# 4. 提示生效方式
RC_FILE=""
if [[ "$(basename "${SHELL:-}")" == "fish" ]]; then
    RC_FILE="$HOME/.config/fish/config.fish"
elif [[ -f "$HOME/.zshrc" ]]; then
    RC_FILE="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
    RC_FILE="$HOME/.bashrc"
elif [[ -f "$HOME/.bash_profile" ]]; then
    RC_FILE="$HOME/.bash_profile"
fi

if [[ -n "$RC_FILE" ]]; then
    echo "执行以下命令使配置生效（或重开终端）："
    echo "  source $RC_FILE"
    echo
fi
echo "然后添加第一个代理配置："
echo "  cac env create <名字> -p <host:port:user:pass>"
