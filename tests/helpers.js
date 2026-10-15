const mongoose = require('mongoose');
const request = require('supertest');
const { connectDb } = require('../src/config/db');
const { createApp } = require('../src/app');
const { User, Otp } = require('../src/modules/auth/models');
const { signAccess } = require('../src/core/security/jwt');
const notify = require('../src/core/notify');
const settings = require('../src/core/settings');

async function setup() {
  if (mongoose.connection.readyState !== 1) await connectDb();
  await mongoose.connection.db.dropDatabase();
  // dropDatabase also drops the indexes built at connect; rebuild them (unique keys matter in tests).
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));
  settings.clearCache();
  notify.sent.length = 0;
  return createApp();
}

// Direct DB user + access token (for tests that are not about the auth flows).
let n = 0;
async function userWithToken(role, extra = {}) {
  n += 1;
  const user = await User.create({
    name: `${role} user`, email: `${role}${n}.${Date.now()}@test.local`, phone: `+919${String(Date.now() + n).slice(-9)}`,
    role, status: 'active', emailVerified: true, phoneVerified: true, ...extra,
  });
  return { user, token: signAccess(user) };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Latest 6-digit code sent to an email / E.164 phone (test mail / SMS capture).
function otpFor(target) {
  const msg = [...notify.sent].reverse().find((m) => m.to === target && /\b\d{6}\b/.test(m.text));
  if (!msg) throw new Error(`No OTP captured for ${target}`);
  return msg.text.match(/\b(\d{6})\b/)[1];
}

// Move earlier OTPs out of the cooldown and hourly windows (tests that log in many times).
async function resetOtpLimits(target) {
  await Otp.collection.updateMany({ target }, { $set: { lastSentAt: new Date(Date.now() - 120000), createdAt: new Date(Date.now() - 2 * 3600000) } });
}

let seq = 0;
function newIdentity(prefix = 'u', { international = false } = {}) {
  seq += 1;
  const tail = String(Date.now() + seq).slice(-8);
  return {
    name: 'Test User',
    email: `${prefix}${seq}.${tail}@example.com`,
    phone: international ? `+4477${tail}${seq % 10}` : `9${tail}${seq % 10}`,
    password: 'Secret123',
  };
}

const e164 = (phone) => (phone.startsWith('+') ? phone : `+91${phone}`);

function registerBody(id, role = 'buyer', extra = {}) {
  return {
    role, name: id.name, email: id.email, phone: id.phone, password: id.password, confirmPassword: id.password, acceptTerms: true,
    ...(role === 'lister' ? { listerType: 'owner', noBrokerDeclaration: true } : {}), ...extra,
  };
}

// Full API path: register -> verify OTPs -> active with tokens.
async function registerActive(app, role = 'buyer', extra = {}, opts = {}) {
  const id = newIdentity(role, opts);
  const reg = await request(app).post('/api/auth/register').send(registerBody(id, role, extra));
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const { verificationToken } = reg.body.data;
  let last = await request(app).post('/api/auth/verify-contact').send({ verificationToken, channel: 'email', code: otpFor(id.email) });
  if (e164(id.phone).startsWith('+91')) {
    last = await request(app).post('/api/auth/verify-contact').send({ verificationToken, channel: 'sms', code: otpFor(e164(id.phone)) });
  }
  if (!last.body.data || !last.body.data.accessToken) throw new Error(`verify failed: ${JSON.stringify(last.body)}`);
  return { ...id, phoneE164: e164(id.phone), userId: reg.body.data.userId, ...last.body.data };
}

// Two-step login with an email OTP. Returns step 2 data (tokens, home, user).
async function loginFull(app, identifier, password, { channel = 'email', target } = {}) {
  await resetOtpLimits(target || identifier);
  const step1 = await request(app).post('/api/auth/login').send({ identifier, password, channel });
  if (step1.status !== 200) throw new Error(`login failed: ${JSON.stringify(step1.body)}`);
  const step2 = await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: step1.body.data.challengeToken, code: otpFor(target || identifier) });
  if (step2.status !== 200) throw new Error(`2fa failed: ${JSON.stringify(step2.body)}`);
  return step2.body.data;
}

module.exports = { setup, userWithToken, bearer, otpFor, resetOtpLimits, newIdentity, registerBody, registerActive, loginFull, e164 };
