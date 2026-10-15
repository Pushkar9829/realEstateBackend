// Module A listing wizard schemas, one per step (spec 4.1 business rules).
// Steps: 1 basic, 2 location, 3 details, 4 price, 5 amenities, 6 media meta
// (video link, RERA), 7 commission (own endpoint), 8 review + submit.
const { z } = require('zod');

const oid = z.string().regex(/^[a-f0-9]{24}$/, 'invalid id');
const AREA_UNITS = ['sqft', 'sqm', 'sqyd', 'acre', 'hectare', 'bigha'];
const TO_SQFT = { sqft: 1, sqm: 10.7639, sqyd: 9, acre: 43560, hectare: 107639, bigha: 27000 };

const rera = z.object({
  numbers: z.array(z.string().trim().toUpperCase().min(5).max(40)).max(10).default([]),
  state: z.string().trim().max(60).optional(),
  url: z.string().trim().url().optional(),
  certificateFileId: oid.optional(),
  exempt: z.object({
    reason: z.enum(['plot_upto_500sqm', 'upto_8_units']),
    plotAreaSqm: z.number().positive(),
    units: z.number().int().positive(),
    docFileId: oid, // sanctioned plan (private)
  }).optional(),
}).superRefine((r, ctx) => {
  // Section 3(2): plot up to 500 sq m OR up to 8 units (all phases). Anything bigger is not exempt.
  if (r.exempt && r.exempt.plotAreaSqm > 500 && r.exempt.units > 8) {
    ctx.addIssue({ code: 'custom', path: ['exempt'], message: 'RERA exemption applies only to plots up to 500 sq m or projects up to 8 units' });
  }
});

const steps = {
  1: z.object({
    purpose: z.enum(['sale', 'rent']),
    category: z.enum(['residential', 'commercial', 'land']),
    type: z.string().trim().min(2).max(40),
    title: z.string().trim().min(10).max(100),
    description: z.string().trim().min(50).max(5000),
  }),
  2: z.object({
    cityId: oid,
    localityId: oid.optional(),
    localityRequest: z.string().trim().min(2).max(80).optional(), // not in the master yet -> admin decides
    societyName: z.string().trim().max(120).optional(),
    addressLine: z.string().trim().min(5).max(300),
    unitNo: z.string().trim().max(30).optional(),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/),
    lat: z.coerce.number().min(6).max(37),
    lng: z.coerce.number().min(68).max(98),
    landmarks: z.array(z.object({ type: z.string().max(40), name: z.string().trim().min(2).max(80), distanceKm: z.number().min(0).max(50).optional() })).max(10).default([]),
  }).refine((d) => d.localityId || d.localityRequest, { path: ['localityId'], message: 'Choose a locality or request a new one' }),
  3: z.object({
    bhk: z.number().int().min(0).max(20).optional(),
    baths: z.number().int().min(0).max(20).optional(),
    balconies: z.number().int().min(0).max(20).optional(),
    areas: z.object({
      carpet: z.number().positive().optional(), builtUp: z.number().positive().optional(),
      superBuiltUp: z.number().positive().optional(), plot: z.number().positive().optional(), unit: z.enum(AREA_UNITS).default('sqft'),
    }),
    floor: z.number().int().min(-3).max(200).optional(),
    totalFloors: z.number().int().min(0).max(200).optional(),
    furnishing: z.enum(['unfurnished', 'semi', 'full']).optional(),
    facing: z.string().max(20).optional(),
    ageYears: z.number().min(0).max(150).optional(),
    possession: z.object({ status: z.enum(['ready', 'under_construction']), date: z.coerce.date().optional() }).optional(),
    parking: z.object({ covered: z.number().int().min(0).max(50).default(0), open: z.number().int().min(0).max(50).default(0) }).optional(),
    extra: z.record(z.any()).optional(),
  }).superRefine((d, ctx) => {
    const a = d.areas;
    if (!a.carpet && !a.builtUp && !a.superBuiltUp && !a.plot) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'Give at least one area' });
    if (a.carpet && a.builtUp && a.carpet > a.builtUp) ctx.addIssue({ code: 'custom', path: ['areas', 'carpet'], message: 'Carpet area cannot exceed built-up area' });
    if (a.builtUp && a.superBuiltUp && a.builtUp > a.superBuiltUp) ctx.addIssue({ code: 'custom', path: ['areas', 'builtUp'], message: 'Built-up area cannot exceed super built-up area' });
    if (d.floor !== undefined && d.totalFloors !== undefined && d.floor > d.totalFloors) ctx.addIssue({ code: 'custom', path: ['floor'], message: 'Floor cannot be above the total floors' });
  }),
  // Prices arrive in rupees; the service stores paise.
  4: z.object({
    amount: z.number().positive().optional(),
    monthlyRent: z.number().positive().optional(),
    deposit: z.number().min(0).optional(),
    maintenance: z.number().min(0).optional(),
    negotiable: z.boolean().default(false),
    allInclusive: z.boolean().default(false),
  }),
  5: z.object({ amenities: z.array(z.string().max(40)).max(80) }),
  6: z.object({
    video: z.object({ kind: z.literal('youtube'), url: z.string().url().regex(/youtu(\.be|be\.com)/, 'Only YouTube links') }).nullable().optional(),
    rera: rera.optional(),
  }),
};

module.exports = {
  steps,
  rera,
  AREA_UNITS,
  TO_SQFT,
  media: z.object({
    kind: z.enum(['photo', 'floor_plan', 'brochure', 'video', 'ownership_proof']),
    fileId: oid,
    caption: z.string().trim().max(100).optional(),
    tag: z.string().trim().max(30).optional(),
    label: z.string().trim().max(60).optional(),
    docType: z.enum(['sale_deed', 'property_tax_receipt', 'utility_bill', 'allotment_letter', 'rera_certificate', 'sanctioned_plan', 'other']).optional(),
  }),
  mediaEdit: z.object({ caption: z.string().trim().max(100).optional(), tag: z.string().trim().max(30).optional(), label: z.string().trim().max(60).optional() }),
  mediaOrder: z.object({ photoIds: z.array(oid).min(1).max(20), coverId: oid.optional() }),
  commission: z.object({ percent: z.number().positive(), accept: z.literal(true), typedName: z.string().trim().min(2).max(120) }),
  deactivate: z.object({
    reason: z.enum(['sold_outside', 'rented_outside', 'no_longer_available', 'other']),
    note: z.string().trim().max(300).optional(),
    saleDate: z.coerce.date().optional(),
    price: z.number().positive().optional(),
  }).refine((d) => !['sold_outside', 'rented_outside'].includes(d.reason) || d.saleDate, { path: ['saleDate'], message: 'Sale or move-in date is required' }),
  pause: z.object({ reason: z.string().trim().min(3).max(200) }),
  checkAnswer: z.object({
    answer: z.enum(['available', 'sold_elsewhere', 'pause']),
    saleDate: z.coerce.date().optional(),
    price: z.number().positive().optional(),
    reason: z.string().trim().max(200).optional(),
  }).refine((d) => d.answer !== 'sold_elsewhere' || d.saleDate, { path: ['saleDate'], message: 'Sale or move-in date is required' }),
};
