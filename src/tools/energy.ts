import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { dateSchema, todayStr, addDays, daysBetween, round, jsonResult } from './healthCommon.js';
import { loadHealthProfile, HealthProfile } from './healthProfile.js';
import { listScans, BodyScan } from './bodyScans.js';
import { listWorkouts, Workout } from './workouts.js';
import { listDailyMetrics, DailyMetrics } from './dailyMetrics.js';
import { nutritionSummary } from './nutrition.js';

// Same model as the app's health tab (utils/healthAnalytics.ts):
// burn = BMR + daily activity + exercise + digestion (10% of intake)
//   with Apple Watch all-day active kcal: daily activity + exercise = active kcal
//   otherwise: daily activity from steps (or 10% of BMR), exercise = logged workout kcal
// BMR comes from the latest scan on or before that day; without scans, Katch-McArdle (lean mass) or Mifflin-St Jeor.
const TEF_RATE = 0.1;
const KCAL_PER_KG_FAT = 9400;
const KCAL_PER_KG_LEAN = 1800;
const KCAL_PER_KG_BODY = 7700;
const PARTIAL_DAY_RATIO = 0.6;  // intake below 60% of BMR is most likely an incomplete log

type BmrSource = 'scan' | 'lean_mass' | 'formula';

type EnergyDay = {
  date: string; intakeKcal: number; expenditureKcal: number; balanceKcal: number;
  breakdown: { bmr: number; dailyActivity: number; exercise: number; digestion: number };
  method: 'apple_watch_active' | 'steps' | 'estimate';
  bmrSource: BmrSource;
  excluded?: 'today_in_progress' | 'likely_incomplete_log';
};

function bmrForDate(date: string, scans: BodyScan[], profile: HealthProfile, metrics: DailyMetrics[]): { bmr: number; source: BmrSource; weightKg?: number } | null {
  // scans and metrics arrive newest first
  const scan = scans.find(s => s.date <= date && s.bmrKcal) ?? [...scans].reverse().find(s => s.bmrKcal);
  if (scan?.bmrKcal) return { bmr: scan.bmrKcal, source: 'scan', weightKg: scan.weightKg };
  const lean = scans.find(s => s.date <= date && s.leanBodyMassKg)?.leanBodyMassKg ?? scans.find(s => s.leanBodyMassKg)?.leanBodyMassKg;
  const weight = metrics.find(m => m.date <= date && m.weightKg)?.weightKg
    ?? scans.find(s => s.date <= date && s.weightKg)?.weightKg ?? scans.find(s => s.weightKg)?.weightKg;
  if (lean) return { bmr: Math.round(370 + 21.6 * lean), source: 'lean_mass', weightKg: weight };
  const age = profile.age ?? (profile.birthDate ? Math.floor(daysBetween(profile.birthDate, date) / 365.25) : undefined);
  if (weight && profile.heightCm && age !== undefined && profile.sex) {
    return { bmr: Math.round(10 * weight + 6.25 * profile.heightCm - 5 * age + (profile.sex === 'male' ? 5 : -161)), source: 'formula', weightKg: weight };
  }
  return null;
}

export function balanceTarget(goals: HealthProfile['goals'] = []) {
  if (goals.includes('fat_loss')) {
    return goals.includes('muscle_gain')
      ? { minKcal: -500, maxKcal: -300, note: 'recomposition: 300–500 kcal daily deficit' }
      : { minKcal: -750, maxKcal: -300, note: 'fat loss: 300–750 kcal daily deficit' };
  }
  if (goals.includes('muscle_gain')) return { minKcal: 150, maxKcal: 350, note: 'muscle gain: 150–350 kcal daily surplus' };
  if (goals.includes('maintain')) return { minKcal: -150, maxKcal: 150, note: 'maintain: within ±150 kcal' };
  return null;
}

