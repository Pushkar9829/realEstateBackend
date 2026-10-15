// Account roles. Each role maps to one frontend panel.
const ROLES = Object.freeze({
  BUYER: 'buyer', // public portal          /
  LISTER: 'lister', // lister panel          /lister   (listerType: owner | builder | landlord)
  AGENT: 'agent', // sales agent CRM       /agent
  MANAGER: 'manager', // sales manager: agent panel + team-scoped admin panel
  ADMIN: 'admin', // admin staff (permission keys) /admin
  SUPERADMIN: 'superadmin', // holds every permission implicitly
});

const LISTER_TYPES = ['owner', 'builder', 'landlord'];
const STAFF_ROLES = [ROLES.AGENT, ROLES.MANAGER, ROLES.ADMIN, ROLES.SUPERADMIN];
const ADMIN_PANEL_ROLES = [ROLES.ADMIN, ROLES.SUPERADMIN, ROLES.MANAGER];
const SELF_SIGNUP_ROLES = [ROLES.BUYER, ROLES.LISTER];

module.exports = { ROLES, LISTER_TYPES, STAFF_ROLES, ADMIN_PANEL_ROLES, SELF_SIGNUP_ROLES };
