// Control Center adapter test helpers: signed requests and a local JWKS server.
// Call configure() BEFORE requiring ./helpers (env is parsed once per test file).
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const KEY_ID = 'cck_test_0123456789abcdef';
const SECRET = 'ccs_test_secret_0123456789abcdef0123456789';

function configure({ jwksPort, scopes = 'ops.read,ops.write,staff.read,staff.write,settings.read,settings.write,keys.write' }) {
  process.env.CC_KEY_ID = KEY_ID;
  process.env.CC_SECRET = SECRET;
  process.env.CC_ALLOWED_SCOPES = scopes;
  process.env.CC_JWKS_URL = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Returns a supertest request with Control Center signature headers.
function signed(request, app, method, path, body, { actor, keyId = KEY_ID, secret = SECRET, ts, nonce } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const t = ts || String(Math.floor(Date.now() / 1000));
  const n = nonce || crypto.randomBytes(16).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update([t, n, method, path, sha(raw)].join('\n')).digest('hex');
  let r = request(app)[method.toLowerCase()](path).set({ 'X-CC-Key': keyId, 'X-CC-Timestamp': t, 'X-CC-Nonce': n, 'X-CC-Signature': sig });
  if (actor) r = r.set('X-CC-Actor', Buffer.from(JSON.stringify(actor)).toString('base64url'));
  if (raw) r = r.set('Content-Type', 'application/json').send(raw);
  return r;
}

const OWNER = { sub: '665f00000000000000000001', email: 'owner@demo.local', name: 'Demo Owner', role: 'owner' };

// A Control Center stand-in: RSA key + JWKS server + assertion signer.
function startIssuer(port) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid-1';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
  });
  const issue = (aud, { sub, ...claims } = {}, { expiresIn = 60, key = privateKey, keyid = kid } = {}) => jwt.sign(
    { email: OWNER.email, name: OWNER.name, role: 'superadmin', path: '/admin/kyc', ctx: { ccUrl: 'http://localhost:5185', env: 'demo', projects: [{ code: aud, name: aud }] }, ...claims },
    key, { algorithm: 'RS256', keyid, issuer: 'control-center', audience: aud, subject: sub || OWNER.sub, jwtid: crypto.randomUUID(), expiresIn },
  );
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, issue, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { configure, signed, startIssuer, OWNER, KEY_ID, SECRET };
