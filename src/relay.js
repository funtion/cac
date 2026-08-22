#!/usr/bin/env node
// cac-relay — Local TCP relay that forwards to upstream proxy (bypasses TUN)
// Usage: node relay.js <listen_port> <upstream_proxy_url> [pid_file]
//
// Listens on 127.0.0.1:<port> as an HTTP proxy, forwards upstream via:
//   - HTTP CONNECT (for http:// upstream)
//   - SOCKS5 (for socks5:// upstream)
//
// Safety: fail-closed design — if relay dies, HTTPS_PROXY points to dead port,
// connections refuse (no IP leak). Watchdog in wrapper auto-restarts relay.
'use strict';

var net = require('net');
var fs = require('fs');

// ── Parse CLI args ──────────────────────────────────────────────

var listenPort = parseInt(process.argv[2], 10);
var upstreamUrl = process.argv[3];
var pidFile = process.argv[4];

if (!listenPort || !upstreamUrl) {
  process.stderr.write('Usage: node relay.js <port> <upstream_proxy_url> [pid_file]\n');
  process.exit(1);
}

var upstream = new URL(upstreamUrl);
var upstreamHost = upstream.hostname;
var upstreamPort = parseInt(upstream.port, 10);
var upstreamUser = decodeURIComponent(upstream.username || '');
var upstreamPass = decodeURIComponent(upstream.password || '');
var isSocks5 = upstream.protocol === 'socks5:';

function log(msg) { process.stderr.write('[cac-relay] ' + msg + '\n'); }

// ── Global error handlers (fail-closed: exit so watchdog restarts) ───

process.on('uncaughtException', function(err) {
  log('uncaught exception: ' + (err && err.stack || err));
  process.exit(1);
});
process.on('unhandledRejection', function(reason) {
  log('unhandled rejection: ' + (reason && reason.stack || reason));
  process.exit(1);
});

// ── Upstream heartbeat (logging only; does not gate connections) ──

var _upstreamHealthy = true;
var HEARTBEAT_INTERVAL = 30000; // 30s
var HEARTBEAT_TIMEOUT = 5000;   // 5s connect timeout
var CONNECT_TIMEOUT = parseInt(process.env.CAC_RELAY_CONNECT_TIMEOUT || '15000', 10); // handshake timeout

function heartbeat() {
  var sock = net.connect({ port: upstreamPort, host: upstreamHost, timeout: HEARTBEAT_TIMEOUT });
  sock.on('connect', function() {
    if (!_upstreamHealthy) log('upstream recovered: ' + upstreamHost + ':' + upstreamPort);
    _upstreamHealthy = true;
    sock.destroy();
  });
  sock.on('error', function() {
    if (_upstreamHealthy) log('upstream unreachable: ' + upstreamHost + ':' + upstreamPort);
    _upstreamHealthy = false;
    sock.destroy();
  });
  sock.on('timeout', function() {
    if (_upstreamHealthy) log('upstream timeout: ' + upstreamHost + ':' + upstreamPort);
    _upstreamHealthy = false;
    sock.destroy();
  });
}

var _heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL);

// ── Helpers ─────────────────────────────────────────────────────

function onceCb(cb) {
  var called = false;
  return function(err, a, b) {
    if (called) return;
    called = true;
    cb(err, a, b);
  };
}

function attachHandshakeTimeout(sock, cb, label) {
  // Covers TCP connect AND upstream handshake (HTTP 200 / SOCKS reply).
  // Cleared by onceCb wrapper only after cb fires — do not clear on 'connect'.
  var timer = setTimeout(function() {
    sock.destroy();
    cb(new Error(label + ' handshake timeout (' + CONNECT_TIMEOUT + 'ms)'));
  }, CONNECT_TIMEOUT);
  return function clearHandshakeTimeout() { clearTimeout(timer); };
}

// ── SOCKS5 handshake ────────────────────────────────────────────

