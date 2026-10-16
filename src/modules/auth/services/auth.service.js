// Module M - registration, contact verification, two-step login with
// mandatory 2FA, password reset, authenticator app (TOTP). Spec 4.13 + Common
// Architecture section 4.
//
// Real-estate specifics:
//   - public signup roles: buyer, lister (owner / builder / landlord); staff are created by admin
//   - international phones (E.164) are accepted; SMS goes only to +91 numbers, so an
//     international user verifies by email and logs in with email OTP or TOTP
//   - staff created by admin must change the temporary password on first login
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const { User, Otp, Consent } = require('../models');
const otpService = require('./otp.service');
const sessions = require('./session.service');
const { notifyUser } = require('../../notifications/service');
const { ApiError } = require('../../../core/http');
const tokens = require('../../../core/security/jwt');
const { encrypt, decrypt, sha256 } = require('../../../core/security/crypto');
const { securityEvent, audit } = require('../../../core/audit');
const events = require('../../../core/events');
const settings = require('../../../core/settings');
const env = require('../../../config/env');

authenticator.options = { step: 30, window: 1 };
const BCRYPT_COST = env.isTest ? 4 : 12; // spec: 10+ (lowered only in tests for speed)
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 4);

const isIndian = (phone) => String(phone).startsWith('+91');
const HOME = { buyer: '/', lister: '/lister', agent: '/agent', manager: '/agent', admin: '/admin', superadmin: '/admin' };
const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => `${a}${'*'.repeat(Math.max(1, b.length))}${c}`) : e);
const maskPhone = (p) => (p ? `${p.slice(0, p.length - 8)}******${p.slice(-2)}` : p);

function verifyTokenOr401(token, typ) {
  try {
    return tokens.verify(token, typ);
  } catch {
    throw ApiError.unauthenticated('This link or session has expired, please start again', 'TOKEN_INVALID');
  }
}

async function uniqueReferralCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
    if (code.length === 8 && !(await User.exists({ referralCode: code }))) return code;
  }
  throw new Error('Could not generate a referral code');
}

const hashPassword = (p) => bcrypt.hash(p, BCRYPT_COST);

// Rejects the current or the last N passwords (auth.passwordHistory, Should).
async function assertNotReused(user, newPassword) {
  const history = [user.passwordHash, ...(user.passwordHistory || [])].filter(Boolean);
  for (const h of history) if (await bcrypt.compare(newPassword, h)) throw ApiError.badRequest('Choose a password you have not used recently', 'PASSWORD_REUSED');
}

async function setPassword(user, newPassword) {
  const keep = await settings.get('auth.passwordHistory');
  user.passwordHistory = [user.passwordHash, ...(user.passwordHistory || [])].filter(Boolean).slice(0, Math.max(0, keep - 1));
  user.passwordHash = await hashPassword(newPassword);
}

// ---------------------------------------------------------------- registration

async function register(data, req) {
  if (!isIndian(data.phone) && !(await settings.get('auth.allowInternationalPhones'))) {
    throw ApiError.validation([{ in: 'body', path: 'phone', message: 'Only Indian mobile numbers are accepted' }]);
  }
  if (await require('../../kyc/service').isBlocked({ phone: data.phone, email: data.email })) {
    throw ApiError.forbidden('Account cannot be created, contact support', 'ACCOUNT_BLOCKED');
  }
  const dup = await User.findOne({ $or: [{ email: data.email }, { phone: data.phone }] }).lean();
  if (dup) {
    const field = dup.email === data.email ? 'email' : 'phone';
    throw ApiError.conflict(`This ${field} is already registered, log in instead`, 'ALREADY_REGISTERED', [{ in: 'body', path: field, message: 'Already registered' }]);
  }
  const user = await User.create({
    name: data.name, email: data.email, phone: data.phone, role: data.role,
    passwordHash: await hashPassword(data.password),
    listerType: data.role === 'lister' ? data.listerType : undefined,
    kyc: data.role === 'lister' ? { status: 'not_started', company: data.companyName ? { name: data.companyName } : undefined } : undefined,
    brand: data.listerType === 'builder' ? { name: data.companyName, approved: false } : undefined,
    referredBy: data.referralCode,
    referralCapturedAt: data.referralCode ? new Date() : undefined,
  });

  const noticeVersion = await settings.get('privacy.noticeVersion');
  if (data.marketingOptIn) {
    await Consent.create({ subjectType: 'user', subjectId: user._id, purpose: 'marketing_alerts', noticeVersion, source: 'registration', ip: req.ip });
  }

  await otpService.issue({ userId: user._id, target: user.email, channel: 'email', purpose: 'verify_email' });
  if (isIndian(user.phone)) await otpService.issue({ userId: user._id, target: user.phone, channel: 'sms', purpose: 'verify_phone' });
  await securityEvent(req, 'user.registered', { userId: user._id, meta: { role: user.role, listerType: user.listerType } });

  return {
    userId: user._id,
    verificationToken: tokens.signVerification(user._id),
    pending: { email: maskEmail(user.email), phone: isIndian(user.phone) ? maskPhone(user.phone) : null },
    phoneVerification: isIndian(user.phone) ? 'sms' : 'not_required',
  };
}

