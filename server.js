'use strict';

const http = require('node:http');

// 环境变量统一做空值兜底。
const configuredPort = Number.parseInt(process.env.PORT || '8080', 10);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 8080;
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function normalizeIp(rawIp) {
  // 规范化地址：去空白、去方括号、剥离 IPv4-mapped 前缀和 zone id。
  let ip = typeof rawIp === 'string' ? rawIp.trim() : '';

  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1).trim();
  }

  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) {
    ip = ip.slice(0, zoneIndex);
  }

  return ip;
}

function headerValue(value) {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : '';
  }

  return typeof value === 'string' ? value : '';
}

function clientIp(req) {
  // 信任代理时依次读取 X-Real-IP、X-Forwarded-For 首段，最后回退到 socket。
  if (TRUST_PROXY) {
    const realIp = normalizeIp(headerValue(req.headers['x-real-ip']));
    if (realIp) {
      return realIp;
    }

    const forwarded = headerValue(req.headers['x-forwarded-for']).split(',')[0];
    const forwardedIp = normalizeIp(forwarded);
    if (forwardedIp) {
      return forwardedIp;
    }
  }

  // 不信任代理时只取 TCP 对端地址，避免伪造转发头。
  return normalizeIp(req.socket.remoteAddress || '');
}

function send(res, code, body, ctype) {
  res.statusCode = code;
  res.setHeader('Content-Type', `${ctype}; charset=utf-8`);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');

  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  }

  // HEAD 请求的响应体会由 Node 自动省略。
  res.end(body);
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';

  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'method not allowed', 'text/plain');
    return;
  }

  // Nginx 可能剥离路径前缀，也可能保留，因此这里只检查路径结尾。
  const pathname = (req.url || '/').split('?')[0];

  if (pathname.endsWith('/healthz')) {
    send(res, 200, 'ok', 'text/plain');
    return;
  }

  const ip = clientIp(req);
  const family = ip.includes(':') ? 'IPv6' : 'IPv4';

  send(res, 200, JSON.stringify({ ip, family }), 'application/json');
});

server.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
  console.log(`listening on [::]:${PORT}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
