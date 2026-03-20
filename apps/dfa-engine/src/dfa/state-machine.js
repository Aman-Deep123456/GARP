/**
 * DFA State Machine utilities.
 *
 * 9-state DFA:
 *   ACTIVE → INITIATED → VALIDATING → READY_PAY → PROCESSING → SETTLED
 *                                   → REJECTED
 *                                                 → RETRY → PROCESSING
 *                                                         → FAILED
 * Terminal states: SETTLED, REJECTED, FAILED
 */

const STATES = {
  ACTIVE: 'ACTIVE',
  INITIATED: 'INITIATED',
  VALIDATING: 'VALIDATING',
  READY_PAY: 'READY_PAY',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  SETTLED: 'SETTLED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
};

const TERMINAL_STATES = new Set([STATES.SETTLED, STATES.REJECTED, STATES.FAILED]);

/**
 * Valid transitions map.
 */
const TRANSITIONS = {
  [STATES.ACTIVE]:     [STATES.INITIATED],
  [STATES.INITIATED]:  [STATES.VALIDATING],
  [STATES.VALIDATING]: [STATES.READY_PAY, STATES.REJECTED],
  [STATES.READY_PAY]:  [STATES.PROCESSING],
  [STATES.PROCESSING]: [STATES.SETTLED, STATES.RETRY],
  [STATES.RETRY]:      [STATES.PROCESSING, STATES.FAILED],
};

function isValidTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * Compute payout: Y = (WeeklySI / 7) / DST × HoursDisrupted
 * DST = P90 14-day active hours, fallback 8.2h
 */
function computePayout(weeklySI = 2500, dst = 8.2, hoursDisrupted = 1) {
  const dailySI = weeklySI / 7;
  const hourlyRate = dailySI / dst;
  return Math.round(hourlyRate * hoursDisrupted * 100) / 100;
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  isValidTransition,
  isTerminal,
  computePayout,
};