const contactsDone = (u) => u.emailVerified && (u.phoneVerified || !isIndian(u.phone));

async function activate(user) {
  user.status = 'active';
  user.referralCode = user.referralCode || await uniqueReferralCode();
  await user.save();
  events.emit(events.EVENTS.USER_REGISTERED, { userId: user._id, role: user.role });
  const roleNote = user.role === 'lister' ? 'Complete your verification (KYC) to start listing properties.' : 'Start exploring verified properties.';
  await notifyUser({ user, event: 'auth.welcome', channels: ['email', 'in_app'], vars: { roleNote, home: HOME[user.role] } });
}

async function verifyContact({ verificationToken, channel, code }, req) {
  const { sub } = verifyTokenOr401(verificationToken, 'verify');
  const user = await User.findById(sub);
  if (!user) throw ApiError.notFound('Account not found');
  if (channel === 'sms' && !isIndian(user.phone)) throw ApiError.badRequest('Phone verification by SMS is only for Indian numbers', 'SMS_NOT_AVAILABLE');
  if ((channel === 'email' && user.emailVerified) || (channel === 'sms' && user.phoneVerified)) throw ApiError.conflict('Already verified', 'ALREADY_VERIFIED');

  await otpService.verify({ target: channel === 'email' ? user.email : user.phone, purpose: channel === 'email' ? 'verify_email' : 'verify_phone', code });
  if (channel === 'email') user.emailVerified = true; else user.phoneVerified = true;
  await user.save();

  const result = { emailVerified: user.emailVerified, phoneVerified: user.phoneVerified, status: user.status };
  if (contactsDone(user) && user.status === 'pending_verification') {
    await activate(user);
    // The contacts were just proven by OTP, so the first session starts here.
    Object.assign(result, { status: 'active', home: HOME[user.role], ...(await sessions.start(user, req, 'signup_otp')), user: user.toJSON() });
  }
  return result;
}

async function resendOtp({ verificationToken, challengeToken, channel }) {
  if (verificationToken) {
    const { sub } = verifyTokenOr401(verificationToken, 'verify');
    const user = await User.findById(sub);
    if (!user || user.status !== 'pending_verification') throw ApiError.badRequest('Nothing to verify', 'NOTHING_TO_VERIFY');
    if (channel === 'sms' && !isIndian(user.phone)) throw ApiError.badRequest('SMS is only available for Indian numbers', 'SMS_NOT_AVAILABLE');
    const target = channel === 'email' ? user.email : user.phone;
    const { channelUsed } = await otpService.issue({ userId: user._id, target, channel, purpose: channel === 'email' ? 'verify_email' : 'verify_phone' });
    return { channel: channelUsed, sentTo: channelUsed === 'email' ? maskEmail(target) : maskPhone(target) };
  }
  const { sub, cid } = verifyTokenOr401(challengeToken, 'challenge');
  const user = await User.findById(sub);
  const old = await Otp.findById(cid);
  if (!user || !old || old.consumedAt) throw ApiError.unauthenticated('Login session expired, please log in again', 'TOKEN_INVALID');
  const useSms = channel === 'sms' && isIndian(user.phone);
  const target = useSms ? user.phone : user.email;
  const { otp, channelUsed } = await otpService.issue({ userId: user._id, target, channel: useSms ? 'sms' : 'email', purpose: 'login', fallbackEmail: user.email });
  return { challengeToken: tokens.signChallenge(user._id, otp._id), channel: channelUsed, sentTo: channelUsed === 'email' ? maskEmail(user.email) : maskPhone(target) };
}