function socks5Connect(targetHost, targetPort, cb) {
  var clearTimer;
  var done = onceCb(function(err, a, b) {
    if (clearTimer) clearTimer();
    cb(err, a, b);
  });
  var sock = net.connect({ port: upstreamPort, host: upstreamHost });
  clearTimer = attachHandshakeTimeout(sock, done, 'socks5');

  function onErr(err) { done(err); }
  sock.on('error', onErr);

  sock.on('connect', function() {
    var hasAuth = upstreamUser && upstreamPass;

    // Greeting: version=5, nmethods=1, method=(0x02 if auth, 0x00 if none)
    sock.write(Buffer.from([0x05, 0x01, hasAuth ? 0x02 : 0x00]));

    var state = 'greeting';
    var buf = Buffer.alloc(0);

    sock.on('data', onData);

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (state === 'greeting') {
        if (buf.length < 2) return;
        var method = buf[1];
        buf = buf.slice(2);

        if (method === 0x02 && hasAuth) {
          var uBuf = Buffer.from(upstreamUser);
          var pBuf = Buffer.from(upstreamPass);
          var authReq = Buffer.alloc(3 + uBuf.length + pBuf.length);
          authReq[0] = 0x01;
          authReq[1] = uBuf.length;
          uBuf.copy(authReq, 2);
          authReq[2 + uBuf.length] = pBuf.length;
          pBuf.copy(authReq, 3 + uBuf.length);
          sock.write(authReq);
          state = 'auth';
        } else if (method === 0x00) {
          sendConnectRequest();
        } else {
          sock.destroy();
          done(new Error('SOCKS5 unsupported auth method: ' + method));
        }
      } else if (state === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) {
          sock.destroy();
          done(new Error('SOCKS5 auth failed'));
          return;
        }
        buf = buf.slice(2);
        sendConnectRequest();
      } else if (state === 'connect') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          sock.destroy();
          done(new Error('SOCKS5 connect failed: reply=' + buf[1]));
          return;
        }
        var atyp = buf[3];
        var addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = 1 + (buf[4] || 0);
        else addrLen = 0;
        var totalLen = 4 + addrLen + 2;
        if (buf.length < totalLen) return;

        var remaining = buf.slice(totalLen);
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
        done(null, sock, remaining);
      }
    }

    function sendConnectRequest() {
      var hostBuf = Buffer.from(targetHost);
      var req = Buffer.alloc(5 + hostBuf.length + 2);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
      state = 'connect';
    }
  });
}

// ── HTTP CONNECT upstream ───────────────────────────────────────

function httpConnect(targetHost, targetPort, cb) {
  var clearTimer;
  var done = onceCb(function(err, a, b) {
    if (clearTimer) clearTimer();
    cb(err, a, b);
  });
  var sock = net.connect({ port: upstreamPort, host: upstreamHost });
  clearTimer = attachHandshakeTimeout(sock, done, 'http');

  function onErr(err) { done(err); }
  sock.on('error', onErr);

  sock.on('connect', function() {
    var connectReq = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\n' +
                     'Host: ' + targetHost + ':' + targetPort + '\r\n';
    if (upstreamUser) {
      var cred = Buffer.from(upstreamUser + ':' + upstreamPass).toString('base64');
      connectReq += 'Proxy-Authorization: Basic ' + cred + '\r\n';
    }
    connectReq += '\r\n';
    sock.write(connectReq);

    var buf = Buffer.alloc(0);
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      var idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;

      var statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      var statusCode = parseInt(statusLine.split(' ')[1], 10);
      var remaining = buf.slice(idx + 4);

      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);

      if (statusCode === 200) {
        done(null, sock, remaining);
      } else {
        sock.destroy();
        done(new Error('Upstream CONNECT failed: ' + statusLine));
      }
    });
  });
}

// ── Connect to upstream (protocol dispatch) ─────────────────────

