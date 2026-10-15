// Module J - Teams & Territory Management: teams with members, capacity and
// working hours, and the ordered lead routing rules.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  managerIds: [{ type: ObjectId, ref: 'User' }],
  members: [{
    _id: false,
    agentId: { type: ObjectId, ref: 'User', required: true },
    capacity: { type: Number, default: 50 }, // max open leads
    available: { type: Boolean, default: true },
    leaveFrom: Date,
    leaveTo: Date,
    lastAssignedAt: Date,
  }],
  territories: { cities: [String], localities: [String] },
  workingHours: { start: { type: String, default: '09:00' }, end: { type: String, default: '20:00' }, days: { type: [Number], default: [1, 2, 3, 4, 5, 6] } },
  mode: { type: String, enum: ['round_robin', 'least_open_leads'], default: 'round_robin' },
  pointer: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const routingRuleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  priority: { type: Number, required: true, index: true }, // lower = evaluated first
  conditions: {
    cities: [String], localities: [String], purpose: String, category: String, types: [String],
    budgetMin: Number, budgetMax: Number, sources: [String], listerTypes: [String],
  },
  teamId: { type: ObjectId, ref: 'Team', required: true },
  modeOverride: { type: String, enum: ['round_robin', 'least_open_leads'] },
}, { timestamps: true });

module.exports = {
  Team: mongoose.model('Team', teamSchema),
  RoutingRule: mongoose.model('RoutingRule', routingRuleSchema),
};
