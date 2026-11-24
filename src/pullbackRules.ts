// Pullback rules for the monthly investment plan — pure functions, no I/O, so they can be tested with made-up prices.
import {
  InvestmentPlan, InvestmentState, InvestEvent, InvestAlert, SymbolWatch,
  reserveBalance, tierMode, tierRules, tierPrice, lastReserveUseMonth, monthsBetween, releaseActiveIn,
  releaseSymbolFor, monthSummary, monthOf, round2,
} from './investPlan.js';
import { DailyClose } from './prices.js';

export type CloseResult = { closes: DailyClose[]; source: string } | { error: string };

export interface EvaluateInput {
  plan: InvestmentPlan;
  events: InvestEvent[];
  alerts: InvestAlert[];
  state: InvestmentState;
  today: string;
  closes: Record<string, CloseResult>;
}

export interface EvaluateResult {
  state: InvestmentState;
  newAlerts: InvestAlert[];
}

const money = (plan: InvestmentPlan, n: number) => `${plan.currency} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function evaluate({ plan, events, alerts, state, today, closes }: EvaluateInput): EvaluateResult {
  const month = monthOf(today);
  const balance = reserveBalance(plan, events, month);
  const openTotal = alerts.filter(a => a.status === 'open').reduce((s, a) => s + a.suggestedAmount, 0);
  const available = Math.max(0, round2(balance - openTotal));
  const existing = new Set(alerts.map(a => a.id));
  const watch: Record<string, SymbolWatch> = {};
  const fired: { symbol: string; weight: number; fraction: number; tier: number; mode: 2 | 3; dd: number; price: number; refHigh: number; startDate: string }[] = [];

  for (const h of plan.holdings.filter(x => x.useReserve)) {
    const prev = state.watch[h.symbol];
    const result = closes[h.symbol];
    if (!result || 'error' in result) {
      watch[h.symbol] = { ...(prev ?? { symbol: h.symbol, lastClose: 0, lastCloseDate: '', high52: 0, drawdownPct: 0, episode: null }), error: result && 'error' in result ? result.error : 'no data' };
      continue;
    }
    const year = result.closes.slice(-252);
    const last = year[year.length - 1];
    const high52 = Math.max(...year.map(c => c.close));
    const drawdownPct = round2((high52 - last.close) / high52 * 100);
    let episode = prev?.episode ?? null;

    // A close back above the high the pullback started from ends it; all tiers can fire again next time
    if (episode && last.close >= episode.refHigh) episode = null;
    if (!episode && drawdownPct >= tierRules(2)[0].dropPct) {
      episode = { refHigh: high52, startDate: last.date, mode: tierMode(plan, available), firedTiers: [] };
    }
    if (episode) {
      const dd = round2((episode.refHigh - last.close) / episode.refHigh * 100);
      const rules = tierRules(episode.mode);
      const reached = rules.map((r, i) => ({ ...r, tier: i + 1 })).filter(r => dd >= r.dropPct && !episode!.firedTiers.includes(r.tier));
      if (reached.length) {
        // Several tiers crossed at once: apply them one after another
        const left = reached.reduce((rest, r) => rest * (1 - r.fraction), 1);
        const tier = Math.max(...reached.map(r => r.tier));
        fired.push({ symbol: h.symbol, weight: h.timesPerCycle, fraction: 1 - left, tier, mode: episode.mode, dd, price: last.close, refHigh: episode.refHigh, startDate: episode.startDate });
        episode = { ...episode, firedTiers: [...episode.firedTiers, ...reached.map(r => r.tier)] };
      }
    }
    watch[h.symbol] = { symbol: h.symbol, lastClose: last.close, lastCloseDate: last.date, high52, drawdownPct, episode, source: result.source };
  }

  const newAlerts: InvestAlert[] = [];
  const createdAt = new Date().toISOString();

  // Stocks that fire on the same day share the money by their weight in the plan
  if (fired.length) {
    const pool = round2(available * Math.max(...fired.map(f => f.fraction)));
    const weights = fired.reduce((s, f) => s + f.weight, 0);
    for (const f of fired) {
      const id = `tier-${f.symbol}-${f.startDate}-${f.tier}`;
      if (existing.has(id)) continue;
      newAlerts.push({
        id, kind: 'tier', date: today, month, symbol: f.symbol, tier: f.tier, mode: f.mode, drawdownPct: f.dd,
        price: f.price, refHigh: f.refHigh, suggestedAmount: round2(pool * f.weight / weights), status: 'open', createdAt,
      });
    }
  }

  // Idle reserve release: stops when a pullback starts, ends after releaseMonths
  let release = state.release;
  const inPullback = Object.values(watch).some(w => w.episode);
  if (release && (inPullback || monthsBetween(release.startMonth, month) >= plan.releaseMonths)) release = null;
  if (!release && !inPullback && balance > 0 && monthsBetween(lastReserveUseMonth(plan, events), month) >= plan.idleMonths) {
    release = { startMonth: month, perMonth: round2(balance / plan.releaseMonths) };
  }
  if (release && releaseActiveIn(plan, release, month)) {
    const id = `release-${month}`;
    const symbol = releaseSymbolFor(plan, month);
    const alreadyReleased = events.some(e => e.month === month && e.type === 'reserve_use' && e.reason === 'release');
    if (symbol && !existing.has(id) && !alreadyReleased) {
      newAlerts.push({ id, kind: 'release', date: today, month, symbol, suggestedAmount: Math.min(release.perMonth, available), status: 'open', createdAt });
    }
  }

  return { state: { ...state, watch, release }, newAlerts };
}

export function alertMessage(plan: InvestmentPlan, a: InvestAlert, balance: number): string {
  if (a.kind === 'release') {
    return `💰 回调资金已经 ${plan.idleMonths} 个月没用了，开始分 ${plan.releaseMonths} 个月释放\n` +
      `这个月：多拿 ${money(plan, a.suggestedAmount)} 买 ${a.symbol}（合并到本月定投）\n回调资金余额：${money(plan, balance)}`;
  }
  const rules = tierRules(a.mode ?? 2);
  const next = rules[a.tier ?? 1];
  const lines = [
    `🔔 ${a.symbol} 比 52 周最高价便宜 ${a.drawdownPct}%（${a.price} / 最高 ${a.refHigh}）`,
    `${a.mode === 3 ? '三' : '两'}档模式 · 第${['一', '二', '三'][(a.tier ?? 1) - 1]}档触发`,
    a.suggestedAmount > 0
      ? `建议：用回调资金 ${money(plan, a.suggestedAmount)} 买 ${a.symbol}`
      : `回调资金目前是 0，这次没有钱可以加码`,
    `回调资金余额：${money(plan, balance)}`,
  ];
  if (next && a.refHigh) lines.push(`下一档：跌到 ${tierPrice(a.refHigh, next.dropPct)}（便宜 ${next.dropPct}%）`);
  return lines.join('\n');
}

export function monthlyMessage(plan: InvestmentPlan, events: InvestEvent[], state: InvestmentState, month: string): string {
  const s = monthSummary(plan, events, state.release, month);
  const balance = reserveBalance(plan, events, month);
  const lines = [
    `📅 ${month} 每月投资`,
    `本月买：${s.symbol ?? '-'} ${money(plan, s.buyAmount)}`,
    `回调资金 +${money(plan, s.reserveDeposit)} → 余额 ${money(plan, balance)}`,
  ];
  if (s.releaseAmount > 0 && s.releaseSymbol) lines.push(`另外释放回调资金 ${money(plan, s.releaseAmount)} 买 ${s.releaseSymbol}`);
  return lines.join('\n');
}
