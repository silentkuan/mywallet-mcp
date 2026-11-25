// Run: npx tsx scripts/test-her.ts
import assert from 'node:assert/strict';
import { forecastPeriod, shouldRemindPeriod, countStats, brushStreak, weekStart, addDays, daysBetween, periodMessage, PeriodRecord } from '../src/herLogic.js';

const p = (startDate: string, endDate?: string): PeriodRecord => ({ id: startDate, startDate, endDate, createdAt: '' });

assert.equal(weekStart('2026-11-25'), '2026-11-23'); // Wednesday → Monday
assert.equal(weekStart('2026-11-23'), '2026-11-23');
assert.equal(weekStart('2026-11-29'), '2026-11-23'); // Sunday
assert.equal(addDays('2026-12-30', 3), '2027-01-02');
assert.equal(daysBetween('2026-11-25', '2026-12-01'), 6);

// No history
assert.equal(forecastPeriod([], '2026-11-25').phase, 'none');

// One record: default 28-day cycle, 5-day period
let f = forecastPeriod([p('2026-11-10')], '2026-11-25');
assert.equal(f.nextStart, '2026-12-08');
assert.equal(f.cycleFromHistory, false);
assert.equal(f.phase, 'normal');
assert.equal(f.daysUntilNext, 13);

// History: gaps 30, 30 → 30 days; lengths 6 and 4 → 5
const hist = [p('2026-09-11', '2026-09-16'), p('2026-10-11', '2026-10-14'), p('2026-11-10')];
f = forecastPeriod(hist, '2026-12-05');
assert.equal(f.cycleDays, 30);
assert.equal(f.periodDays, 5);
assert.equal(f.nextStart, '2026-12-10');
assert.equal(f.phase, 'prep');
assert.equal(f.daysUntilNext, 5);
assert.equal(shouldRemindPeriod(f), true);
assert.equal(shouldRemindPeriod(forecastPeriod(hist, '2026-12-04')), false); // 6 days before: not yet
assert.equal(forecastPeriod(hist, '2026-12-10').phase, 'due');
assert.equal(shouldRemindPeriod(forecastPeriod(hist, '2026-12-17')), true);  // 7 days late
assert.equal(shouldRemindPeriod(forecastPeriod(hist, '2026-12-18')), false); // stop after a week
// On period: no reminder
f = forecastPeriod([...hist, p('2026-12-09')], '2026-12-11');
assert.equal(f.phase, 'period');
assert.equal(f.dayOfPeriod, 3);
assert.equal(shouldRemindPeriod(f), false);
// Odd gap (missed log, 60+ days) is ignored
assert.equal(forecastPeriod([p('2026-01-01'), p('2026-05-01'), p('2026-05-29')], '2026-06-01').cycleDays, 28);

console.log(periodMessage(forecastPeriod(hist, '2026-12-07')));

// Noodles
const n = (date: string) => ({ date });
const s = countStats([n('2026-11-23'), n('2026-11-25'), n('2026-11-02'), n('2026-10-30')], '2026-11-25');
assert.equal(s.thisWeek, 2);
assert.equal(s.thisMonth, 3);
assert.equal(s.daysSinceLast, 0);
assert.equal(s.weeks.length, 8);
assert.equal(s.weeks[7].count, 2);
assert.equal(s.weeks[7].weekStart, '2026-11-23');

// Brushing streak: missed on 11-20 → brushed 21, 22, 23, 24 nights = 4
assert.equal(brushStreak([n('2026-11-20')], '2026-11-25'), 4);
assert.equal(brushStreak([n('2026-11-24')], '2026-11-25'), 0);
assert.equal(brushStreak([], '2026-11-25'), null);

console.log('all her tests passed');
