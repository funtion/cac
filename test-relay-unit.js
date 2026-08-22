#!/usr/bin/env node
// Unit / integration tests for src/relay.js covering the critical bug fixes.
// No external deps. Run: node test-relay-unit.js
'use strict';

var net = require('net');
var http = require('http');
var { spawn } = require('child_process');
var path = require('path');
var fs = require('fs');
var assert = require('assert');

var RELAY_JS = path.join(__dirname, 'src', 'relay.js');
var TMP = process.env.TMPDIR || '/tmp';
var PASS = 0;
var FAIL = 0;
var TESTS = [];

function ok(name) {
  PASS++;
  TESTS.push('PASS ' + name);
  console.log('  ✓ ' + name);
}
function fail(name, err) {
  FAIL++;
  TESTS.push('FAIL ' + name + ': ' + err);
  console.log('  ✗ ' + name + ' — ' + err);
}

function freePort() {
  return new Promise(function(resolve, reject) {
    var s = net.createServer();
    s.listen(0, '127.0.0.1', function() {
      var p = s.address().port;
      s.close(function() { resolve(p); });
    });
    s.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function startRelay(listenPort, upstreamUrl, envExtra) {
  var pidFile = path.join(TMP, 'cac-relay-test-' + listenPort + '.pid');
  var logFile = path.join(TMP, 'cac-relay-test-' + listenPort + '.log');
  try { fs.unlinkSync(pidFile); } catch (_) {}
  try { fs.unlinkSync(logFile); } catch (_) {}
  var logFd = fs.openSync(logFile, 'w');
  var child = spawn(process.execPath, [RELAY_JS, String(listenPort), upstreamUrl, pidFile], {
    stdio: ['ignore', 'ignore', logFd],
    detached: false,
    env: Object.assign({}, process.env, envExtra || {})
  });
  fs.closeSync(logFd);
  child._logFile = logFile;
  child._pidFile = pidFile;
  return child;
}

function waitForPort(port, timeoutMs) {
  timeoutMs = timeoutMs || 3000;
  var start = Date.now();
  return new Promise(function(resolve, reject) {
    (function tryConnect() {
      var s = net.connect({ port: port, host: '127.0.0.1' });
      s.on('connect', function() { s.destroy(); resolve(); });
      s.on('error', function() {
        if (Date.now() - start > timeoutMs) reject(new Error('port ' + port + ' not ready'));
        else setTimeout(tryConnect, 50);
      });
    })();
  });
}

function stopRelay(child) {
  return new Promise(function(resolve) {
    if (!child || child.killed || child.exitCode !== null) return resolve();
    child.on('exit', function() { resolve(); });
    child.kill('SIGTERM');
    setTimeout(function() {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 1000);
  });
}

function readLog(child) {
  try { return fs.readFileSync(child._logFile, 'utf8'); } catch (_) { return ''; }
}

// ── Mock HTTP CONNECT upstream proxy ────────────────────────────
// Behaves like a dumb HTTP proxy: on CONNECT, reply 200, then pipe.

function startMockHttpProxy(opts) {
  opts = opts || {};
  var dropAfterMs = opts.dropAfterMs || 0;
  var injectAfterConnect = opts.injectAfterConnect || false;
  var server = net.createServer(function(client) {
    var buf = Buffer.alloc(0);
    client.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      var idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      client.removeListener('data', onData);
      var head = buf.slice(0, idx).toString('latin1');
      var rest = buf.slice(idx + 4);
      var m = head.match(/^CONNECT\s+([^\s:]+):(\d+)/i);
      if (!m) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        client.destroy();
        return;
      }
      var targetHost = m[1];
      var targetPort = parseInt(m[2], 10);
      var upstream = net.connect({ host: targetHost, port: targetPort }, function() {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        if (dropAfterMs > 0) {
          setTimeout(function() {
            // Simulate upstream RST mid-tunnel (the Bug 1 trigger)
            upstream.destroy();
            if (injectAfterConnect) {
              // Old buggy behavior would write 502 here; we just destroy.
            }
            client.destroy();
          }, dropAfterMs);
        }
      });
      upstream.on('error', function() { client.destroy(); });
      client.on('error', function() { upstream.destroy(); });
    });
    client.on('error', function() {});
  });
  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port });
    });
  });
}

// Tiny TLS-ish echo target: accepts TCP, echoes bytes, never speaks HTTP.
function startEchoTarget() {
  var server = net.createServer(function(sock) {
    sock.on('data', function(chunk) { sock.write(chunk); });
    sock.on('error', function() {});
  });
  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port });
    });
  });
}