// ---------------------------------------------------------------- login

async function registerFailedLogin(user, req) {
  const s = await settings.all();
  user.failedLogins += 1;
  await securityEvent(req, 'login.failed', { userId: user._id });
  if (user.failedLogins >= s['auth.lockoutThreshold']) {
    user.status = 'locked';
    user.lockedUntil = new Date(Date.now() + s['auth.lockoutMinutes'] * 60000);
    user.failedLogins = 0;
    await securityEvent(req, 'account.locked', { userId: user._id, meta: { until: user.lockedUntil } });
    await notifyUser({ user, event: 'auth.locked', channels: ['email'], vars: { until: user.lockedUntil.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) } });
  }
  await user.save();
}

function loginMethods(user) {
  return ['email', ...(isIndian(user.phone) ? ['sms'] : []), ...(user.twoFactor.method === 'totp' ? ['totp'] : [])];
}

async function login({ identifier, password, channel }, req) {
  const user = await User.findOne(identifier).select('+passwordHash');
  if (!user || !user.passwordHash) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw ApiError.unauthenticated('Invalid email/phone or password', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'locked') {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ApiError(403, 'ACCOUNT_LOCKED', `Account locked until ${user.lockedUntil.toISOString()} after too many failed attempts`, { lockedUntil: user.lockedUntil });
    }
    user.status = 'active';
    user.lockedUntil = undefined;
  }
  if (['disabled', 'blocked', 'anonymised'].includes(user.status)) throw ApiError.forbidden('This account is disabled, contact support', 'ACCOUNT_DISABLED');

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await registerFailedLogin(user, req);
    throw ApiError.unauthenticated('Invalid email/phone or password', 'INVALID_CREDENTIALS');
  }
  user.failedLogins = 0;
  await user.save();

  if (user.status === 'pending_verification') {
    throw new ApiError(403, 'CONTACT_NOT_VERIFIED', 'Verify your email and phone to continue', {
      verificationToken: tokens.signVerification(user._id), emailVerified: user.emailVerified, phoneVerified: user.phoneVerified,
    });
  }

  const methods = loginMethods(user);
  const allowed = await settings.get('auth.otpChannels');
  let method = channel || user.twoFactor.method || 'email';
  if (!methods.includes(method) || (method !== 'totp' && !allowed.includes(method))) method = 'email';

  const target = method === 'sms' ? user.phone : user.email;
  const { otp, channelUsed } = await otpService.issue({
    userId: user._id, target, channel: method === 'sms' ? 'sms' : 'email', purpose: 'login', fallbackEmail: user.email, totp: method === 'totp',
  });
  return {
    challengeToken: tokens.signChallenge(user._id, otp._id),
    method: channelUsed,
    methods,
    sentTo: channelUsed === 'totp' ? null : channelUsed === 'email' ? maskEmail(user.email) : maskPhone(user.phone),
  };
}

async function verifyLogin2fa({ challengeToken, code, recoveryCode }, req) {
  const { sub, cid } = verifyTokenOr401(challengeToken, 'challenge');
  const user = await User.findById(sub).select('+twoFactor.totpSecretEnc +twoFactor.recoveryCodeHashes +permissions');
  if (!user || user.status !== 'active') throw ApiError.unauthenticated('Account is not active', 'TOKEN_INVALID');
  const challenge = await Otp.findById(cid);
  if (!challenge || String(challenge.userId) !== String(user._id) || challenge.purpose !== 'login') {
    throw ApiError.unauthenticated('Login session expired, please log in again', 'TOKEN_INVALID');
  }

  let method = challenge.codeHash === 'totp' ? 'totp' : `otp_${challenge.channel}`;
  if (recoveryCode) {
    const hash = sha256(recoveryCode.toUpperCase());
    await otpService.verify({ otpId: cid, checker: async () => (user.twoFactor.recoveryCodeHashes || []).includes(hash) });
    user.twoFactor.recoveryCodeHashes = user.twoFactor.recoveryCodeHashes.filter((h) => h !== hash);
    method = 'recovery_code';
  } else if (challenge.codeHash === 'totp') {
    const secret = decrypt(user.twoFactor.totpSecretEnc);
    await otpService.verify({ otpId: cid, code, checker: async (c) => authenticator.check(c, secret) });
  } else {
    await otpService.verify({ otpId: cid, code });
  }

  user.lastLoginAt = new Date();
  await user.save();
  const newDevice = await isNewDevice(user, req);
  const out = await sessions.start(user, req, method);
  if (newDevice) await notifyNewDevice(user, req);
  return { ...out, home: HOME[user.role], mustChangePassword: Boolean(user.mustChangePassword), user: user.toJSON() };
}

