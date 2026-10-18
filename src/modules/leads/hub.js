// Central Growth Hub lead sync (mlm-engine docs/INTEGRATION_CONTRACT.md v1, section 6).
// New enquiries are recorded as `lead.created` outbox events and stage changes as
// `lead.updated`; the outbox job delivers them signed, like the MLM events. Deal
// conversions need no extra event: the hub converts the open lead on `deal.closed`.
// Privacy (contract 6.5): only the enquirer's own details, never the lister's.
// Recorded only while the hub integration is switched on (setting mlm.enabled).
const env = require('../../config/env');
const settings = require('../../core/settings');
const outbox = require('../../core/outbox');
const logger = require('../../core/logger');

const paise = (rupees) => (rupees == null ? undefined : Math.round(Number(rupees) * 100));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
const TYPE = { apartment: 'apartment', villa: 'villa', independent_house: 'villa', residential_plot: 'plot', commercial_plot: 'plot', agricultural_land: 'plot', office: 'office', shop: 'shop', showroom: 'shop' };

// Contract 6.1 kinds for Real Estate.
function kindOf(lead) {
  const src = lead.sources || [];
  if (src.includes('requirement')) return 'requirement';
  if (src.includes('site_visit')) return 'site_visit_request';
  if (src.includes('callback') || src.includes('contact_form')) return 'callback';
  return lead.projectId ? 'project_enquiry' : 'property_enquiry';
}

function requirementOf(lead, target) {
  const r = lead.requirement || {};
  return clean({
    purpose: r.purpose === 'rent' ? 'rent' : r.purpose ? 'buy' : undefined,
    propertyType: TYPE[(target && target.type) || (r.types && r.types[0])] || undefined,
    bhk: Array.isArray(r.bhk) ? r.bhk[0] : r.bhk,
    budgetMin: paise(r.budgetMin),
    budgetMax: paise(r.budgetMax),
    localities: (r.localities || []).slice(0, 10),
  });
}

// target: the live Property or Project the enquiry is about (null for requirement / contact form).
function subjectOf(lead, target) {
  if (!target) return clean({ type: 'general', city: lead.requirement && lead.requirement.city });
  const loc = target.location || {};
  if (target.listingNo) {
    return clean({ type: 'property', id: target.listingNo, title: String(target.title || '').slice(0, 120), url: `${env.CLIENT_URL}/property/${target.slug || target._id}`, city: loc.city, locality: loc.locality });
  }
  return clean({ type: 'project', id: target.projectNo, title: String(target.name || '').slice(0, 120), url: `${env.CLIENT_URL}/projects/${target.slug}`, city: loc.city, locality: loc.locality });
}

async function enabled() {
  try { return Boolean(await settings.get('mlm.enabled')); } catch { return false; }
}

// Never breaks lead capture: a failure is logged and the enquiry goes on.
async function created(lead, target = null, { whatsapp, utm } = {}) {
  try {
    if (!(await enabled())) return null;
    const b = lead.buyer || {};
    const u = utm || lead.utm || {};
    return await outbox.record('lead.created', clean({
      externalLeadId: lead.leadNo,
      kind: kindOf(lead),
      contact: clean({ name: b.name, phone: b.phone, email: b.email }),
      consent: clean({ contact: true, whatsapp: whatsapp ?? lead.whatsappOptIn, capturedAt: (lead.consentAt || new Date()).toISOString() }),
      source: clean({ channel: (lead.sources || []).includes('whatsapp') ? 'whatsapp' : 'web', campaign: u.campaign, utm: Object.keys(u).length ? clean({ source: u.source, medium: u.medium, campaign: u.campaign, term: u.term, content: u.content }) : undefined }),
      refCode: lead.referralCode,
      externalUserId: b.userId ? `u_${b.userId}` : undefined,
      subject: subjectOf(lead, target),
      requirement: requirementOf(lead, target),
      message: lead.requirement && lead.requirement.notes ? String(lead.requirement.notes).slice(0, 1000) : undefined,
      createdAt: (lead.createdAt || new Date()).toISOString(),
    }), { aggregateId: lead._id, schemaVersion: '1' });
  } catch (err) {
    logger.warn({ err, leadNo: lead.leadNo }, 'Hub lead.created not recorded');
    return null;
  }
}

async function updated(lead, fields) {
  try {
    if (!(await enabled())) return null;
    return await outbox.record('lead.updated', clean({ externalLeadId: lead.leadNo, ...fields }), { aggregateId: lead._id, schemaVersion: '1' });
  } catch (err) {
    logger.warn({ err, leadNo: lead.leadNo }, 'Hub lead.updated not recorded');
    return null;
  }
}

module.exports = { created, updated, kindOf, subjectOf, requirementOf };
