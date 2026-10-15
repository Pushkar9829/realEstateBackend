// Status machines generated from the "<Name> state machine" tables in docs/SPEC.md.
// Services must change status through assertTransition so illegal moves are
// rejected in one place.
const ApiError = require('../core/http/ApiError');

const machine = (initial, transitions) => ({
  initial,
  values: [...new Set([...initial, ...Object.keys(transitions), ...Object.values(transitions).flat()])],
  transitions,
});

const STATUS = {
  listing: machine(["draft"], {
    draft: ["pending_approval"],
    pending_approval: ["draft", "live", "changes_requested", "rejected", "suspended"],
    live: ["sold","rented","expired","inactive","paused","suspended"],
    changes_requested: ["pending_approval"],
    rejected: [],
    sold: [],
    rented: ["pending_approval"],
    expired: ["live","pending_approval"],
    inactive: ["pending_approval"],
    paused: ["inactive","live","expired","sold","rented"],
    suspended: ["live", "paused", "pending_approval", "changes_requested", "expired", "inactive"], // hand-added: restore to the pre-suspension status
  }),
  leadStage: machine(["new"], {
    new: ["contacted","site_visit_scheduled"],
    contacted: ["qualified","site_visit_scheduled"],
    qualified: ["site_visit_scheduled"],
    site_visit_scheduled: ["site_visit_done","qualified"],
    site_visit_done: ["negotiation","booking"],
    negotiation: ["booking"],
    closed_lost: [],
    booking: ["negotiation","closed_won"],
    closed_won: ["negotiation"],
  }),
  siteVisit: machine(["requested","scheduled"], {
    requested: ["scheduled","cancelled","requested"], // hand fix: agent schedules a requested visit (spec C4)
    scheduled: ["confirmed","scheduled","cancelled","completed","no_show"],
    confirmed: ["scheduled","cancelled","completed","no_show"],
    cancelled: [],
    completed: ["completed"],
    no_show: [],
  }),
  offer: machine(["awaiting_lister"], {
    awaiting_lister: ["accepted","awaiting_buyer","declined","withdrawn","expired"],
    accepted: ["accepted"],
    awaiting_buyer: ["accepted","awaiting_lister","withdrawn","expired"],
    declined: [],
    withdrawn: [],
    expired: [],
  }),
  agreement: machine(["accepted"], {
    accepted: ["countersigned","superseded","terminated","void"],
    countersigned: ["superseded","terminated"],
    superseded: [],
    terminated: [],
    void: [],
  }),
  verificationVisit: machine(["requested"], {
    requested: ["scheduled","cancelled"],
    scheduled: ["scheduled","verified","not_verified","lister_absent","cancelled"],
    verified: [],
    not_verified: [],
    lister_absent: ["scheduled"], // hand fix: one reschedule after the lister was absent (D4 step 4)
    cancelled: [],
  }),
  listerKyc: machine([], {
    not_started: ["submitted"],
    submitted: ["under_review"],
    under_review: ["submitted","verified","resubmission_required","rejected"],
    verified: ["under_review","suspended","banned"],
    resubmission_required: ["submitted"],
    rejected: ["resubmission_required"],
    suspended: ["verified","banned"],
    banned: [],
  }),
  project: machine(["draft"], {
    draft: ["pending_approval"],
    pending_approval: ["live","changes_requested","rejected"],
    live: ["sold_out","inactive"],
    changes_requested: ["pending_approval"],
    rejected: [],
    sold_out: ["inactive","live"],
    inactive: ["pending_approval"],
  }),
  deal: machine(["draft"], {
    draft: ["submitted","cancelled"],
    submitted: ["under_review"],
    returned: ["cancelled","submitted"],
    cancelled: [],
    under_review: ["submitted","returned","rejected","verified"],
    rejected: [],
    verified: ["reversed"],
    reversed: [],
  }),
  commissionReceivable: machine(["pending_invoice"], {
    pending_invoice: ["invoiced","cancelled"],
    invoiced: ["partially_paid","paid","overdue","cancelled"],
    overdue: ["partially_paid","paid"],
    partially_paid: ["paid","overdue","disputed"],
    paid: ["disputed"],
    disputed: [],
    written_off: [],
    cancelled: [],
  }),
  account: machine(["pending_verification"], {
    pending_verification: ["active"],
    active: ["locked","disabled","anonymised"],
    locked: ["active"],
    disabled: ["active"],
    anonymised: [],
  }),
};

const canTransition = (kind, from, to) => Boolean(STATUS[kind] && STATUS[kind].transitions[from] && STATUS[kind].transitions[from].includes(to));

function assertTransition(kind, from, to) {
  if (!canTransition(kind, from, to)) throw ApiError.conflict(`Cannot move ${kind} from "${from}" to "${to}"`, 'INVALID_TRANSITION');
}

module.exports = { STATUS, canTransition, assertTransition };
