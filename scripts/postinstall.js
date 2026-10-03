#!/usr/bin/env node
var path = require('path');
var fs = require('fs');

var pkgDir = path.join(__dirname, '..');
var cacBin = path.join(pkgDir, 'cac');
var home = process.env.HOME || process.env.USERPROFILE || '';
var cacDir = path.join(home, '.cac');

// Ensure cac is executable
try { fs.chmodSync(cacBin, 0o755); } catch (e) {}

// Auto-sync runtime files on install/upgrade
// Pure Node.js — no bash/zsh dependency
// Ensures bug fixes (dns-guard, relay, fingerprint-hook) take effect immediately
try {
  fs.mkdirSync(cacDir, { recursive: true });
  var files = ['cac-dns-guard.js', 'relay.js', 'fingerprint-hook.js'];
  for (var i = 0; i < files.length; i++) {
    var src = path.join(pkgDir, files[i]);
    var dst = path.join(cacDir, files[i]);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }
} catch (e) {
  // Non-fatal — _ensure_initialized will catch it on first cac command
}

// Patch existing wrapper for known bugs — pure Node.js, no shell execution needed.
// Users who upgrade via npm install keep their old ~/.cac/bin/claude until _ensure_initialized
// runs (triggered by any cac command). This patch fixes critical bugs immediately.
var wrapperPath = path.join(cacDir, 'bin', 'claude');
if (home && fs.existsSync(wrapperPath)) {
  try {
    var wrapperContent = fs.readFileSync(wrapperPath, 'utf8');
    var patched = wrapperContent;
    // Fix: pgrep returns exit 1 when no claude process exists; under set -euo pipefail
    // this aborts the wrapper before launching claude (claude appears to do nothing).
    var buggyPgrep = '_claude_count=$(pgrep -x "claude" 2>/dev/null | wc -l | tr -d \'[:space:]\')';
    var fixedPgrep = buggyPgrep + ' || _claude_count=0';
    if (patched.indexOf(buggyPgrep) !== -1 && patched.indexOf(fixedPgrep) === -1) {
      patched = patched.replace(buggyPgrep, fixedPgrep);
    }
    // Fix: session exit killed the shared relay, breaking all other sessions.
    // Remove the trap so _cleanup_all never fires on exit.
    var buggyTrap = 'trap _cleanup_all EXIT INT TERM';
    if (patched.indexOf(buggyTrap) !== -1) {
      patched = patched.replace(buggyTrap, '');
    }
    if (patched !== wrapperContent) {
      fs.writeFileSync(wrapperPath, patched);
    }
  } catch (e) {
    // Non-fatal
  }
}

// Migrate existing environments: generate missing files added in v1.5.0
// (device_token)
try {
  var crypto = require('crypto');
  var envsDir = path.join(cacDir, 'envs');
  if (fs.existsSync(envsDir)) {
    var envs = fs.readdirSync(envsDir);
    for (var ei = 0; ei < envs.length; ei++) {
      var envDir = path.join(envsDir, envs[ei]);
      if (!fs.statSync(envDir).isDirectory()) continue;
      // device_token
      if (!fs.existsSync(path.join(envDir, 'device_token'))) {
        fs.writeFileSync(path.join(envDir, 'device_token'), crypto.randomBytes(32).toString('hex') + '\n');
      }
      // Migrate telemetry mode names
      var tmFile = path.join(envDir, 'telemetry_mode');
      if (fs.existsSync(tmFile)) {
        var tm = fs.readFileSync(tmFile, 'utf8').trim();
        var mapped = { conservative: 'stealth', aggressive: 'paranoid', off: 'transparent' };
        if (mapped[tm]) fs.writeFileSync(tmFile, mapped[tm] + '\n');
      }
    }
  }
} catch (e) {
  // Non-fatal — cac env create will generate these for new environments
}

// Trigger _ensure_initialized to fully regenerate wrapper to current version.
// cac env ls now calls _require_setup (fixed in 1.4.3+).
if (home) {
  try {
    var spawnSync = require('child_process').spawnSync;
    spawnSync(cacBin, ['env', 'ls'], {
      stdio: 'ignore',
      timeout: 8000,
      env: Object.assign({}, process.env, { HOME: home })
    });
  } catch (e) {
    // Non-fatal
  }
}

console.log([
  '',
  '  claude-cac installed successfully',
  '',
  '  Quick start:',
  '    cac env create <name> [-p <proxy>]   Create an isolated environment',
  '    cac <name>                           Switch environment',
  '    claude                               Start Claude Code',
  '',
  '  Docs: https://cac.nextmind.space/docs',
  ''
].join('\n'));
