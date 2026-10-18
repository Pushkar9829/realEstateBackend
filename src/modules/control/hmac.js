// Verifies Control Center requests (CC_CONTRACT.md section 2): key, 300 s
// timestamp window, nonce (replay) and HMAC-SHA256 over
//   ts \n nonce \n METHOD \n pathWithQuery \n sha256(rawBody)
// then the scope of the endpoint.
const crypto = require('crypto');
const config = require('./config');
const state = require('./state');
const { CcNonce } = require('./models');
const provider = require('./provider');

const { ApiError } = provider;
const WINDOW_S = 300;
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Keys accepted right now: the rotated key (if any) and, during the grace window, the one before it.
async function candidates() {
  const cfg = config.read();
  const s = await state.get();
  const out = [];
  if (s.key && s.key.keyId && s.key.secretEnc) {
    out.push({ keyId: s.key.keyId, secret: provider.decrypt(s.key.secretEnc) });
    if (s.key.previousKeyId && s.key.previousSecretEnc && new Date(s.key.previousUntil) > new Date()) {
      out.push({ keyId: s.key.previousKeyId, secret: provider.decrypt(s.key.previousSecretEnc) });
    }
  } else {
    out.push({ keyId: cfg.keyId, secret: cfg.secret });
    if (cfg.previousSecret) out.push({ keyId: cfg.keyId, secret: cfg.previousSecret });
  }
  return out;
}

const reject = (req, status, code, message, details) => {
  provider.securityEvent(req, 'cc.request_rejected', { code, path: req.originalUrl.split('?')[0] }).catch(() => {});
  return new ApiError(status, code, message, details);
};

async function verifyRequest(req) {
  const h = (n) => req.get(n);
  const key = h('X-CC-Key'); const ts = h('X-CC-Timestamp'); const nonce = h('X-CC-Nonce'); const sig = h('X-CC-Signature');
  if (!key || !ts || !nonce || !sig || !/^\d{9,11}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    throw reject(req, 401, 'missing_signature', 'Control Center signature headers are missing or malformed');
  }
  const keys = (await candidates()).filter((k) => k.keyId === key);
  if (!keys.length) throw reject(req, 401, 'unknown_key', 'Unknown Control Center key');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > WINDOW_S) {
    throw reject(req, 401, 'timestamp_out_of_window', 'Request timestamp is outside the 300 s window', { serverTime: now });
  }
  const signing = [ts, nonce, req.method.toUpperCase(), req.originalUrl, sha256hex(req.rawBody || '')].join('\n');
  if (!keys.some((k) => safeEqual(hmac(k.secret, signing), sig))) throw reject(req, 401, 'bad_signature', 'Signature does not match');
  try {
    await CcNonce.create({ _id: `${key}:${nonce}` });
  } catch (err) {
    if (err.code === 11000) throw reject(req, 401, 'replayed_nonce', 'This request was already received');
    throw err;
  }
  const actorHeader = h('X-CC-Actor');
  if (actorHeader) {
    try {
      const a = JSON.parse(Buffer.from(actorHeader, 'base64url').toString('utf8'));
      if (a && typeof a.sub === 'string') req.ccActor = { sub: a.sub.slice(0, 64), email: String(a.email || '').slice(0, 200), name: String(a.name || 'Control Center user').slice(0, 80), role: String(a.role || '') };
    } catch { /* ignored: writes then fail with missing_actor */ }
  }
}

// Router-level middleware: raw body capture + signature check (all /api/cc/* routes).
async function authenticate(req, res, next) {
  try {
    await verifyRequest(req);
    if (req.rawBody) {
      try { req.body = JSON.parse(req.rawBody); } catch { throw new ApiError(400, 'BAD_JSON', 'Malformed JSON body'); }
    } else req.body = {};
    next();
  } catch (e) { next(e); }
}

const scope = (needed) => (req, res, next) => {
  if (!config.read().scopes.includes(needed)) return next(new ApiError(403, 'scope_denied', `This platform has not granted ${needed} to the Control Center`, { scope: needed }));
  return next();
};

module.exports = { authenticate, scope, candidates, verifyRequest };