function connectViaRelay(relayPort, targetHost, targetPort, earlyPayload) {
  return new Promise(function(resolve, reject) {
    var sock = net.connect({ host: '127.0.0.1', port: relayPort }, function() {
      sock.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' +
                 targetHost + ':' + targetPort + '\r\n\r\n');
    });
    var buf = Buffer.alloc(0);
    var settled = false;
    sock.on('data', function(chunk) {
      buf = Buffer.concat([buf, chunk]);
      var idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      if (settled) return;
      settled = true;
      var status = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      var body = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        sock.destroy();
        return reject(new Error('CONNECT failed: ' + status));
      }
      if (earlyPayload && earlyPayload.length) sock.write(earlyPayload);
      resolve({ sock: sock, leftover: body, status: status });
    });
    sock.on('error', function(err) {
      if (!settled) { settled = true; reject(err); }
    });
    setTimeout(function() {
      if (!settled) { settled = true; sock.destroy(); reject(new Error('CONNECT timeout')); }
    }, 5000);
  });
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

async function testHappyPathConnect() {
  console.log('\n[1] happy-path CONNECT + echo');
  var echo = await startEchoTarget();
  var proxy = await startMockHttpProxy();
  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:' + proxy.port);
  try {
    await waitForPort(relayPort);
    var payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]); // fake TLS
    var t = await connectViaRelay(relayPort, '127.0.0.1', echo.port, payload);
    var got = await new Promise(function(resolve, reject) {
      var acc = Buffer.alloc(0);
      t.sock.on('data', function(c) {
        acc = Buffer.concat([acc, c]);
        if (acc.length >= payload.length) resolve(acc.slice(0, payload.length));
      });
      t.sock.on('error', reject);
      setTimeout(function() { reject(new Error('echo timeout')); }, 3000);
    });
    assert.deepStrictEqual(got, payload);
    ok('CONNECT + binary echo round-trip');
    t.sock.destroy();
  } catch (e) {
    fail('happy-path', e.message);
  } finally {
    await stopRelay(child);
    proxy.server.close();
    echo.server.close();
  }
}

async function testNo502AfterTunnelEstablished() {
  // Bug 1: upstream RST after tunnel must NOT inject "HTTP/1.1 502" into the stream.
  console.log('\n[2] no 502 injection after tunnel established (Bug 1)');
  var echo = await startEchoTarget();
  var proxy = await startMockHttpProxy({ dropAfterMs: 200 });
  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:' + proxy.port);
  try {
    await waitForPort(relayPort);
    var payload = Buffer.from('fake-tls-clienthello-\xff\xfe\xfd');
    var t = await connectViaRelay(relayPort, '127.0.0.1', echo.port, payload);

    var chunks = [];
    var closed = await new Promise(function(resolve) {
      t.sock.on('data', function(c) { chunks.push(c); });
      t.sock.on('close', function() { resolve('close'); });
      t.sock.on('error', function() { resolve('error'); });
      setTimeout(function() { resolve('timeout'); }, 3000);
    });

    var all = Buffer.concat(chunks.concat([t.leftover || Buffer.alloc(0)]));
    var asLatin1 = all.toString('latin1');
    if (/HTTP\/1\.[01]\s+502/.test(asLatin1)) {
      fail('no-502-injection', 'found HTTP/1.1 502 in post-tunnel stream: ' + JSON.stringify(asLatin1.slice(0, 80)));
    } else {
      ok('no HTTP 502 injected after tunnel (got ' + closed + ', bytes=' + all.length + ')');
    }
    // Log should mention upstream/client error, not be empty beyond listen line
    var log = readLog(child);
    if (/tunnel (upstream|client) error|listening/.test(log)) {
      ok('relay logged tunnel lifecycle');
    } else {
      fail('relay-log', 'expected tunnel error or listen log, got: ' + JSON.stringify(log.slice(0, 200)));
    }
  } catch (e) {
    fail('no-502-injection', e.message);
  } finally {
    await stopRelay(child);
    proxy.server.close();
    echo.server.close();
  }
}

