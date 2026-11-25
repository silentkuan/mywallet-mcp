// Daily pullback check for the monthly investment plan.
// Reads a year of closes for every stock the reserve may buy, follows each pullback through its tiers,
// starts/stops the idle-reserve release, writes alerts and sends them to Telegram.
import { InvestAlert, SymbolWatch, ClaudeCheck, reserveBalance, monthSummary, monthOf, sgToday, compareWithClaude } from './investPlan.js';
import { claudePullback } from './verifier.js';
import { fetchDailyCloses } from './prices.js';
import { CloseResult, evaluate, alertMessage, monthlyMessage } from './pullbackRules.js';
import { getPlan, getState, saveState, getEvents, getAlerts, saveAlert } from './investStore.js';
import { sendTelegram, telegramConfigured } from './telegram.js';
import { config } from './config.js';

export interface CheckResult {
  ran: boolean;
  reason?: string;
  newAlerts: InvestAlert[];
  watch: Record<string, SymbolWatch>;
  telegramSent: number;
}

// Claude checks the numbers behind new tier alerts ('alerts'), every watched stock ('all') or nothing ('none').
// It never blocks an alert: a mismatch or no answer is written on the alert instead.
export async function runInvestmentCheck(opts: { notify: boolean; scheduled: boolean; claude?: 'alerts' | 'all' | 'none' }): Promise<CheckResult> {
  const plan = await getPlan();
  if (!plan) return { ran: false, reason: 'no plan', newAlerts: [], watch: {}, telegramSent: 0 };
  const [events, alerts, state] = await Promise.all([getEvents(), getAlerts(), getState()]);
  const today = sgToday();
  const month = monthOf(today);

  const closes: Record<string, CloseResult> = {};
  for (const h of plan.holdings.filter(x => x.useReserve)) {
    try { closes[h.symbol] = await fetchDailyCloses(h.symbol, h.market); }
    catch (e) { closes[h.symbol] = { error: (e as Error).message }; }
  }

  const { state: next, newAlerts } = evaluate({ plan, events, alerts, state, today, closes });

  const claudeMode = opts.claude ?? 'alerts';
  const toCheck = claudeMode === 'all'
    ? Object.values(next.watch).filter(w => !w.error && w.lastClose > 0).map(w => w.symbol)
    : claudeMode === 'alerts' ? [...new Set(newAlerts.filter(a => a.kind === 'tier').map(a => a.symbol))] : [];
  if (toCheck.length) {
    const answers = await claudePullback(toCheck.map(symbol => ({ symbol, market: plan.holdings.find(h => h.symbol === symbol)?.market ?? 'US' })));
    const checkedAt = new Date().toISOString();
    for (const symbol of toCheck) {
      const w = next.watch[symbol];
      const check: ClaudeCheck = answers
        ? compareWithClaude(w, answers.get(symbol) ?? null, checkedAt)
        : { status: 'unavailable', checkedAt, note: 'Claude checker not reachable' };
      next.watch[symbol] = { ...w, claude: check };
      newAlerts.forEach((a, i) => { if (a.symbol === symbol) newAlerts[i] = { ...a, claude: check }; });
    }
    console.log(`[invest] claude check: ${toCheck.map(sym => `${sym}=${next.watch[sym].claude?.status}`).join(', ')}`);
  }
  const messages: string[] = [];
  const balance = reserveBalance(plan, events, month);

  for (const a of newAlerts) {
    await saveAlert(a);
    if (plan.telegramPullback) messages.push(alertMessage(plan, a, balance));
  }
  if (opts.scheduled) {
    next.lastCheckDate = today;
    const s = monthSummary(plan, events, next.release, month);
    if (plan.telegramMonthly && next.lastMonthlyNotice !== month && s.status === 'pending' && month >= plan.startMonth) {
      messages.unshift(monthlyMessage(plan, events, next, month));
      next.lastMonthlyNotice = month;
    }
  }
  next.lastCheckAt = new Date().toISOString();
  await saveState(next);

  let telegramSent = 0;
  if (opts.notify && telegramConfigured()) {
    for (const m of messages) {
      if (await sendTelegram(m)) telegramSent++;
    }
  }
  console.log(`[invest] check done: ${newAlerts.length} new alert(s), ${telegramSent} telegram message(s)`);
  return { ran: true, newAlerts, watch: next.watch, telegramSent };
}

// Runs once a day after INVEST_CHECK_HOUR (Singapore time). The last run date is kept in Firestore,
// so a restart does not repeat the day's check.
export function startInvestmentScheduler(): void {
  if (config.INVEST_CHECKER !== 'on') {
    console.log('[invest] scheduler off');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = new Date();
    const sgHour = (now.getUTCHours() + 8) % 24;
    if (sgHour < config.INVEST_CHECK_HOUR) return;
    running = true;
    try {
      const state = await getState();
      if (state.lastCheckDate === sgToday(now)) return;
      await runInvestmentCheck({ notify: true, scheduled: true });
    } catch (e) {
      console.error('[invest] scheduled check failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 10 * 60_000);
  setTimeout(tick, 30_000);
  console.log(`[invest] scheduler on — daily after ${config.INVEST_CHECK_HOUR}:00 Singapore time`);
}
