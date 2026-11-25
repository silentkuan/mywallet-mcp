// Run: npx tsx scripts/test-invest-plan.ts
import assert from 'node:assert/strict';
import {
  defaultPlan, buildRotation, symbolForMonth, monthlySplit, reserveBalance, withAmount, monthSummary, addMonths, monthsBetween,
  InvestEvent, InvestmentState, InvestAlert,
} from '../src/investPlan.js';
import { evaluate, CloseResult, alertMessage } from '../src/pullbackRules.js';
import { compareWithClaude } from '../src/investPlan.js';

const plan = defaultPlan('2026-12');
const ev = (e: Partial<InvestEvent>): InvestEvent => ({ id: Math.random().toString(), type: 'reserve_use', date: '2027-01-01', month: '2027-01', amount: 0, createdAt: '2027-01-01T00:00:00Z', ...e });
const emptyState = (): InvestmentState => ({ id: 'state', watch: {}, release: null });

// Closes: 251 days at `high`, then the last close
const series = (high: number, last: number): CloseResult => ({
  source: 'test',
  closes: [...Array.from({ length: 251 }, (_, i) => ({ date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, close: high })), { date: '2026-12-15', close: last }],
});

// Months
assert.equal(addMonths('2026-12', 1), '2027-01');
assert.equal(addMonths('2027-01', -1), '2026-12');
assert.equal(monthsBetween('2026-12', '2027-12'), 12);

// Rotation: QQQM 3, SPYM 2, DBS 1 per six months, QQQM never twice in a row
const rot = buildRotation(plan.holdings);
assert.equal(rot.length, 6);
assert.deepEqual([...rot].sort(), ['DBS', 'QQQM', 'QQQM', 'QQQM', 'SPYM', 'SPYM']);
for (let i = 0; i < 6; i++) assert.ok(!(rot[i] === 'QQQM' && rot[(i + 1) % 6] === 'QQQM'), 'QQQM twice in a row');
assert.equal(symbolForMonth(plan, '2026-12'), rot[0]);
assert.equal(symbolForMonth(plan, '2027-06'), rot[0]);
assert.equal(symbolForMonth(plan, '2026-11'), null);
console.log('rotation', rot.join(' → '));

// Split and reserve, including an amount change from March
assert.deepEqual(monthlySplit(plan, '2026-12'), { total: 1500, buy: 1050, reserve: 450 });
const raised = withAmount(plan, '2027-03', 2000, 70);
assert.equal(monthlySplit(raised, '2027-02').total, 1500);
assert.equal(monthlySplit(raised, '2027-03').reserve, 600);
assert.equal(reserveBalance(raised, [], '2027-03'), 450 * 3 + 600);
assert.equal(reserveBalance(plan, [ev({ amount: 500 }), ev({ type: 'reserve_adjust', amount: 100 })], '2027-01'), 900 - 500 + 100);

// Month status
const s = monthSummary(plan, [ev({ type: 'monthly_buy', month: '2026-12', amount: 1050 })], null, '2026-12');
assert.equal(s.status, 'done');
assert.equal(monthSummary(plan, [], null, '2026-12').status, 'pending');

// Pullback: six months saved (2700) → two tiers; -10% fires tier 1 for half
const sixMonths = withAmount(defaultPlan('2026-07'), '2026-07', 1500, 70);
let r = evaluate({ plan: sixMonths, events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 90), SPYM: series(100, 95) } });
assert.equal(r.newAlerts.length, 1);
assert.equal(r.newAlerts[0].symbol, 'QQQM');
assert.equal(r.newAlerts[0].tier, 1);
assert.equal(r.newAlerts[0].mode, 2);
assert.equal(r.newAlerts[0].suggestedAmount, 1350);
assert.equal(r.state.watch.SPYM.episode, null);

// Same day again: nothing new
let alerts: InvestAlert[] = r.newAlerts;
let r2 = evaluate({ plan: sixMonths, events: [], alerts, state: r.state, today: '2026-12-17', closes: { QQQM: series(100, 88), SPYM: series(100, 95) } });
assert.equal(r2.newAlerts.length, 0);

// User bought with tier 1 money, then -20% → the rest
const used = [ev({ month: '2026-12', amount: 1350 })];
alerts = alerts.map(a => ({ ...a, status: 'done' as const }));
r2 = evaluate({ plan: sixMonths, events: used, alerts, state: r.state, today: '2026-12-18', closes: { QQQM: series(100, 80), SPYM: series(100, 95) } });
assert.equal(r2.newAlerts.length, 1);
assert.equal(r2.newAlerts[0].tier, 2);
assert.equal(r2.newAlerts[0].suggestedAmount, 1350);

// Back above the old high → episode resets
const r3 = evaluate({ plan: sixMonths, events: used, alerts, state: r2.state, today: '2026-12-20', closes: { QQQM: series(100, 101), SPYM: series(100, 95) } });
assert.equal(r3.state.watch.QQQM.episode, null);

// Gap straight to -20% in two-tier mode → everything at once
r = evaluate({ plan: sixMonths, events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 79), SPYM: series(100, 99) } });
assert.equal(r.newAlerts[0].suggestedAmount, 2700);

