// Monthly investment plan — shared rules.
// The same file lives in mywalletAI/src/utils/investPlan.ts; keep the two copies identical.
//
// Firestore layout (users/{uid}/...):
//   investmentPlan/main      the plan (InvestmentPlan)
//   investmentPlan/state     what the daily pullback check last saw (InvestmentState)
//   investmentEvents/{id}    monthly buys, skips, reserve uses and adjustments (InvestEvent)
//   investmentAlerts/{id}    pullback and release alerts (InvestAlert)
// Every document is encrypted except its id.

export interface InvestHolding {
  symbol: string;
  market: string;          // 'US' | 'SG' | 'MY'
  currency: string;        // currency the stock trades in
  timesPerCycle: number;   // how many months per rotation cycle this stock is bought
  useReserve: boolean;     // pullback reserve may be spent on it
}

// Amount settings from a month onwards, so changing the amount never rewrites past months
export interface InvestAmountVersion {
  fromMonth: string;       // YYYY-MM
  monthlyAmount: number;
  buyPct: number;          // the rest goes to the reserve
}

export interface InvestmentPlan {
  id: 'main';
  currency: string;        // currency the monthly amount and reserve are counted in
  startMonth: string;      // first month of the plan (first reserve deposit)
  rotationAnchor: string;  // month that takes rotation slot 0; reset when the holdings change
  versions: InvestAmountVersion[];
  holdings: InvestHolding[];
  threeTierFrom: number;   // reserve at or above this uses three tiers, below it two
  idleMonths: number;      // reserve unused this long → start releasing it
  releaseMonths: number;   // spread the release over this many months
  telegramMonthly: boolean;
  telegramPullback: boolean;
  updatedAt: string;
}

export type InvestEventType = 'monthly_buy' | 'skip' | 'reserve_use' | 'reserve_adjust';

export interface InvestEvent {
  id: string;
  type: InvestEventType;
  date: string;            // YYYY-MM-DD
  month: string;           // plan month it belongs to
  symbol?: string;
  amount: number;          // in plan currency; reserve_adjust may be negative
  stockTxId?: string;
  reason?: 'tier' | 'release' | 'manual';
  alertId?: string;
  note?: string;
  createdAt: string;
}

export interface PullbackEpisode {
  refHigh: number;         // 52-week high when the pullback started; the episode ends at a close above it
  startDate: string;
  mode: 2 | 3;
  firedTiers: number[];    // tier numbers (1-based) already alerted
}

export interface SymbolWatch {
  symbol: string;
  lastClose: number;
  lastCloseDate: string;
  high52: number;
  drawdownPct: number;     // from high52, 0..100
  episode: PullbackEpisode | null;
  source?: string;
  error?: string;
}

export interface ReleaseState {
  startMonth: string;
  perMonth: number;
}

export interface InvestmentState {
  id: 'state';
  lastCheckDate?: string;  // Singapore date of the last scheduled check
  lastCheckAt?: string;
  lastMonthlyNotice?: string;
  watch: Record<string, SymbolWatch>;
  release: ReleaseState | null;
}

export interface InvestAlert {
  id: string;
  kind: 'tier' | 'release';
  date: string;
  month: string;
  symbol: string;
  tier?: number;
  mode?: 2 | 3;
  drawdownPct?: number;
  price?: number;
  refHigh?: number;
  suggestedAmount: number; // plan currency
  status: 'open' | 'done' | 'dismissed';
  createdAt: string;
}

// ── Months ──────────────────────────────────────────────────────────────────

export const monthOf = (date: string): string => date.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

// Today's date in Singapore, where the plan is run
export function sgToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

// ── Plan ────────────────────────────────────────────────────────────────────

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function defaultPlan(month: string): InvestmentPlan {
  return {
    id: 'main',
    currency: 'SGD',
    startMonth: month,
    rotationAnchor: month,
    versions: [{ fromMonth: month, monthlyAmount: 1500, buyPct: 70 }],
    holdings: [
      { symbol: 'QQQM', market: 'US', currency: 'USD', timesPerCycle: 3, useReserve: true },
      { symbol: 'SPYM', market: 'US', currency: 'USD', timesPerCycle: 2, useReserve: true },
      { symbol: 'DBS', market: 'SG', currency: 'SGD', timesPerCycle: 1, useReserve: false },
    ],
    threeTierFrom: 5000,
    idleMonths: 12,
    releaseMonths: 6,
    telegramMonthly: true,
    telegramPullback: true,
    updatedAt: new Date().toISOString(),
  };
}

export function versionFor(plan: InvestmentPlan, month: string): InvestAmountVersion | null {
  const sorted = [...plan.versions].sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
  let found: InvestAmountVersion | null = null;
  for (const v of sorted) if (v.fromMonth <= month) found = v;
  return found ?? sorted[0] ?? null;
}

// New amount from `fromMonth` on; later settings are replaced by it
export function withAmount(plan: InvestmentPlan, fromMonth: string, monthlyAmount: number, buyPct: number): InvestmentPlan {
  const kept = plan.versions.filter(v => v.fromMonth < fromMonth);
  return { ...plan, versions: [...kept, { fromMonth, monthlyAmount, buyPct }] };
}

export function monthlySplit(plan: InvestmentPlan, month: string): { total: number; buy: number; reserve: number } {
  if (month < plan.startMonth) return { total: 0, buy: 0, reserve: 0 };
  const v = versionFor(plan, month);
  if (!v) return { total: 0, buy: 0, reserve: 0 };
  const buy = round2(v.monthlyAmount * v.buyPct / 100);
  return { total: v.monthlyAmount, buy, reserve: round2(v.monthlyAmount - buy) };
}

