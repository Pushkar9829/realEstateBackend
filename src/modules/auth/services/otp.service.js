// One-time passwords (spec 4.1 business rules):
//   6 digits, peppered SHA-256 hash, valid auth.otpExpiryMin (5), auth.otpMaxAttempts (5),
//   resend after auth.otpResendSec (60 s), max 5 sends per target per hour and 10 per day.
const { Otp } = require('../models');
const { ApiError } = require('../../../core/http');
const { hashOtp, randomDigits, safeEqual } = require('../../../core/security/crypto');
const settings = require('../../../core/settings');
const env = require('../../../config/env');
const { sendNow } = require('../../notifications/service');

const PURPOSE_LABEL = {
  verify_email: 'email verification', verify_phone: 'phone verification', login: 'login',
  reset_password: 'password reset', step_up: 'confirmation', contact_change: 'verification', guest_enquiry: 'enquiry verification',
};
const HOUR = 3600 * 1000;

async function assertSendAllowed(target, purpose) {
  const s = await settings.all();
  const last = await Otp.findOne({ target, purpose }).sort({ createdAt: -1 });
  if (last && Date.now() - last.lastSentAt.getTime() < s['auth.otpResendSec'] * 1000) {
    const wait = Math.ceil((s['auth.otpResendSec'] * 1000 - (Date.now() - last.lastSentAt.getTime())) / 1000);
    throw new ApiError(429, 'OTP_COOLDOWN', `Please wait ${wait} seconds before requesting another code`, { retryAfterSec: wait });
  }
  const [hour, day] = await Promise.all([
    Otp.countDocuments({ target, createdAt: { $gt: new Date(Date.now() - HOUR) } }),
    Otp.countDocuments({ target, createdAt: { $gt: new Date(Date.now() - 24 * HOUR) } }),
  ]);
  if (hour >= 5 || day >= 10) {
    // Tell the user when the oldest code in the window expires, instead of a vague "later".
    const windowMs = hour >= 5 ? HOUR : 24 * HOUR;
    const oldest = await Otp.findOne({ target, createdAt: { $gt: new Date(Date.now() - windowMs) } }).sort({ createdAt: 1 }).select('createdAt');
    const mins = oldest ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + windowMs - Date.now()) / 60000)) : 60;
    const when = mins >= 120 ? `in about ${Math.round(mins / 60)} hours` : `in ${mins} minute${mins === 1 ? '' : 's'}`;
    throw new ApiError(429, 'OTP_LIMIT', `Too many codes requested. Try again ${when}.`, { retryAfterSec: mins * 60 });
  }
}

/**
 * Issue and deliver a new code. Earlier open codes for the same target and
 * purpose are expired. Returns { otp, channelUsed }.
 * For TOTP login challenges pass { totp: true }: no code is sent, the record
 * only tracks attempts.
 */
async function issue({ userId, target, channel, purpose, fallbackEmail, totp = false }) {
  const s = await settings.all();
  if (!totp) await assertSendAllowed(target, purpose);
  await Otp.updateMany({ target, purpose, consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date() } });

  const code = totp ? null : (env.DEMO_OTP_CODE || randomDigits(6)); // DEMO_OTP_CODE: fixed code on demo deployments
  const otp = await Otp.create({
    userId, target, channel: channel === 'sms' ? 'sms' : 'email', purpose,
    codeHash: totp ? 'totp' : hashOtp(code, target),
    expiresAt: new Date(Date.now() + s['auth.otpExpiryMin'] * 60000),
  });
  let channelUsed = totp ? 'totp' : channel;
  if (!totp) {
    channelUsed = await sendNow({
      channel, to: target, event: 'auth.otp', fallbackEmail,
      vars: { code, purposeLabel: PURPOSE_LABEL[purpose], expiryMin: s['auth.otpExpiryMin'] },
    });
  }
  return { otp, channelUsed };
}

// Re-send a fresh code for an existing challenge / verification record.
async function resend(otpDoc, { fallbackEmail } = {}) {
  return issue({ userId: otpDoc.userId, target: otpDoc.target, channel: otpDoc.channel, purpose: otpDoc.purpose, fallbackEmail });
}

/**
 * Check a code. Pass either `otpId` (login challenge) or target + purpose
 * (latest open code). `checker` lets TOTP challenges reuse the attempt counter.
 * Throws OTP_EXPIRED / OTP_ATTEMPTS_EXCEEDED / OTP_INVALID (with attemptsLeft).
 */
async function verify({ otpId, target, purpose, code, checker }) {
  const s = await settings.all();
  const doc = otpId
    ? await Otp.findById(otpId)
    : await Otp.findOne({ target, purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!doc || doc.consumedAt || doc.expiresAt < new Date()) throw ApiError.badRequest('Code expired, request a new one', 'OTP_EXPIRED');
  if (doc.attempts >= s['auth.otpMaxAttempts']) throw ApiError.badRequest('Too many wrong attempts, request a new code', 'OTP_ATTEMPTS_EXCEEDED');

  const good = checker ? await checker(code) : safeEqual(doc.codeHash, hashOtp(code, doc.target));
  if (!good) {
    doc.attempts += 1;
    await doc.save();
    const attemptsLeft = Math.max(0, s['auth.otpMaxAttempts'] - doc.attempts);
    throw new ApiError(400, attemptsLeft ? 'OTP_INVALID' : 'OTP_ATTEMPTS_EXCEEDED', attemptsLeft ? `Incorrect code, ${attemptsLeft} attempts left` : 'Too many wrong attempts, request a new code', { attemptsLeft });
  }
  doc.consumedAt = new Date();
  await doc.save();
  return doc;
}

module.exports = { issue, resend, verify, PURPOSE_LABEL };
