// Final fix round (docs/audit/v2/realestate.md): trust badges carry a code the
// web app translates (English label kept for API consumers), server-written
// text uses dd/mm/yyyy (IST) and the rupee sign, and the settings label has no
// milestone jargon. Pure unit tests: no database.
require('../env');
const { badges, listerBadge } = require('../../src/modules/masking/serializer');
const fmt = require('../../src/core/format');
const DEFAULTS = require('../../src/modules/notifications/templates');
const SETTINGS = require('../../src/constants/settings.defaults');

describe('[B][public] trust badges by code (N1)', () => {
  const p = {
    liveAt: new Date('2026-10-05T06:00:00Z'),
    verification: { photo: { status: 'verified', verifiedAt: new Date('2026-10-06T06:00:00Z') }, site: { status: 'verified', verifiedAt: new Date('2026-10-07T06:00:00Z') } },
    rera: { numbers: ['P52100012345'] },
  };
  const builder = { listerType: 'builder', kyc: { status: 'verified' }, brand: { approved: true, name: 'Skyline Homes' } };

  test('each badge has a labelCode; the English label and the brand stay as data', () => {
    const out = badges(p, builder);
    expect(out.map((b) => [b.code, b.labelCode])).toEqual([
      ['verified_lister', 'verified_builder'], ['photo_verified', 'photo_verified'], ['site_verified', 'site_verified'], ['rera', 'rera'],
    ]);
    expect(out[0]).toMatchObject({ label: 'Verified Builder · Skyline Homes', brand: 'Skyline Homes' });
    expect(out[1].label).toBe('Photo verified');
    expect(out[3]).toMatchObject({ label: 'RERA registered', reraNumbers: ['P52100012345'] });
    expect(listerBadge(builder)).toBe('Verified Builder · Skyline Homes');
  });

  test('owner, landlord and an unknown lister type', () => {
    expect(badges(p, { listerType: 'owner', kyc: { status: 'verified' } })[0]).toMatchObject({ labelCode: 'verified_owner', label: 'Verified Owner' });
    expect(badges(p, { listerType: 'landlord', kyc: { status: 'verified' } })[0].labelCode).toBe('verified_landlord');
    expect(badges(p, { kyc: { status: 'verified' } })[0].labelCode).toBe('verified_lister');
    expect(badges(p, { listerType: 'builder', kyc: { status: 'verified' }, brand: { approved: false, name: 'X' } })[0].brand).toBeUndefined();
  });

  test('tooltips use dd/mm/yyyy', () => {
    const out = badges(p, builder);
    expect(out[0].tooltip).toContain('05/10/2026');
    expect(out[1].tooltip).toContain('06/10/2026');
  });
});

describe('[K] server-written formats (N7)', () => {
  test('dd/mm/yyyy and h:mm am/pm in IST; Indian grouping for rupees', () => {
    const d = new Date('2026-10-24T11:00:00Z'); // 16:30 IST
    expect(fmt.istDate(d)).toBe('24/10/2026');
    expect(fmt.istDateTime(d)).toBe('24/10/2026, 4:30 pm');
    expect(fmt.istDate(new Date('2026-10-24T20:00:00Z'))).toBe('25/10/2026'); // after midnight IST
    expect(fmt.rupeeText(331934)).toBe('₹3,31,934');
    expect(fmt.paiseNumber(33193450)).toBe('3,31,934.50');
    expect(fmt.istDate(null)).toBe('');
  });

  test('in-app and email finance texts show ₹; the registered SMS text is unchanged', () => {
    expect(DEFAULTS['invoice.issued'].in_app.body).toBe('₹{{total}} due {{dueDate}}');
    expect(DEFAULTS['payment.confirmed'].email.subject).toBe('Payment of ₹{{amount}} received');
    expect(DEFAULTS['invoice.reminder'].sms.body).toContain('INR {{outstanding}}');
    const all = JSON.stringify(Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { in_app: v.in_app, email: v.email }])));
    expect(all).not.toMatch(/INR \{\{/);
  });
});

describe('[L][admin] settings wording (N13)', () => {
  test('i18n.languages is "Interface languages"', () => {
    expect(SETTINGS['i18n.languages'].description).toBe('Interface languages');
    expect(JSON.stringify(SETTINGS)).not.toMatch(/delivered in M\d/);
  });
});