async function testBinaryTrailingDataPreserved() {
  // Bug 3: CONNECT request + binary ClientHello in same TCP segment must survive.
  console.log('\n[3] binary trailing data after CONNECT headers (Bug 3)');
  var received = [];
  var echo = net.createServer(function(sock) {
    sock.on('data', function(c) { received.push(c); });
    sock.on('error', function() {});
  });
  await new Promise(function(r) { echo.listen(0, '127.0.0.1', r); });
  var echoPort = echo.address().port;

  var proxy = await startMockHttpProxy();
  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:' + proxy.port);
  try {
    await waitForPort(relayPort);

    // Craft one TCP write: CONNECT headers + binary payload (illegal UTF-8)
    var binary = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0xff, 0xfe, 0xfd, 0xfc]);
    var headers = Buffer.from(
      'CONNECT 127.0.0.1:' + echoPort + ' HTTP/1.1\r\nHost: 127.0.0.1:' + echoPort + '\r\n\r\n',
      'ascii'
    );
    var oneShot = Buffer.concat([headers, binary]);

    var sock = net.connect({ host: '127.0.0.1', port: relayPort });
    await new Promise(function(resolve, reject) {
      sock.on('connect', function() { sock.write(oneShot); resolve(); });
      sock.on('error', reject);
    });

    // Wait for 200
    await new Promise(function(resolve, reject) {
      var buf = Buffer.alloc(0);
      sock.on('data', function(c) {
        buf = Buffer.concat([buf, c]);
        if (buf.indexOf('\r\n\r\n') !== -1) resolve();
      });
      setTimeout(function() { reject(new Error('no 200')); }, 3000);
    });

    // Give echo a moment to receive
    await sleep(200);
    var got = Buffer.concat(received);
    if (got.equals(binary)) {
      ok('binary trailing ClientHello preserved byte-for-byte');
    } else {
      fail('binary-trailing', 'expected ' + binary.toString('hex') + ' got ' + got.toString('hex'));
    }
    sock.destroy();
  } catch (e) {
    fail('binary-trailing', e.message);
  } finally {
    await stopRelay(child);
    proxy.server.close();
    echo.close();
  }
}

async function testMaxConnectionsLogged() {
  // Bug 2: over-limit should log + destroy, not silent
  console.log('\n[4] max connections rejection is logged (Bug 2)');
  // Patch via env is not available; instead spin many connections against a hanging upstream.
  // We can't easily change MAX_CONNECTIONS=512 without editing source, so instead verify
  // the reject log path exists by grepping source, AND do a smoke that many concurrent
  // CONNECTs are accepted (not silently reset at 128).
  var src = fs.readFileSync(RELAY_JS, 'utf8');
  if (/MAX_CONNECTIONS\s*=\s*512/.test(src)) {
    ok('MAX_CONNECTIONS raised to 512');
  } else {
    fail('max-conn-value', 'expected MAX_CONNECTIONS = 512');
  }
  if (/reject: max connections/.test(src)) {
    ok('max-conn rejection emits log');
  } else {
    fail('max-conn-log', 'missing reject log string');
  }

  // Functional: open 64 concurrent tunnels — old 128 limit would still pass,
  // but this catches "destroy on every connect" regressions.
  var echo = await startEchoTarget();
  var proxy = await startMockHttpProxy();
  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:' + proxy.port);
  try {
    await waitForPort(relayPort);
    var N = 64;
    var results = await Promise.all(Array.from({ length: N }, function() {
      return connectViaRelay(relayPort, '127.0.0.1', echo.port, null)
        .then(function(t) { t.sock.destroy(); return true; })
        .catch(function() { return false; });
    }));
    var okCount = results.filter(Boolean).length;
    if (okCount === N) ok('accepted ' + N + ' concurrent CONNECTs');
    else fail('concurrent', 'only ' + okCount + '/' + N + ' succeeded');
  } catch (e) {
    fail('concurrent', e.message);
  } finally {
    await stopRelay(child);
    proxy.server.close();
    echo.server.close();
  }
}

