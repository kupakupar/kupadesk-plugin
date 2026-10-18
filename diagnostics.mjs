const totals = {injected: 0, already: 0, unbound: 0, invalid: 0};
let last = null;
export function recordOutcome(outcome) {
  if (!Object.prototype.hasOwnProperty.call(totals, outcome)) return;
  totals[outcome]++;
  last = {outcome, at: new Date().toISOString()};
}
export function injectionDiagnostics() { return {totals: {...totals}, last}; }
