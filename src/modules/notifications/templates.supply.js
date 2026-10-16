// Notification templates added in the spec-gap pass (supply). Merged in templates.js.
module.exports = {
  // ---- A4 step 4 / RE-A-15 / RE-A-18: agents on open leads hear about listing changes
  'listing.paused': { category: 'leads', transactional: true, in_app: { title: '{{listingNo}} is paused', body: '{{title}} is hidden from search ({{reason}}). {{leadCount}} open lead(s) stay with you.', link: '/agent/leads/{{leadId}}' } },
  'listing.resumed': { category: 'leads', transactional: true, in_app: { title: '{{listingNo}} is live again', body: '{{title}} is back in search. {{leadCount}} open lead(s) on it.', link: '/agent/leads/{{leadId}}' } },
  'listing.deactivated': { category: 'leads', transactional: true, in_app: { title: '{{listingNo}} is no longer available', body: '{{title}}: {{reason}}. Update your {{leadCount}} open lead(s).', link: '/agent/leads/{{leadId}}' } },

  // ---- RE-B-02 builder brand
  'brand.submitted': { category: 'account', transactional: true, in_app: { title: 'Brand change to review', body: '{{name}} asked for the brand "{{brand}}"', link: '/admin/listers/{{userId}}' } },
  'brand.decided': {
    category: 'account', transactional: true,
    email: { subject: 'Your brand "{{brand}}" was {{decision}}', body: 'Your builder brand "{{brand}}" was {{decision}}. {{note}}' },
    in_app: { title: 'Brand {{decision}}', body: '"{{brand}}" {{note}}', link: '/lister/verification' },
  },

  // ---- G inventory
  'project.unit_sold': { category: 'listings', transactional: true, in_app: { title: '{{projectNo}}: unit sold', body: 'Configuration {{configName}}: available units now {{available}}', link: '/lister/projects/{{projectId}}' } },

  // ---- RE-G-08 step 5 / RE-L-10 RERA validity
  'project.rera_expiring': {
    category: 'listings', transactional: true,
    email: { subject: 'RERA validity for {{projectNo}} {{when}}', body: 'RERA registration {{number}} ({{state}}) for {{name}} {{when}}. Upload the extension certificate to keep the project and its listings live.' },
    in_app: { title: 'RERA validity {{when}}', body: '{{projectNo}} {{name}}: registration {{number}}', link: '{{link}}' },
  },
  'rera.agent_registration_expiring': {
    category: 'account', transactional: true,
    email: { subject: 'Platform RERA registration for {{state}} ends on {{date}}', body: 'The platform RERA agent registration {{number}} for {{state}} ends on {{date}} ({{days}} days). Renew it and update the settings.' },
    in_app: { title: 'RERA registration for {{state}} ends on {{date}}', body: 'Agent registration {{number}}: {{days}} days left', link: '/admin/settings' },
  },
};