// Spread each stock's months evenly through the cycle: the most-bought stock takes evenly spaced slots first,
// the next one spreads over the slots left, and so on (QQQM×3, SPYM×2, DBS×1 → QQQM SPYM QQQM SPYM QQQM DBS)
export function buildRotation(holdings: InvestHolding[]): string[] {
  const list = holdings.filter(h => h.timesPerCycle > 0)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.timesPerCycle - a.h.timesPerCycle || a.i - b.i)
    .map(x => x.h);
  const total = list.reduce((s, h) => s + h.timesPerCycle, 0);
  const order: string[] = new Array(total);
  let free = Array.from({ length: total }, (_, i) => i);
  for (const h of list) {
    const picks = Array.from({ length: h.timesPerCycle }, (_, k) => free[Math.floor(k * free.length / h.timesPerCycle)]);
    picks.forEach(slot => { order[slot] = h.symbol; });
    free = free.filter(slot => !picks.includes(slot));
  }
  return order;
}

export function symbolForMonth(plan: InvestmentPlan, month: string): string | null {
  const rotation = buildRotation(plan.holdings);
  if (rotation.length === 0 || month < plan.startMonth) return null;
  const n = monthsBetween(plan.rotationAnchor, month);
  return rotation[((n % rotation.length) + rotation.length) % rotation.length];
}

export const holdingOf = (plan: InvestmentPlan, symbol: string): InvestHolding | undefined =>
  plan.holdings.find(h => h.symbol.toUpperCase() === symbol.toUpperCase());

// ── Reserve ─────────────────────────────────────────────────────────────────

// Deposits arrive on the 1st of every plan month up to and including `month`
export function reserveDeposits(plan: InvestmentPlan, month: string): number {
  let sum = 0;
  for (let m = plan.startMonth; m <= month; m = addMonths(m, 1)) sum += monthlySplit(plan, m).reserve;
  return round2(sum);
}

export function reserveBalance(plan: InvestmentPlan, events: InvestEvent[], month: string): number {
  let balance = reserveDeposits(plan, month);
  for (const e of events) {
    if (e.type === 'reserve_use') balance -= e.amount;
    if (e.type === 'reserve_adjust') balance += e.amount;
  }
  return round2(balance);
}

// Month the reserve was last used, or the plan start if never
export function lastReserveUseMonth(plan: InvestmentPlan, events: InvestEvent[]): string {
  const uses = events.filter(e => e.type === 'reserve_use').map(e => e.month).sort();
  return uses.length ? uses[uses.length - 1] : plan.startMonth;
}

// Two tiers: 10% → half, 20% → the rest. Three tiers: 10% → a third, 20% → half of what is left, 30% → the rest.
export function tierRules(mode: 2 | 3): { dropPct: number; fraction: number }[] {
  return mode === 2
    ? [{ dropPct: 10, fraction: 1 / 2 }, { dropPct: 20, fraction: 1 }]
    : [{ dropPct: 10, fraction: 1 / 3 }, { dropPct: 20, fraction: 1 / 2 }, { dropPct: 30, fraction: 1 }];
}

export const tierMode = (plan: InvestmentPlan, balance: number): 2 | 3 => (balance >= plan.threeTierFrom ? 3 : 2);

export const tierPrice = (refHigh: number, dropPct: number): number => round2(refHigh * (1 - dropPct / 100));

// ── Month summary ───────────────────────────────────────────────────────────

export type MonthStatus = 'pending' | 'done' | 'skipped';

export interface MonthSummary {
  month: string;
  symbol: string | null;
  buyAmount: number;
  reserveDeposit: number;
  status: MonthStatus;
  boughtAmount: number;
  releaseAmount: number;   // extra from the reserve this month while a release runs
  releaseSymbol: string | null;
  releaseDone: boolean;
}

export function releaseActiveIn(plan: InvestmentPlan, release: ReleaseState | null, month: string): boolean {
  if (!release) return false;
  const n = monthsBetween(release.startMonth, month);
  return n >= 0 && n < plan.releaseMonths;
}

// Release money goes with the month's stock when the reserve may buy it, otherwise to the main reserve stock
export function releaseSymbolFor(plan: InvestmentPlan, month: string): string | null {
  const monthSymbol = symbolForMonth(plan, month);
  const h = monthSymbol ? holdingOf(plan, monthSymbol) : undefined;
  if (h?.useReserve) return h.symbol;
  const reserveHoldings = plan.holdings.filter(x => x.useReserve).sort((a, b) => b.timesPerCycle - a.timesPerCycle);
  return reserveHoldings[0]?.symbol ?? null;
}

export function monthSummary(plan: InvestmentPlan, events: InvestEvent[], release: ReleaseState | null, month: string): MonthSummary {
  const split = monthlySplit(plan, month);
  const mine = events.filter(e => e.month === month);
  const buys = mine.filter(e => e.type === 'monthly_buy');
  const skipped = mine.some(e => e.type === 'skip');
  const active = releaseActiveIn(plan, release, month);
  return {
    month,
    symbol: symbolForMonth(plan, month),
    buyAmount: split.buy,
    reserveDeposit: split.reserve,
    status: buys.length ? 'done' : skipped ? 'skipped' : 'pending',
    boughtAmount: round2(buys.reduce((s, e) => s + e.amount, 0)),
    releaseAmount: active && release ? release.perMonth : 0,
    releaseSymbol: active ? releaseSymbolFor(plan, month) : null,
    releaseDone: mine.some(e => e.type === 'reserve_use' && e.reason === 'release'),
  };
}
