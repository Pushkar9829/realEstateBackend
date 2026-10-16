// Module M request schemas (zod), spec 4.13 business rules.
const { z } = require('zod');

// Password: 8-64 characters with at least one letter and one digit.
const password = z.string().min(8).max(64)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/[0-9]/, 'must contain a digit');

// Phone -> E.164. A 10-digit Indian mobile (6-9...) becomes +91XXXXXXXXXX;
// "+<country><number>" (8-15 digits) is accepted as international (RE-M-01).
const phone = z.string().trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .transform((v, ctx) => {
    const indian = v.replace(/^(\+?91|0)(?=[6-9]\d{9}$)/, '');
    if (/^[6-9]\d{9}$/.test(indian)) return `+91${indian}`;
    if (/^\+[1-9]\d{7,14}$/.test(v) && !v.startsWith('+91')) return v;
    ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit Indian mobile or an international number starting with +' });
    return z.NEVER;
  });

const email = z.string().trim().toLowerCase().email().max(120);
const code6 = z.string().trim().regex(/^\d{6}$/, 'must be 6 digits');
const name = z.string().trim().min(2).max(80).regex(/^[\p{L} .'-]+$/u, 'letters, spaces and dots only');
const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'invalid id');

const identifier = z.string().trim().min(3).transform((v, ctx) => {
  if (v.includes('@')) {
    const r = email.safeParse(v);
    if (!r.success) { ctx.addIssue({ code: 'custom', message: 'Invalid email' }); return z.NEVER; }
    return { email: r.data };
  }
  const r = phone.safeParse(v);
  if (!r.success) { ctx.addIssue({ code: 'custom', message: 'Enter an email or a mobile number' }); return z.NEVER; }
  return { phone: r.data };
});

const register = z.object({
  role: z.enum(['buyer', 'lister']),
  listerType: z.enum(['owner', 'builder', 'landlord']).optional(),
  name,
  email,
  phone,
  password,
  confirmPassword: z.string(),
  referralCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/, '4-20 letters or digits').optional().or(z.literal('').transform(() => undefined)),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms and privacy notice' }) }),
  noBrokerDeclaration: z.boolean().optional(), // "I am not a broker" tick for listers
  marketingOptIn: z.boolean().default(false),
  companyName: z.string().trim().min(2).max(120).optional(), // builders
}).superRefine((d, ctx) => {
  if (d.password !== d.confirmPassword) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
  if (d.role === 'lister' && !d.listerType) ctx.addIssue({ code: 'custom', path: ['listerType'], message: 'Choose owner, builder or landlord' });
  if (d.role === 'lister' && d.noBrokerDeclaration !== true) ctx.addIssue({ code: 'custom', path: ['noBrokerDeclaration'], message: 'Brokers and agents cannot register as listers' });
  if (d.listerType === 'builder' && !d.companyName) ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Company name is required for builders' });
  if (d.password.toLowerCase().includes(d.email.split('@')[0]) || d.password.includes(d.phone.slice(-10))) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'Password must not contain your email or phone' });
  }
});

module.exports = {
  password, phone, email, code6, name, identifier, objectId,
  register,
  verifyContact: z.object({ verificationToken: z.string().min(10), channel: z.enum(['email', 'sms']), code: code6 }),
  resendOtp: z.object({
    verificationToken: z.string().min(10).optional(),
    challengeToken: z.string().min(10).optional(),
    channel: z.enum(['email', 'sms']),
  }).refine((d) => d.verificationToken || d.challengeToken, 'verificationToken or challengeToken is required'),
  login: z.object({ identifier, password: z.string().min(1).max(64), channel: z.enum(['email', 'sms', 'totp']).optional() }),
  verify2fa: z.object({
    challengeToken: z.string().min(10),
    code: z.string().trim().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i).optional(),
  }).refine((d) => d.code || d.recoveryCode, 'code or recoveryCode is required'),
  refresh: z.object({ refreshToken: z.string().min(20) }),
  forgot: z.object({ identifier }),
  reset: z.object({ identifier, code: code6, newPassword: password }),
  totpEnable: z.object({ code: code6 }),
  totpDisable: z.object({ code: code6 }),
  updateMe: z.object({
    name: name.optional(),
    avatarFileId: objectId.optional(),
    locale: z.enum(['en', 'hi']).optional(),
    billing: z.object({ name: z.string().max(120), gstin: z.string().regex(/^[0-9A-Z]{15}$/).optional().or(z.literal('')), address: z.string().max(300), state: z.string().max(60) }).partial().optional(),
  }).strict(),
  changePassword: z.object({ currentPassword: z.string().min(1), newPassword: password }),
  becomeLister: z.object({ listerType: z.enum(['owner', 'builder', 'landlord']), noBrokerDeclaration: z.literal(true), companyName: z.string().trim().min(2).max(120).optional() })
    .refine((d) => d.listerType !== 'builder' || d.companyName, { path: ['companyName'], message: 'Company name is required for builders' }),
  deletionRequest: z.object({ reason: z.string().trim().max(500).optional() }),
  staffCreate: z.object({
    role: z.enum(['agent', 'manager', 'admin']),
    name,
    email,
    phone,
    teamId: objectId.optional(),
    permissions: z.array(z.string()).max(40).default([]),
  }),
  staffEdit: z.object({ name: name.optional(), role: z.enum(['agent', 'manager', 'admin']).optional(), teamId: objectId.nullable().optional(), permissions: z.array(z.string()).max(40).optional() }).strict(),
  staffDisable: z.object({ reason: z.string().trim().min(3).max(300), reassignTo: objectId.optional() }),
};
