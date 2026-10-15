// In-process domain event bus. Modules publish facts ("deal.verified")
// and other modules react (ledger, notifications, MLM outbox) without
// importing each other. Handlers must be quick and idempotent. Anything that
// must survive a crash is enqueued as a job (core/jobs) inside the handler.
const { EventEmitter } = require('events');
const logger = require('./logger');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function on(event, handler) {
  bus.on(event, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      logger.error({ err, event }, 'Domain event handler failed');
    }
  });
}

const emit = (event, payload) => bus.emit(event, payload);

// Canonical event names, so producers and consumers cannot drift apart.
const EVENTS = Object.freeze({
  USER_REGISTERED: 'user.registered',
  LISTER_KYC_DECIDED: 'lister.kyc.decided',
  LISTING_STATUS_CHANGED: 'listing.status_changed',
  PROJECT_STATUS_CHANGED: 'project.status_changed',
  LEAD_CREATED: 'lead.created',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  SITE_VISIT_CHANGED: 'site_visit.changed',
  OFFER_CHANGED: 'offer.changed',
  DEAL_STATUS_CHANGED: 'deal.status_changed',
  DEAL_VERIFIED: 'deal.verified',
  DEAL_REVERSED: 'deal.reversed',
  INVOICE_ISSUED: 'invoice.issued',
  PAYMENT_CONFIRMED: 'payment.confirmed',
});

module.exports = { on, emit, EVENTS };
