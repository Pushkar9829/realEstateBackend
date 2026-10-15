// Core building blocks and the spec-generated constants.
const mongoose = require('mongoose');
const { setup } = require('./helpers');
const { encrypt, decrypt } = require('../src/core/security/crypto');
const { allocate, percentOf, toPaise } = require('../src/core/money');
const { STATUS, canTransition, assertTransition } = require('../src/constants/status');
const { ALL_PERMISSIONS, MANAGER_DEFAULTS } = require('../src/constants/permissions');
const jobs = require('../src/core/jobs');
const outbox = require('../src/core/outbox');
const counters = require('../src/core/counters');
const settings = require('../src/core/settings');

beforeAll(() => setup());
afterAll(() => mongoose.disconnect());

test('field encryption round-trips', () => {
  expect(decrypt(encrypt('ABCDE1234F'))).toBe('ABCDE1234F');
});

test('money helpers keep paise exact (commission = % of price)', () => {
  expect(toPaise(7500000)).toBe(750000000); // Rs 75 lakh
  expect(percentOf(750000000, 1.5)).toBe(11250000); // 1.5% = Rs 1,12,500
  expect(allocate(1000, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(1000);
});

test('status machines generated from the spec allow only spec transitions', () => {
  expect(Object.keys(STATUS)).toEqual(expect.arrayContaining(['listing', 'leadStage', 'siteVisit', 'offer', 'agreement', 'listerKyc', 'project', 'deal', 'commissionReceivable', 'account']));
  expect(canTransition('listing', 'live', 'paused')).toBe(true); // RE-A-18
  expect(canTransition('listing', 'paused', 'live')).toBe(true);
  expect(canTransition('listing', 'draft', 'live')).toBe(false); // must pass approval
  expect(canTransition('deal', 'under_review', 'verified')).toBe(true);
  expect(canTransition('deal', 'draft', 'verified')).toBe(false);
  expect(() => assertTransition('leadStage', 'new', 'closed_won')).toThrow(/Cannot move leadStage/);
});

test('permission catalogue and manager defaults come from the spec', () => {
  expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(['properties.approve', 'deals.verify', 'contacts.view', 'verification.field']));
  expect(MANAGER_DEFAULTS).toEqual(expect.arrayContaining(['leads.assign', 'reports.view']));
});

test('settings defaults include the adopted decisions', async () => {
  expect(await settings.get('agreement.nonCircumventionMonths')).toBe(6);
  expect(await settings.get('invoice.eInvoicingEnabled')).toBe(false);
  expect(await settings.get('rera.numberPatterns')).toEqual({ Maharashtra: '^P[0-9]{11}$' });
});

test('job queue runs handlers and retries failures', async () => {
  const seen = [];
  jobs.register('test.ok', async (p) => { seen.push(p.n); });
  jobs.register('test.fail', async () => { throw new Error('boom'); });
  await jobs.enqueue('test.ok', { n: 1 });
  const failing = await jobs.enqueue('test.fail', {}, { maxAttempts: 2 });
  await jobs.tick();
  expect(seen).toEqual([1]);
  expect((await jobs.Job.findById(failing._id)).status).toBe('queued');
});

test('outbox records deal events for the realestate platform', async () => {
  const doc = await outbox.record('deal.closed', { referralCode: null, amount: 100 });
  await outbox.dispatchDue({ enabled: true, sendUnreferred: false });
  expect((await outbox.Outbox.findById(doc._id)).status).toBe('skipped_unreferred');
});

test('counters: readable numbers and gapless invoice numbers per financial year', async () => {
  expect(await counters.leadNo()).toMatch(/^LD\d{2}-\d{6}$/);
  const a = await counters.invoiceNo();
  const b = await counters.invoiceNo();
  expect(a).toMatch(/^RE\/INV\/\d{4}-\d{2}\/\d{5}$/);
  expect(Number(b.slice(-5))).toBe(Number(a.slice(-5)) + 1);
  expect(counters.financialYear(new Date('2027-02-10'))).toBe('2026-27');
  expect(counters.financialYear(new Date('2027-04-01'))).toBe('2027-28');
});