// ---------------------------------------------------------------- new-device alert (auth.new_device_login)

// "Chrome on Windows" style label from a user agent (no dependency).
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'an unknown device';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  if (browser || os) return [browser, os].filter(Boolean).join(' on ');
  return s.slice(0, 60);
}

// New = the user has signed in before, but never from this ip + device.
async function isNewDevice(user, req) {
  const { LoginHistory } = require('../models');
  if (!(await LoginHistory.exists({ userId: user._id, success: true }))) return false; // first sign-in
  return !(await sessions.isKnownDevice(user._id, req));
}

async function notifyNewDevice(user, req) {
  const { ip, ua } = sessions.clientInfo(req);
  try {
    await notifyUser({ user, event: 'auth.new_device_login', channels: ['email'], vars: { device: deviceLabel(ua), ip: ip || 'an unknown address' } });
    await securityEvent(req, 'login.new_device', { userId: user._id });
  } catch { /* the alert never blocks a sign-in */ }
}

const refresh = ({ refreshToken }, req) => sessions.rotate(refreshToken, req);

async function logout(body, req) {
  if (body && body.refreshToken) await sessions.revokeByToken(body.refreshToken);
  else if (req.auth && req.auth.sid) await sessions.revokeFamily(req.auth.sid, req.user._id);
  return { loggedOut: true };
}

async function logoutAll(user) {
  await sessions.revokeAll(user._id);
  return { loggedOut: true };
}

// ---------------------------------------------------------------- password reset (no enumeration)

async function forgotPassword({ identifier }, req) {
  const answer = { message: 'If an account exists, a reset code has been sent' };
  const user = await User.findOne(identifier);
  if (!user || ['disabled', 'anonymised'].includes(user.status)) return answer;
  const bySms = Boolean(identifier.phone) && isIndian(user.phone);
  const target = bySms ? user.phone : user.email;
  try {
    await otpService.issue({ userId: user._id, target, channel: bySms ? 'sms' : 'email', purpose: 'reset_password', fallbackEmail: user.email });
  } catch (e) {
    if (!['OTP_COOLDOWN', 'OTP_LIMIT'].includes(e.code)) throw e;
  }
  await securityEvent(req, 'password.reset_requested', { userId: user._id });
  return answer;
}

async function resetPassword({ identifier, code, newPassword }, req) {
  const user = await User.findOne(identifier).select('+passwordHash +passwordHistory');
  if (!user) throw ApiError.badRequest('Code expired, request a new one', 'OTP_EXPIRED');
  const bySms = Boolean(identifier.phone) && isIndian(user.phone);
  await otpService.verify({ target: bySms ? user.phone : user.email, purpose: 'reset_password', code });
  await assertNotReused(user, newPassword);
  await setPassword(user, newPassword);
  if (user.status === 'locked') { user.status = 'active'; user.lockedUntil = undefined; }
  user.failedLogins = 0;
  user.mustChangePassword = false;
  await user.save();
  await sessions.revokeAll(user._id);
  await securityEvent(req, 'password.reset', { userId: user._id });
  await notifyUser({ user, event: 'auth.password_changed', channels: ['email', 'in_app'] });
  return { reset: true };
}

async function changePassword(user, { currentPassword, newPassword }, req) {
  const full = await User.findById(user._id).select('+passwordHash +passwordHistory');
  if (!(await bcrypt.compare(currentPassword, full.passwordHash))) throw ApiError.badRequest('Current password is incorrect', 'INVALID_CREDENTIALS');
  await assertNotReused(full, newPassword);
  await setPassword(full, newPassword);
  full.mustChangePassword = false;
  await full.save();
  const { RefreshToken } = require('../models');
  await RefreshToken.updateMany({ userId: full._id, revokedAt: null, familyId: { $ne: req.auth && req.auth.sid } }, { $set: { revokedAt: new Date() } });
  await securityEvent(req, 'password.changed', { userId: full._id });
  await notifyUser({ user: full, event: 'auth.password_changed', channels: ['email', 'in_app'] });
  return { changed: true };
}