// Three tiers once the reserve is 5000+; both firing → split 3:2
const bigPlan = defaultPlan('2025-12'); // 13 months × 450 = 5850 by 2026-12
r = evaluate({ plan: bigPlan, events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 89), SPYM: series(100, 90) } });
assert.equal(r.newAlerts.length, 2);
assert.equal(r.newAlerts[0].mode, 3);
const total = r.newAlerts.reduce((x, a) => x + a.suggestedAmount, 0);
assert.equal(Math.round(total), Math.round(5850 / 3));
assert.equal(r.newAlerts.find(a => a.symbol === 'QQQM')!.suggestedAmount, Math.round(5850 / 3 * 0.6 * 100) / 100);
// Open alerts hold their money: the next tier works on what is left
r2 = evaluate({ plan: bigPlan, events: [], alerts: r.newAlerts, state: r.state, today: '2026-12-17', closes: { QQQM: series(100, 79), SPYM: series(100, 90) } });
assert.equal(r2.newAlerts[0].tier, 2);
assert.equal(r2.newAlerts[0].suggestedAmount, Math.round((5850 - 1950) / 2 * 100) / 100);

// Idle release: 12 months without use, no pullback → release a sixth per month
r = evaluate({ plan: bigPlan, events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 98), SPYM: series(100, 99) } });
assert.deepEqual(r.state.release, { startMonth: '2026-12', perMonth: 975 });
const rel = r.newAlerts.find(a => a.kind === 'release')!;
assert.equal(rel.suggestedAmount, 975);
assert.equal(rel.symbol, symbolForMonth(bigPlan, '2026-12') === 'DBS' ? 'QQQM' : symbolForMonth(bigPlan, '2026-12'));
// Not idle yet with a recent use
r = evaluate({ plan: bigPlan, events: [ev({ month: '2026-06', amount: 100 })], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 98), SPYM: series(100, 99) } });
assert.equal(r.state.release, null);
// A pullback stops the release
r2 = evaluate({ plan: bigPlan, events: [], alerts: [], state: { ...emptyState(), release: { startMonth: '2026-11', perMonth: 900 } }, today: '2026-12-16', closes: { QQQM: series(100, 88), SPYM: series(100, 99) } });
assert.equal(r2.state.release, null);
assert.ok(r2.newAlerts.every(a => a.kind === 'tier'));
// Release ends after six months
r2 = evaluate({ plan: bigPlan, events: [ev({ month: '2026-11', amount: 1 })], alerts: [], state: { ...emptyState(), release: { startMonth: '2026-06', perMonth: 900 } }, today: '2026-12-16', closes: { QQQM: series(100, 98), SPYM: series(100, 99) } });
assert.equal(r2.state.release, null);

// No money: alert still says the tier fired, with 0
const fresh = defaultPlan('2026-12');
r = evaluate({ plan: fresh, events: [{ ...ev({ month: '2026-12', amount: 450 }) }], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 89), SPYM: series(100, 99) } });
assert.equal(r.newAlerts[0].suggestedAmount, 0);

// Price error keeps the previous episode
r = evaluate({ plan: sixMonths, events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 90), SPYM: { error: 'down' } } });
assert.equal(r.state.watch.SPYM.error, 'down');

// Plan not started yet: watch only, no episode or alert
r = evaluate({ plan: defaultPlan('2027-01'), events: [], alerts: [], state: emptyState(), today: '2026-12-16', closes: { QQQM: series(100, 85), SPYM: series(100, 99) } });
assert.equal(r.newAlerts.length, 0);
assert.equal(r.state.watch.QQQM.episode, null);
assert.equal(r.state.watch.QQQM.drawdownPct, 15);

// Claude cross-check
const ours = { lastClose: 262.78, high52: 312.76 };
assert.equal(compareWithClaude(ours, { lastClose: 263.5, high52: 312.76 }, 't').status, 'ok');
const mm = compareWithClaude(ours, { lastClose: 262.8, high52: 320.5 }, 't');
assert.equal(mm.status, 'mismatch');
assert.equal(mm.note, 'different 52-week high');
assert.equal(compareWithClaude(ours, { lastClose: 262.8 }, 't').status, 'unavailable');
assert.equal(compareWithClaude(ours, null, 't').status, 'unavailable');
const tierAlert: InvestAlert = { id: 'a', kind: 'tier', date: '2026-12-01', month: '2026-12', symbol: 'QQQM', tier: 1, mode: 2, drawdownPct: 16, price: 262.78, refHigh: 312.76, suggestedAmount: 225, status: 'open', createdAt: '' };
assert.ok(alertMessage(plan, { ...tierAlert, claude: mm }, 450).includes('⚠️ 数据不一致'));
assert.ok(alertMessage(plan, { ...tierAlert, claude: compareWithClaude(ours, { lastClose: 263, high52: 312.7, lastCloseDate: '2026-11-28' }, 't') }, 450).includes('✅ Claude 已核对'));
console.log(alertMessage(plan, { ...tierAlert, claude: mm }, 450));

console.log('all investment plan tests passed');