export function computeEnergyBalance(
  daily: { date: string; mealCount: number; totals: Record<string, number>; recorded: string[] }[],
  scans: BodyScan[], profile: HealthProfile, workouts: Workout[], metrics: DailyMetrics[], today: string,
) {
  const days: EnergyDay[] = [];
  for (const d of daily) {
    if (!d.mealCount || !d.recorded.includes('calories')) continue;
    const b = bmrForDate(d.date, scans, profile, metrics);
    if (!b) continue;
    const m = metrics.find(x => x.date === d.date);
    const workoutKcal = workouts.filter(w => w.date === d.date).reduce((s, w) => s + (w.activeKcal ?? 0), 0);
    const intake = d.totals.calories;
    let dailyActivity: number, exercise: number, method: EnergyDay['method'];
    if (m?.activeKcal !== undefined) {
      exercise = Math.min(workoutKcal, m.activeKcal);
      dailyActivity = m.activeKcal - exercise;
      method = 'apple_watch_active';
    } else if (m?.steps) {
      exercise = workoutKcal;
      dailyActivity = m.steps * 0.0005 * (b.weightKg ?? 70);
      method = 'steps';
    } else {
      exercise = workoutKcal;
      dailyActivity = b.bmr * 0.1;
      method = 'estimate';
    }
    const tef = intake * TEF_RATE;
    const out = b.bmr + dailyActivity + exercise + tef;
    days.push({
      date: d.date,
      intakeKcal: round(intake, 0),
      expenditureKcal: round(out, 0),
      balanceKcal: round(intake - out, 0),
      breakdown: { bmr: round(b.bmr, 0), dailyActivity: round(dailyActivity, 0), exercise: round(exercise, 0), digestion: round(tef, 0) },
      method,
      bmrSource: b.source,
      excluded: d.date >= today ? 'today_in_progress' : intake < b.bmr * PARTIAL_DAY_RATIO ? 'likely_incomplete_log' : undefined,
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return null;
  // No complete day in the range (e.g. only today): fall back to what is logged and flag it
  const complete = days.filter(d => !d.excluded);
  const provisional = !complete.length;
  const counted = provisional ? days : complete;
  const avg = (f: (d: EnergyDay) => number) => (counted.length ? round(counted.reduce((s, d) => s + f(d), 0) / counted.length, 0) : null);
  const avgBalance = avg(d => d.balanceKcal);
  const total = counted.reduce((s, d) => s + d.balanceKcal, 0);
  return {
    countedDays: counted.length,
    provisional,
    averageIntakeKcal: avg(d => d.intakeKcal),
    averageExpenditureKcal: avg(d => d.expenditureKcal),
    averageDailyBalanceKcal: avgBalance,
    totalBalanceKcal: round(total, 0),
    estimatedFatChangeKg: round(total / KCAL_PER_KG_BODY, 2),
    estimatedWeeklyFatChangeKg: avgBalance === null ? null : round((avgBalance * 7) / KCAL_PER_KG_BODY, 2),
    days,
  };
}

// Actual change between the first and last scan in the period, converted to kcal/day — checks the estimate
function measuredBalance(scans: BodyScan[], start: string, end: string, energy: ReturnType<typeof computeEnergyBalance>) {
  const inRange = scans.filter(s => s.date >= start && s.date <= end && s.weightKg !== undefined).sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length < 2) return null;
  const from = inRange[0], to = inRange[inRange.length - 1];
  const days = daysBetween(from.date, to.date);
  if (days < 7) return null;
  const dWeight = to.weightKg! - from.weightKg!;
  const dFat = from.bodyFatMassKg !== undefined && to.bodyFatMassKg !== undefined ? to.bodyFatMassKg - from.bodyFatMassKg : undefined;
  const kcal = dFat !== undefined ? dFat * KCAL_PER_KG_FAT + (dWeight - dFat) * KCAL_PER_KG_LEAN : dWeight * KCAL_PER_KG_BODY;
  const logged = energy?.days.filter(d => !d.excluded && d.date >= from.date && d.date < to.date) ?? [];
  const avgIntake = logged.length ? logged.reduce((s, d) => s + d.intakeKcal, 0) / logged.length : undefined;
  const coverage = logged.length / days;
  return {
    fromDate: from.date, toDate: to.date, days,
    weightChangeKg: round(dWeight, 1),
    fatChangeKg: dFat === undefined ? null : round(dFat, 1),
    impliedDailyBalanceKcal: round(kcal / days, 0),
    loggedDaysBetweenScans: logged.length,
    // only meaningful when most days between the scans were logged
    impliedRealExpenditureKcal: coverage >= 0.7 && avgIntake !== undefined ? round(avgIntake - kcal / days, 0) : null,
  };
}

export function registerEnergyTools(server: McpServer): void {

  server.tool(
    'get_energy_balance',
    '热量缺口 / 盈余报告：每天摄入 vs 消耗（基础代谢 + 日常活动 + 运动 + 食物消化）、平均每天缺口、累计折合脂肪、和目标区间比较，并用期间内两次身体检测的实际变化校对估算。今天和疑似漏记的日子（摄入 < 基础代谢 60%）不计入平均。默认最近 30 天。',
    { startDate: dateSchema.optional(), endDate: dateSchema.optional() },
    async ({ startDate, endDate }) => {
      const today = todayStr();
      const end = endDate ?? today;
      const start = startDate ?? addDays(end, -29);
      const [profile, scans, workouts, metrics, nutrition] = await Promise.all([
        loadHealthProfile(), listScans(), listWorkouts(start, end), listDailyMetrics(start, end), nutritionSummary(start, end),
      ]);
      const energy = computeEnergyBalance(nutrition.daily, scans, profile, workouts, metrics, today);
      return jsonResult({
        startDate: start, endDate: end,
        target: balanceTarget(profile.goals),
        ...(energy ?? { countedDays: 0, note: 'Needs meals with calories plus a body scan (BMR) or sex/age/height in the health profile.' }),
        measuredFromScans: measuredBalance(scans, start, end, energy),
        model: 'expenditure = BMR + daily activity + exercise + 10% of intake (digestion); fat ≈ 7700 kcal/kg',
      });
    }
  );
}

export function energyBalanceForOverview(
  daily: Parameters<typeof computeEnergyBalance>[0], scans: BodyScan[], profile: HealthProfile, workouts: Workout[], metrics: DailyMetrics[], today: string,
) {
  const energy = computeEnergyBalance(daily, scans, profile, workouts, metrics, today);
  return energy ? { ...energy, target: balanceTarget(profile.goals) } : null;
}
