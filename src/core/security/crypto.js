// Field-level encryption (AES-256-GCM) for PAN, bank account numbers and TOTP
// secrets, plus hashing helpers for OTPs, tokens and lookups.
const crypto = require('crypto');
const env = require('../../config/env');

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  if (!payload) return payload;
  const [ver, iv, tag, data] = String(payload).split(':');
  if (ver !== 'v1') throw new Error('Unknown cipher version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const hmacSha256 = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');

// OTPs are short, so they are peppered before hashing.
const hashOtp = (code, target) => sha256(`${env.OTP_PEPPER}:${target}:${code}`);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const randomDigits = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// "XXXXXX1234" style masking for lists and logs.
const mask = (value, visible = 4) => (value ? `${'X'.repeat(Math.max(0, String(value).length - visible))}${String(value).slice(-visible)}` : value);

module.exports = { encrypt, decrypt, sha256, hmacSha256, hashOtp, safeEqual, randomDigits, randomToken, mask };
