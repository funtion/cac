#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-hook-test-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const gitOptions = { cwd: scratch, env: gitEnv, encoding: 'utf8' };
  try {
    cp.execFileSync('git', ['init', '-q'], gitOptions);
    cp.execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/real/project.git'], gitOptions);
    cp.execFileSync('git', ['config', 'user.email', 'developer@example.com'], gitOptions);
    const configPath = path.join(scratch, '.git/config');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const dockerBefore = fs.existsSync('/.dockerenv');
    const cgroupBefore = fs.existsSync('/proc/1/cgroup') ? fs.readFileSync('/proc/1/cgroup', 'utf8') : null;
    const execBefore = cp.exec;
    const execSyncBefore = cp.execSync;
    const execFileSyncBefore = cp.execFileSync;
    const userBefore = os.userInfo();
    os.networkInterfaces = () => ({
      lo: [{ mac: '00:00:00:00:00:00' }],
      eth0: [{ mac: 'aa:bb:cc:dd:ee:ff' }],
    });
    Object.assign(process.env, {
      CAC_HOSTNAME: 'test-device', CAC_MAC: '02:11:22:33:44:55',
      CAC_USERNAME: 'test-user', CAC_MACHINE_ID: 'test-machine-id',
      // Legacy variables must no longer alter Git or container detection.
      CAC_FAKE_GIT_REMOTE: 'https://example.com/fake/project.git',
      CAC_GIT_EMAIL: 'fake@example.com', CAC_HIDE_DOCKER: '1',
    });
    require('../src/fingerprint-hook.js');

    assert.equal(os.hostname(), 'test-device');
    assert.deepEqual(os.userInfo(), userBefore);
    assert.equal(os.userInfo().homedir, userBefore.homedir);
    assert.equal(os.userInfo().uid, userBefore.uid);
    assert.equal(os.networkInterfaces().lo[0].mac, '00:00:00:00:00:00');
    assert.equal(os.networkInterfaces().eth0[0].mac, '02:11:22:33:44:54');
    assert.equal(fs.readFileSync('/etc/machine-id', 'utf8'), 'test-machine-id\n');
    assert.equal(fs.readFileSync('/var/lib/dbus/machine-id').toString(), 'test-machine-id\n');
    assert.equal(await promisify(fs.readFile)('/etc/machine-id', 'utf8'), 'test-machine-id\n');
    assert.equal(await fs.promises.readFile('/etc/machine-id', 'utf8'), 'test-machine-id\n');

    assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore);
    assert.equal(await promisify(fs.readFile)(configPath, 'utf8'), configBefore);
    assert.equal(await fs.promises.readFile(configPath, 'utf8'), configBefore);
    assert.equal(cp.execSync('git remote get-url origin', gitOptions).trim(), 'https://example.com/real/project.git');
    assert.equal(cp.execFileSync('git', ['remote', 'get-url', 'origin'], gitOptions).trim(), 'https://example.com/real/project.git');
    assert.equal((await promisify(cp.exec)('git remote get-url origin', gitOptions)).stdout.trim(), 'https://example.com/real/project.git');
    assert.equal(cp.execSync('git config --get user.email', gitOptions).trim(), 'developer@example.com');
    assert.equal(cp.execFileSync('git', ['config', '--get', 'user.email'], gitOptions).trim(), 'developer@example.com');
    assert.equal(fs.existsSync('/.dockerenv'), dockerBefore);
    if (cgroupBefore !== null) assert.equal(fs.readFileSync('/proc/1/cgroup', 'utf8'), cgroupBefore);
    if (process.platform !== 'win32') {
      assert.equal(cp.exec, execBefore);
      assert.equal(cp.execSync, execSyncBefore);
      assert.equal(cp.execFileSync, execFileSyncBefore);
    }
    console.log('device identity, real Git data, and container detection: ok');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
module.exports = main;
if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
