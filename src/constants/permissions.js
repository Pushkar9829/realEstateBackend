// Admin / manager permission catalogue (spec section 2). Generated from docs/SPEC.md.
// A super admin holds every key. Managers receive MANAGER_DEFAULTS, scoped to their teams.
const PERMISSIONS = Object.freeze({
  'dashboard.view': "dashboard.view",
  'listers.verify': "review and decide KYC",
  'listers.manage': "suspend, ban, reinstate listers; handle broker flags",
  'properties.approve': "approve, reject, request changes",
  'properties.manage': "feature, expire, extend, pause, deactivate any listing; handle reported listings and sold-elsewhere checks",
  'verification.review': "QA review of photo verification sessions; grant or remove badges",
  'verification.schedule': "schedule and assign site verification visits (Could)",
  'verification.field': "granted to in-house sales agents who do site verification visits: see own assigned visits, upload photos and checklist (Could)",
  'partners.manage': "partner banks and service partners, referral and service request status (Could)",
  'projects.approve': "moderate builder projects",
  'agreements.manage': "view registry, upload signed PDFs, terminate",
  'agreements.view': "agreements.view",
  'leads.view_all': "all leads (manager: own teams only)",
  'leads.assign': "assign, reassign, bulk assign, reopen",
  'leads.export': "CSV export of leads (contacts included only with `contacts.view`)",
  'contacts.view': "see buyer and lister phone/email",
  'routing.manage': "routing rules",
  'teams.manage': "teams, territories, capacities",
  'staff.manage': "create agents, managers and admin staff; reset 2FA",
  'sitevisits.view': "sitevisits.view",
  'deals.verify': "verify, return, reject, reverse deals",
  'receivables.manage': "receivables, payments, disputes, write-offs",
  'invoices.issue': "create and send invoices",
  'users.manage': "buyers list, block/unblock; seeker behaviour flags (throttle, block)",
  'masters.manage': "cities, localities, amenities, types, reasons",
  'cms.manage': "pages, banners, FAQs, home sections",
  'templates.manage': "notification templates",
  'settings.manage': "platform settings",
  'reports.view': "reports.view",
  'logs.view': "audit logs, login history",
  'integrations.manage': "jobs and MLM outbox monitor, retries",
});

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);
const MANAGER_DEFAULTS = ['dashboard.view', 'agreements.view', 'leads.view_all', 'leads.assign', 'sitevisits.view', 'reports.view'];

module.exports = { PERMISSIONS, ALL_PERMISSIONS, MANAGER_DEFAULTS };
