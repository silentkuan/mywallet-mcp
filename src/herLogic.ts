// "她" — girlfriend's period, instant-noodle and no-brushing logs. Shared rules.
// The same file lives in mywalletAI/src/utils/herLogic.ts; keep the two copies identical.
//
// Firestore (users/{uid}/...), all encrypted except id:
//   herPeriods/{id}    PeriodRecord
//   herNoodles/{id}    NoodleRecord
//   herNoBrush/{id}    NoBrushRecord
//   herMeta/state      HerState (when the last Telegram reminder went out)

export interface PeriodRecord {
  id: string;
  startDate: string;       // YYYY-MM-DD
  endDate?: string;
  pain?: number;           // 0–5
  mood?: string;
  symptoms?: string[];
  note?: string;
  createdAt: string;
}

export type NoodleKind = 'maggi' | 'instant' | 'spicy' | 'other';

export interface NoodleRecord {
  id: string;
  date: string;
  time?: string;           // HH:mm
  kind: NoodleKind;
  note?: string;
  createdAt: string;
}

export interface NoBrushRecord {
  id: string;
  date: string;            // the night she slept without brushing
  note?: string;
  createdAt: string;
}

export interface HerState {
  id: 'state';
  lastPeriodNotice?: string;
}

export const DEFAULT_CYCLE_DAYS = 28;
export const DEFAULT_PERIOD_DAYS = 5;
export const PREP_DAYS = 5;
export const LATE_REMIND_DAYS = 7;

// ── Dates (plain calendar days, no time zones) ──────────────────────────────

const toUtc = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysBetween = (from: string, to: string): number => Math.round((toUtc(to) - toUtc(from)) / 86400_000);
export const addDays = (d: string, n: number): string => new Date(toUtc(d) + n * 86400_000).toISOString().slice(0, 10);
// Monday of the week containing d
export const weekStart = (d: string): string => addDays(d, -((new Date(toUtc(d)).getUTCDay() + 6) % 7));

// ── Period ──────────────────────────────────────────────────────────────────

export type PeriodPhase = 'none' | 'period' | 'prep' | 'due' | 'normal';

export interface PeriodForecast {
  cycleDays: number;
  periodDays: number;
  cycleFromHistory: boolean;  // false → default 28 days
  lastStart: string | null;
  nextStart: string | null;
  daysUntilNext: number | null;  // negative = late
  prepStart: string | null;
  phase: PeriodPhase;
  dayOfPeriod: number | null;    // 1-based while on period
  upcoming: string[];            // next three predicted starts
}

const avg = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);

export function forecastPeriod(records: PeriodRecord[], today: string): PeriodForecast {
  const sorted = [...records].sort((a, b) => a.startDate.localeCompare(b.startDate));
  // Gaps between starts; skip odd ones (missed logs, typos) and keep the last six
  const gaps = sorted.slice(1).map((r, i) => daysBetween(sorted[i].startDate, r.startDate)).filter(g => g >= 15 && g <= 60).slice(-6);
  const lengths = sorted.filter(r => r.endDate).map(r => daysBetween(r.startDate, r.endDate!) + 1).filter(n => n >= 1 && n <= 14).slice(-6);
  const cycleDays = gaps.length ? avg(gaps) : DEFAULT_CYCLE_DAYS;
  const periodDays = lengths.length ? avg(lengths) : DEFAULT_PERIOD_DAYS;
  const last = sorted[sorted.length - 1];
  if (!last) {
    return { cycleDays, periodDays, cycleFromHistory: false, lastStart: null, nextStart: null, daysUntilNext: null, prepStart: null, phase: 'none', dayOfPeriod: null, upcoming: [] };
  }
  const nextStart = addDays(last.startDate, cycleDays);
  const lastEnd = last.endDate ?? addDays(last.startDate, periodDays - 1);
  const onPeriod = today >= last.startDate && today <= lastEnd;
  const daysUntilNext = daysBetween(today, nextStart);
  const phase: PeriodPhase = onPeriod ? 'period'
    : daysUntilNext <= 0 ? 'due'
      : daysUntilNext <= PREP_DAYS ? 'prep' : 'normal';
  return {
    cycleDays, periodDays, cycleFromHistory: gaps.length > 0,
    lastStart: last.startDate, nextStart, daysUntilNext,
    prepStart: addDays(nextStart, -PREP_DAYS), phase,
    dayOfPeriod: onPeriod ? daysBetween(last.startDate, today) + 1 : null,
    upcoming: [0, 1, 2].map(i => addDays(nextStart, i * cycleDays)),
  };
}

// Daily reminder from PREP_DAYS before the predicted start until she starts (or a week late)
export function shouldRemindPeriod(f: PeriodForecast): boolean {
  return f.daysUntilNext !== null && f.phase !== 'period'
    && f.daysUntilNext <= PREP_DAYS && f.daysUntilNext >= -LATE_REMIND_DAYS;
}

export const PREP_TIPS_ZH = ['少喝冰的、少吃生冷', '晚上泡脚 15–20 分钟', '准备暖宝宝和卫生用品', '红糖姜茶或温水', '早点睡，多休息', '心情可能比较敏感，多体贴一点'];
export const PERIOD_TIPS_ZH = ['肚子痛时用暖宝宝热敷', '多喝温水，避免冰饮和咖啡', '别安排太累的活动', '准备她喜欢的小零食'];

// Telegram text for the evening reminder
export function periodMessage(f: PeriodForecast): string {
  const d = f.daysUntilNext ?? 0;
  const head = d > 0 ? `🌸 她的月经预计 ${d} 天后来（${f.nextStart}）`
    : d === 0 ? `🌸 她的月经预计今天来（${f.nextStart}）`
      : `🌸 她的月经比预计晚了 ${-d} 天（预计 ${f.nextStart}），来了记得记录哦`;
  return [head, '', '可以提前准备：', ...PREP_TIPS_ZH.map(t => `• ${t}`)].join('\n');
}

// ── Noodles and no-brush nights ─────────────────────────────────────────────

export interface CountStats {
  thisWeek: number;
  thisMonth: number;
  total: number;
  lastDate: string | null;
  daysSinceLast: number | null;
  weeks: { weekStart: string; count: number }[];  // last 8 weeks, oldest first
}

export function countStats(items: { date: string }[], today: string): CountStats {
  const ws = weekStart(today);
  const dates = items.map(i => i.date).filter(d => d <= today).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const start = addDays(ws, (i - 7) * 7);
    const end = addDays(start, 6);
    return { weekStart: start, count: dates.filter(d => d >= start && d <= end).length };
  });
  return {
    thisWeek: dates.filter(d => d >= ws).length,
    thisMonth: dates.filter(d => d.slice(0, 7) === today.slice(0, 7)).length,
    total: dates.length,
    lastDate,
    daysSinceLast: lastDate ? daysBetween(lastDate, today) : null,
    weeks,
  };
}

// Nights in a row she brushed: from the night after the last miss up to last night
export function brushStreak(noBrush: { date: string }[], today: string): number | null {
  const s = countStats(noBrush, today);
  return s.lastDate ? Math.max(0, daysBetween(s.lastDate, today) - 1) : null;
}