function connectUpstream(targetHost, targetPort, cb) {
  if (isSocks5) {
    socks5Connect(targetHost, targetPort, cb);
  } else {
    httpConnect(targetHost, targetPort, cb);
  }
}

// ── Local HTTP proxy server ─────────────────────────────────────

var MAX_CONNECTIONS = 512;
var IDLE_TIMEOUT = 1800000; // 30 min — streaming responses can be very long
var activeConnections = 0;
var totalAccepted = 0;
var totalRejected = 0;
var totalConnectOk = 0;
var totalConnectFail = 0;

var server = net.createServer({ pauseOnConnect: true }, function(clientSock) {
  if (activeConnections >= MAX_CONNECTIONS) {
    totalRejected++;
    log('reject: max connections (' + MAX_CONNECTIONS + ') active=' + activeConnections +
        ' rejected=' + totalRejected);
    clientSock.destroy();
    return;
  }
  activeConnections++;
  totalAccepted++;
  clientSock.on('close', function() { activeConnections--; });

  // Idle timeout: only kill truly idle sockets, not active streaming ones
  clientSock.setTimeout(IDLE_TIMEOUT, function() {
    log('idle timeout client active=' + activeConnections);
    clientSock.destroy();
  });
  clientSock.on('error', function(err) {
    log('client error: ' + (err && err.message || err));
  });
  // Stay paused until headers are parsed / tunnel handed off — avoids data loss
  // during the async upstream connect window (pipe() will resume).
  clientSock.on('data', onHeader);
  clientSock.resume();

  var headerBuf = Buffer.alloc(0);

  function onHeader(chunk) {
    headerBuf = Buffer.concat([headerBuf, chunk]);
    var idx = headerBuf.indexOf('\r\n');
    if (idx === -1) return;

    clientSock.removeListener('data', onHeader);
    clientSock.pause();

    var firstLine = headerBuf.slice(0, idx).toString('latin1');
    var rest = headerBuf.slice(idx + 2);

    // CONNECT host:port HTTP/1.1
    var match = firstLine.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/i);
    if (match) {
      handleConnect(clientSock, match[1], parseInt(match[2], 10), rest);
    } else {
      // Plain HTTP proxy request — forward entire request
      handlePlainHttp(clientSock, firstLine, rest);
    }
  }
});