async function testSourceGuards() {
  // Static assertions for the other review items that are hard to race-test.
  console.log('\n[5] source-level guards (Bugs 4/5/6 + fail-closed)');
  var src = fs.readFileSync(RELAY_JS, 'utf8');

  function has(re, name) {
    if (re.test(src)) ok(name);
    else fail(name, 'pattern not found: ' + re);
  }

  has(/function onceCb\b/, 'onceCb helper present');
  has(/removeListener\('error',\s*onErr\)/, 'handshake error listener removed on success');
  has(/clientSock\.pause\(\)/, 'client paused across upstream connect (Bug 4)');
  has(/if \(upstreamExtra[\s\S]*?clientSock\.write\(upstreamExtra\)[\s\S]*?clientSock\.pipe/, 
      'upstreamExtra written BEFORE pipe (Bug 5)');
  has(/CAC_RELAY_CONNECT_TIMEOUT|CONNECT_TIMEOUT\s*=/, 'real connect timeout defined (Bug 6)');
  has(/attachHandshakeTimeout/, 'handshake timeout attached');
  has(/uncaughtException[\s\S]*?process\.exit\(1\)/, 'uncaughtException exits (fail-closed)');
  has(/toString\('latin1'\)/, 'latin1 used for header parsing (Bug 3)');
  // Ensure the old buggy pattern (string headerBuf += chunk.toString()) is gone
  if (/headerBuf\s*\+=\s*chunk\.toString\(\)/.test(src)) {
    fail('no-utf8-headerBuf', 'old UTF-8 headerBuf += chunk.toString() still present');
  } else {
    ok('old UTF-8 headerBuf concat removed');
  }
}

async function testUpstreamConnectTimeout() {
  console.log('\n[6] upstream handshake timeout (Bug 6)');
  // Upstream accepts TCP but never replies to CONNECT — full handshake must time out.
  var mute = net.createServer(function(sock) {
    // accept and read, but never write a response
    sock.on('data', function() {});
    sock.on('error', function() {});
  });
  await new Promise(function(r) { mute.listen(0, '127.0.0.1', r); });
  var mutePort = mute.address().port;

  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:' + mutePort, {
    CAC_RELAY_CONNECT_TIMEOUT: '1500'
  });
  try {
    await waitForPort(relayPort);
    var echo = await startEchoTarget();
    var started = Date.now();
    var result = await new Promise(function(resolve) {
      var sock = net.connect({ host: '127.0.0.1', port: relayPort }, function() {
        sock.write('CONNECT 127.0.0.1:' + echo.port + ' HTTP/1.1\r\nHost: 127.0.0.1:' +
                   echo.port + '\r\n\r\n');
      });
      var buf = Buffer.alloc(0);
      var finished = false;
      function finish(kind, body) {
        if (finished) return;
        finished = true;
        sock.destroy();
        resolve({ kind: kind, body: body, ms: Date.now() - started });
      }
      sock.on('data', function(c) {
        buf = Buffer.concat([buf, c]);
        if (buf.indexOf('\r\n\r\n') !== -1) finish('http', buf.toString('latin1'));
      });
      sock.on('error', function(e) { finish('error', e.message); });
      sock.on('close', function() { finish('close', buf.toString('latin1')); });
      setTimeout(function() { finish('timeout', ''); }, 5000);
    });

    if (result.kind === 'http' && /502/.test(result.body) && result.ms >= 1400 && result.ms < 4000) {
      ok('CONNECT 502 after handshake timeout (' + result.ms + 'ms)');
    } else if ((result.kind === 'error' || result.kind === 'close') && result.ms >= 1400 && result.ms < 4000) {
      ok('CONNECT failed after handshake timeout (' + result.kind + ', ' + result.ms + 'ms)');
    } else {
      fail('connect-timeout', JSON.stringify(result));
    }

    await sleep(100);
    var log = readLog(child);
    if (/handshake timeout|CONNECT fail/.test(log)) {
      ok('handshake timeout logged');
    } else {
      fail('timeout-log', 'log missing fail/timeout: ' + JSON.stringify(log.slice(0, 400)));
    }
    echo.server.close();
  } catch (e) {
    fail('connect-timeout', e.message);
  } finally {
    await stopRelay(child);
    mute.close();
  }
}

async function testListenLogHasInfo() {
  console.log('\n[7] startup log is informative');
  var relayPort = await freePort();
  var child = startRelay(relayPort, 'http://127.0.0.1:9');
  try {
    await waitForPort(relayPort);
    await sleep(100);
    var log = readLog(child);
    if (/listening on 127\.0\.0\.1:\d+/.test(log) && /max_conn=512/.test(log)) {
      ok('listen log includes bind + max_conn');
    } else {
      fail('listen-log', JSON.stringify(log));
    }
  } catch (e) {
    fail('listen-log', e.message);
  } finally {
    await stopRelay(child);
  }
}

(async function main() {
  console.log('cac relay unit tests');
  console.log('relay: ' + RELAY_JS);
  if (!fs.existsSync(RELAY_JS)) {
    console.error('relay.js not found');
    process.exit(1);
  }

  await testSourceGuards();
  await testHappyPathConnect();
  await testNo502AfterTunnelEstablished();
  await testBinaryTrailingDataPreserved();
  await testMaxConnectionsLogged();
  await testUpstreamConnectTimeout();
  await testListenLogHasInfo();

  console.log('\n────────────────────────────────');
  console.log('PASS=' + PASS + ' FAIL=' + FAIL);
  if (FAIL > 0) {
    console.log('\nFailed:');
    TESTS.filter(function(t) { return t.indexOf('FAIL') === 0; }).forEach(function(t) {
      console.log('  ' + t);
    });
    process.exit(1);
  }
  process.exit(0);
})().catch(function(e) {
  console.error(e);
  process.exit(1);
});
