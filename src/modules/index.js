// Module registry in spec order (A..O) plus the shared uploads module.
module.exports = [
  require('./listings'), // A
  require('./masking'), // B
  require('./leads'), // C
  require('./approvals'), // D
  require('./search'), // E
  require('./kyc'), // F
  require('./projects'), // G
  require('./deals'), // H
  require('./receivables'), // I
  require('./teams'), // J
  require('./notifications'), // K
  require('./cms'), // L
  require('./auth'), // M
  require('./mlm'), // N
  require('./reports'), // O
  require('./uploads'), // shared
];