// ---------------------------------------------------------------- TOTP (RE-M-03)

async function totpSetup(user) {
  if (!(await settings.get('auth.totpEnabled'))) throw ApiError.forbidden('Authenticator apps are disabled', 'TOTP_DISABLED');
  const full = await User.findById(user._id);
  const secret = authenticator.generateSecret();
  full.twoFactor.pendingTotpEnc = encrypt(secret);
  await full.save();
  const otpauthUrl = authenticator.keyuri(full.email, await settings.get('general.companyName'), secret);
  return { otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl), secret };
}

async function totpEnable(user, { code }, req) {
  const full = await User.findById(user._id).select('+twoFactor.pendingTotpEnc');
  if (!full.twoFactor.pendingTotpEnc) throw ApiError.badRequest('Start authenticator setup first', 'TOTP_NOT_STARTED');
  if (!authenticator.check(code, decrypt(full.twoFactor.pendingTotpEnc))) throw ApiError.badRequest('Incorrect code from the authenticator app', 'OTP_INVALID');
  const recoveryCodes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  const oldMethod = full.twoFactor.method;
  Object.assign(full.twoFactor, {
    totpSecretEnc: full.twoFactor.pendingTotpEnc, pendingTotpEnc: undefined, recoveryCodeHashes: recoveryCodes.map((c) => sha256(c)),
    method: 'totp', enabledAt: new Date(), changedAt: new Date(),
  });
  await full.save();
  await securityEvent(req, '2fa.changed', { userId: full._id, meta: { from: oldMethod, to: 'totp' } });
  await notifyUser({ user: full, event: 'auth.2fa_changed', channels: ['email'], vars: { oldMethod, newMethod: 'authenticator app' } });
  return { method: 'totp', recoveryCodes };
}

// Spec: disabling TOTP requires a current authenticator code.
async function totpDisable(user, { code }, req) {
  const full = await User.findById(user._id).select('+twoFactor.totpSecretEnc');
  if (full.twoFactor.method !== 'totp') throw ApiError.badRequest('Authenticator app is not enabled', 'TOTP_NOT_ENABLED');
  if (!authenticator.check(code, decrypt(full.twoFactor.totpSecretEnc))) throw ApiError.badRequest('Incorrect code from the authenticator app', 'OTP_INVALID');
  return setOtpMethod(full._id, 'email', req);
}

async function setOtpMethod(userId, method, req, { actor } = {}) {
  const full = await User.findById(userId);
  const oldMethod = full.twoFactor.method;
  full.twoFactor.method = method;
  if (method !== 'totp') { full.twoFactor.totpSecretEnc = undefined; full.twoFactor.recoveryCodeHashes = []; }
  full.twoFactor.changedAt = new Date();
  await full.save();
  await securityEvent(req, '2fa.changed', { userId: full._id, meta: { from: oldMethod, to: method, by: actor ? String(actor._id) : 'self' } });
  await notifyUser({ user: full, event: actor ? 'staff.2fa_reset' : 'auth.2fa_changed', channels: ['email'], vars: { oldMethod, newMethod: method } });
  return { method };
}

// ---------------------------------------------------------------- become a lister (RE-M-09, Could)

async function becomeLister(user, { listerType, companyName }, req) {
  const full = await User.findById(user._id);
  if (full.role !== 'buyer') throw ApiError.conflict('Only buyer accounts can convert', 'NOT_A_BUYER');
  full.role = 'lister';
  full.listerType = listerType;
  full.kyc = { status: 'not_started', company: companyName ? { name: companyName } : undefined };
  if (listerType === 'builder') full.brand = { name: companyName, approved: false };
  await full.save();
  await audit(req, { action: 'user.become_lister', entityType: 'User', entityId: full._id, after: { listerType } });
  await sessions.revokeAll(full._id); // new role -> new tokens
  return { role: 'lister', listerType, home: HOME.lister, reloginRequired: true };
}

module.exports = {
  register, verifyContact, resendOtp, login, verifyLogin2fa, refresh, logout, logoutAll,
  forgotPassword, resetPassword, changePassword, totpSetup, totpEnable, totpDisable, setOtpMethod, becomeLister,
  uniqueReferralCode, hashPassword, maskEmail, maskPhone, isIndian, HOME, BCRYPT_COST, deviceLabel,
};