function handleConnect(clientSock, targetHost, targetPort, headerRest) {
  // Consume remaining headers until \r\n\r\n (Buffer-safe)
  var restBuf = Buffer.isBuffer(headerRest) ? headerRest : Buffer.from(headerRest, 'latin1');
  var consumeHeaders = function() {
    var endIdx = restBuf.indexOf('\r\n\r\n');
    if (endIdx !== -1) {
      var trailing = restBuf.slice(endIdx + 4);
      doConnect(trailing);
      return;
    }
    clientSock.once('data', function(chunk) {
      restBuf = Buffer.concat([restBuf, chunk]);
      consumeHeaders();
    });
    clientSock.resume();
  };

  function doConnect(trailingData) {
    clientSock.pause();
    connectUpstream(targetHost, targetPort, function(err, upstreamSock, upstreamExtra) {
      if (err) {
        totalConnectFail++;
        log('CONNECT fail ' + targetHost + ':' + targetPort + ' — ' + (err.message || err) +
            ' (ok=' + totalConnectOk + ' fail=' + totalConnectFail + ' active=' + activeConnections + ')');
        try { clientSock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch(_) {}
        clientSock.destroy();
        return;
      }
      totalConnectOk++;
      try { clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch(_) {
        upstreamSock.destroy();
        return;
      }

      // Reset idle timeout on data activity (keeps streaming alive)
      upstreamSock.on('data', function() {
        try { clientSock.setTimeout(IDLE_TIMEOUT); } catch(_) {}
      });
      clientSock.on('data', function() {
        try { upstreamSock.setTimeout(IDLE_TIMEOUT); } catch(_) {}
      });

      // Flush any bytes that arrived with the handshake BEFORE piping,
      // so byte order does not depend on same-tick pipe buffering.
      if (upstreamExtra && upstreamExtra.length > 0) {
        clientSock.write(upstreamExtra);
      }
      if (trailingData && trailingData.length > 0) {
        upstreamSock.write(trailingData);
      }

      // Pipe bidirectionally (pipe resumes paused sockets)
      clientSock.pipe(upstreamSock);
      upstreamSock.pipe(clientSock);

      // Per-connection errors: destroy peer, don't crash relay / don't inject HTTP into TLS
      clientSock.on('error', function(e) {
        log('tunnel client error ' + targetHost + ':' + targetPort + ' — ' + (e && e.message || e));
        upstreamSock.destroy();
      });
      upstreamSock.on('error', function(e) {
        log('tunnel upstream error ' + targetHost + ':' + targetPort + ' — ' + (e && e.message || e));
        clientSock.destroy();
      });

      // Upstream idle timeout
      upstreamSock.setTimeout(IDLE_TIMEOUT, function() {
        log('idle timeout upstream ' + targetHost + ':' + targetPort);
        upstreamSock.destroy();
      });
    });
  }

  consumeHeaders();
}

function handlePlainHttp(clientSock, firstLine, headerRest) {
  // headerRest is Buffer; keep binary-safe through to upstream
  var restBuf = Buffer.isBuffer(headerRest) ? headerRest : Buffer.from(String(headerRest), 'latin1');
  var clearTimer;
  var done = onceCb(function(err) {
    if (clearTimer) clearTimer();
    if (err) {
      log('plain HTTP upstream connect fail — ' + (err.message || err));
      clientSock.destroy();
    }
  });
  var sock = net.connect({ port: upstreamPort, host: upstreamHost });
  clearTimer = attachHandshakeTimeout(sock, done, 'plain-http');

  function onErr(err) { done(err); }
  sock.on('error', onErr);

  sock.on('connect', function() {
    // TCP connected — clear handshake timer; request/response is open-ended
    if (clearTimer) clearTimer();
    sock.removeListener('error', onErr);
    var authHeader = '';
    if (upstreamUser) {
      var cred = Buffer.from(upstreamUser + ':' + upstreamPass).toString('base64');
      authHeader = 'Proxy-Authorization: Basic ' + cred + '\r\n';
    }
    var head = Buffer.from(firstLine + '\r\n' + authHeader, 'latin1');
    sock.write(Buffer.concat([head, restBuf]));
    clientSock.pipe(sock);
    sock.pipe(clientSock);
    sock.on('error', function(err) {
      log('plain HTTP error — ' + (err && err.message || err));
      clientSock.destroy();
    });
    clientSock.on('error', function() { sock.destroy(); });
  });
}

// ── Lifecycle ───────────────────────────────────────────────────

function writePid() {
  if (pidFile) {
    try { fs.writeFileSync(pidFile, String(process.pid)); } catch (_) {}
  }
}

function cleanup() {
  clearInterval(_heartbeatTimer);
  if (pidFile) {
    try { fs.unlinkSync(pidFile); } catch (_) {}
  }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// ── Server start with self-restart on transient errors ──────────

function startServer() {
  server.listen(listenPort, '127.0.0.1', function() {
    writePid();
    log('listening on 127.0.0.1:' + listenPort + ' \u2192 ' + upstreamHost + ':' + upstreamPort +
        (isSocks5 ? ' (socks5)' : ' (http)') + ' max_conn=' + MAX_CONNECTIONS);
  });
}

server.on('error', function(err) {
  log('server error: ' + err.message);
  if (err.code === 'EADDRINUSE') {
    // Port taken — fatal, let watchdog restart us on a new port
    process.exit(1);
  }
  // Transient error — try to restart after 1s
  setTimeout(function() {
    try { server.close(); } catch(_) {}
    startServer();
  }, 1000);
});

startServer();
