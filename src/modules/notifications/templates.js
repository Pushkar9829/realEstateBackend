// Default notification templates per event and channel (admin can override
// any of them). Placeholders use {{name}}. `urgent` SMS bypass quiet hours.
// Later phases add listing, lead, visit, offer, deal and invoice events here.
module.exports = {
  'auth.otp': {
    category: 'account', transactional: true,
    email: { subject: '{{siteName}} verification code', body: 'Your {{purposeLabel}} code is {{code}}. It is valid for {{expiryMin}} minutes. Do not share it with anyone.' },
    sms: { body: '{{code}} is your {{siteName}} {{purposeLabel}} code. Valid {{expiryMin}} min. Do not share it.', urgent: true },
  },
  'auth.welcome': {
    category: 'account', transactional: true,
    email: { subject: 'Welcome to {{siteName}}', body: 'Hello {{name}}, your account is ready. {{roleNote}}' },
    in_app: { title: 'Welcome to {{siteName}}', body: '{{roleNote}}', link: '{{home}}' },
  },
  'auth.locked': {
    category: 'account', transactional: true,
    email: { subject: 'Your {{siteName}} account is locked', body: 'Too many failed sign-in attempts. Your account is locked until {{until}}. Reset your password to unlock it now.' },
  },
  'auth.password_changed': {
    category: 'account', transactional: true,
    email: { subject: 'Your {{siteName}} password was changed', body: 'Your password was changed on {{time}}. Other sessions were signed out. If this was not you, contact support immediately.' },
    in_app: { title: 'Password changed', body: 'Your password was changed on {{time}}', link: '/account?tab=security' },
  },
  'auth.2fa_changed': {
    category: 'account', transactional: true,
    email: { subject: 'Two-factor method changed', body: 'Your sign-in verification method changed from {{oldMethod}} to {{newMethod}} on {{time}}.' },
  },
  'auth.disabled': {
    category: 'account', transactional: true,
    email: { subject: 'Your {{siteName}} account was disabled', body: 'Your account has been disabled. Reason: {{reason}}. Contact support if you think this is a mistake.' },
  },
  'staff.created': {
    category: 'account', transactional: true,
    email: { subject: 'Your {{siteName}} staff account', body: 'Hello {{name}}, an account was created for you as {{role}}. Sign in at {{link}} with this temporary password: {{tempPassword}} . You must change it and confirm two-factor sign-in on first login.' },
  },
  'staff.2fa_reset': {
    category: 'account', transactional: true,
    email: { subject: 'Your two-factor sign-in was reset', body: 'An administrator reset your two-factor sign-in on {{time}}. You will be asked to set it up again at your next login.' },
  },
  'privacy.export_ready': {
    category: 'account', transactional: true,
    email: { subject: 'Your {{siteName}} data download is ready', body: 'Your data export is ready and can be downloaded from your account for 24 hours.' },
    in_app: { title: 'Your data download is ready', body: 'Available for 24 hours', link: '/account?tab=privacy' },
  },
  'privacy.deletion_received': {
    category: 'account', transactional: true,
    email: { subject: 'We received your deletion request', body: 'We received your request to delete your account on {{time}}. We will process it within 30 days. Records we must keep by law (deals, invoices) are retained.' },
  },
  'test.message': {
    category: 'account', transactional: true,
    email: { subject: 'Test notification from {{siteName}}', body: 'This is a test message sent at {{time}}.' },
    sms: { body: '{{siteName}} test message at {{time}}', urgent: true },
    in_app: { title: 'Test notification', body: 'Sent at {{time}}' },
  },

  // ---------------- Phase 2: KYC, broker flags, listings, agreements, projects
  'kyc.submitted': { category: 'account', transactional: true, in_app: { title: 'New KYC to review', body: '{{name}} ({{listerType}}) submitted KYC', link: '/admin/kyc/{{userId}}' } },
  'kyc.verified': {
    category: 'account', transactional: true,
    email: { subject: 'You are verified on {{siteName}}', body: 'Your KYC is verified. Your listings can now be approved and go live.' },
    sms: { body: '{{siteName}}: your KYC is verified. You can now list properties.' },
    in_app: { title: 'KYC verified', body: 'Your listings can now go live', link: '/lister' },
  },
  'kyc.resubmission_required': {
    category: 'account', transactional: true,
    email: { subject: 'Please update your KYC', body: 'Our team needs changes to your KYC: {{comment}}' },
    in_app: { title: 'KYC needs changes', body: '{{comment}}', link: '/lister/verification' },
  },
  'kyc.rejected': {
    category: 'account', transactional: true,
    email: { subject: 'Your KYC was not approved', body: 'Your KYC was rejected. Reason: {{reason}}' },
    in_app: { title: 'KYC rejected', body: '{{reason}}', link: '/lister/verification' },
  },
  'broker.flag_raised': {
    category: 'account', transactional: true,
    email: { subject: 'Broker flag {{flagNo}}: rule {{rule}}', body: 'Lister {{listerName}} matched rule {{rule}}. Review the flag in the admin panel.' },
    in_app: { title: 'Broker flag {{flagNo}}', body: '{{listerName}} matched rule {{rule}}', link: '/admin/trust' },
  },
  'broker.warning': { category: 'account', transactional: true, email: { subject: 'Policy warning from {{siteName}}', body: 'Our review found activity that does not match our no-broker policy: {{note}}. Repeated issues lead to suspension.' } },
  'lister.suspended': {
    category: 'account', transactional: true,
    email: { subject: 'Your lister account is suspended', body: 'Your lister account and listings are suspended. Reason: {{reason}}. Contact support.' },
    in_app: { title: 'Account suspended', body: '{{reason}}', link: '/lister' },
  },
  'lister.banned': { category: 'account', transactional: true, email: { subject: 'Your lister account is closed', body: 'Your lister account was closed for violating our no-broker policy. Reason: {{reason}}.' } },
  'lister.reinstated': { category: 'account', transactional: true, email: { subject: 'Your lister account is active again', body: 'Your lister account was reinstated.' }, in_app: { title: 'Account reinstated', body: 'Your listings are live again', link: '/lister' } },
  'listing.submitted': {
    category: 'listings', transactional: true,
    email: { subject: 'Listing {{listingNo}} submitted', body: 'Your listing {{listingNo}} was submitted and will be reviewed within {{slaHours}} hours.' },
    in_app: { title: 'Listing submitted', body: '{{listingNo}} is under review', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.review_queued': { category: 'listings', transactional: true, in_app: { title: 'New listing to review', body: '{{listingNo}} {{title}}', link: '/admin/approvals/{{propertyId}}' } },
  'listing.approved': {
    category: 'listings', transactional: true,
    email: { subject: 'Your listing {{listingNo}} is live', body: 'Good news! {{title}} is now live until {{expiresAt}}.' },
    sms: { body: '{{siteName}}: your listing {{listingNo}} is live.' },
    in_app: { title: 'Listing live', body: '{{listingNo}} is live', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.changes_requested': {
    category: 'listings', transactional: true,
    email: { subject: 'Changes needed for {{listingNo}}', body: 'Our team requested changes: {{summary}}' },
    in_app: { title: 'Changes requested', body: '{{listingNo}}: {{summary}}', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.rejected': {
    category: 'listings', transactional: true,
    email: { subject: 'Listing {{listingNo}} was not approved', body: 'Reason: {{reason}}' },
    in_app: { title: 'Listing rejected', body: '{{reason}}', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.availability_check': {
    category: 'listings', transactional: true,
    email: { subject: 'Is {{listingNo}} still available?', body: 'Please confirm {{title}} is still available. Answer here: {{link}} (Yes / Sold elsewhere / Pause). Reply by {{dueBy}}.' },
    sms: { body: '{{siteName}}: is {{listingNo}} still available? Reply by {{dueBy}}: {{link}}' },
    in_app: { title: 'Is {{listingNo}} still available?', body: 'Reply by {{dueBy}} or it will be paused', link: '/lister/listings/{{propertyId}}' },
    whatsapp: {
      body: 'Is your listing {{listingNo}} ({{title}}) still available? Tap a reply by {{dueBy}} or it will be paused.', name: 'listing_availability_check', params: ['listingNo', 'title', 'dueBy'],
      buttons: [{ title: 'Yes, available', payload: 'check:{{checkToken}}:available' }, { title: 'Sold elsewhere', payload: 'check:{{checkToken}}:sold' }, { title: 'Pause', payload: 'check:{{checkToken}}:pause' }],
    },
  },
  'listing.availability_reminder': {
    category: 'listings', transactional: true,
    sms: { body: '{{siteName}}: please confirm {{listingNo}} by {{dueBy}} or it will be paused: {{link}}' },
    in_app: { title: 'Reminder: confirm {{listingNo}}', body: 'Reply by {{dueBy}} or the listing will be paused', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.auto_paused': {
    category: 'listings', transactional: true,
    email: { subject: '{{listingNo}} is paused', body: 'We did not hear back, so {{listingNo}} is paused and hidden from search. Resume any time: {{link}}' },
    sms: { body: '{{siteName}}: {{listingNo}} is paused as we did not hear back. Resume: {{link}}' },
    in_app: { title: '{{listingNo}} paused', body: 'Resume it any time', link: '/lister/listings/{{propertyId}}' },
  },
  'listing.expiring': { category: 'listings', transactional: true, email: { subject: '{{listingNo}} expires in {{days}} days', body: 'Renew {{title}} to keep it live.' }, in_app: { title: '{{listingNo}} expires soon', body: 'Renew to keep it live', link: '/lister/listings/{{propertyId}}' } },
  'listing.expired': { category: 'listings', transactional: true, email: { subject: '{{listingNo}} has expired', body: 'Renew {{title}} within 30 days to restore it without a new review.' }, in_app: { title: '{{listingNo}} expired', body: 'Renew to restore it', link: '/lister/listings/{{propertyId}}' } },
  'listing.sold_outside': {
    category: 'listings', transactional: true,
    email: { subject: 'Sold elsewhere: {{listingNo}} ({{checkNo}})', body: 'The lister reported {{listingNo}} as sold or rented outside the platform on {{saleDate}}. Priority: {{priority}}.' },
    in_app: { title: 'Sold elsewhere {{checkNo}}', body: '{{listingNo}} - priority: {{priority}}', link: '/admin/receivables' },
  },
  'agreement.accepted': { category: 'listings', transactional: true, email: { subject: 'Your commission agreement {{agreementNo}}', body: 'You accepted {{commissionPercent}}% for {{propertyRef}} on {{acceptedAt}}. A copy is in your panel under Agreements.' } },
  'agreement.countersigned': { category: 'listings', transactional: true, email: { subject: 'Signed agreement {{agreementNo}} available', body: 'The countersigned copy of {{agreementNo}} is available in your panel.' }, in_app: { title: 'Signed agreement available', body: '{{agreementNo}}', link: '/lister/agreements/{{agreementId}}' } },
  'agreement.new_version_requested': { category: 'listings', transactional: true, email: { subject: 'Please review new agreement terms', body: 'Please review and accept the updated commission terms for {{propertyRef}}. {{note}}' }, in_app: { title: 'New agreement terms', body: '{{propertyRef}}', link: '/lister/agreements' } },
  'agreement.terminated': { category: 'listings', transactional: true, email: { subject: 'Agreement {{agreementNo}} terminated', body: 'Agreement {{agreementNo}} was terminated. Reason: {{reason}}. The linked listing is now inactive.' }, in_app: { title: 'Agreement terminated', body: '{{agreementNo}}', link: '/lister/agreements/{{agreementId}}' } },
  'project.submitted': { category: 'listings', transactional: true, in_app: { title: 'Project submitted', body: '{{projectNo}} is under review', link: '/lister/projects/{{projectId}}' } },
  'project.review_queued': { category: 'listings', transactional: true, in_app: { title: 'New project to review', body: '{{projectNo}} {{name}}', link: '/admin/projects/{{projectId}}' } },
  'project.decided': { category: 'listings', transactional: true, email: { subject: 'Project {{projectNo}}: {{decision}}', body: '{{note}}' }, in_app: { title: 'Project {{decision}}', body: '{{projectNo}} {{note}}', link: '/lister/projects/{{projectId}}' } },
};

// Portal, lead, visit and offer events (phases 3-4).
Object.assign(module.exports, require('./templates.portal'));
Object.assign(module.exports, require('./templates.finance'));
Object.assign(module.exports, require('./templates.supply'));
Object.assign(module.exports, require('./templates.account'));
