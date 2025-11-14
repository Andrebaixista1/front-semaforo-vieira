const { URL } = require('url');

const REMOTE_BASE = process.env.UPSTREAM_API_BASE || 'https://ubuntu.sistemavieira.com.br:8003';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

module.exports = async (req, res) => {
  if (!FORWARD_METHODS.has(req.method)) {
    res.status(405).json({ ok: false, error: `Method ${req.method} not supported` });
    return;
  }

  // Handle simple OPTIONS without touching upstream
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(204).end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const upstreamPath = requestUrl.pathname.replace(/^\/api/, '') || '/';
  const targetUrl = `${REMOTE_BASE}${upstreamPath}${requestUrl.search}`;

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await readBody(req);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      body
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, target: targetUrl });
    return;
  }

  setCors(res);
  res.status(upstreamResponse.status);

  upstreamResponse.headers.forEach((value, key) => {
    const header = key.toLowerCase();
    if (header === 'transfer-encoding' || header === 'content-length') return;
    res.setHeader(key, value);
  });

  const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.send(buffer);
};

function sanitizeHeaders(headers) {
  const blocklist = new Set(['host', 'connection', 'content-length']);
  return Object.entries(headers || {}).reduce((acc, [key, value]) => {
    if (!blocklist.has(key.toLowerCase())) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
}
