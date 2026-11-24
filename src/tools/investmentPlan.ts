import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, upsertDoc } from '../firestore.js';
import { StockTransaction, StockMarket, StockAction, Currency } from '../types.js';
import {
  InvestmentPlan, InvestEvent, InvestHolding, defaultPlan, withAmount, versionFor, buildRotation, monthSummary, reserveBalance,
  tierMode, tierRules, tierPrice, holdingOf, addMonths, monthOf, sgToday, round2,
} from '../investPlan.js';
import { getPlan, savePlan, getState, getEvents, getAlerts, saveEvent, deleteEvent, saveAlert } from '../investStore.js';
import { runInvestmentCheck } from '../pullbackChecker.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const holdingSchema = z.object({
  symbol: z.string().min(1),
  market: z.enum(['US', 'SG', 'MY']),
  currency: z.enum(['USD', 'SGD', 'MYR']).optional().describe('Trading currency; defaults from the market'),
  timesPerCycle: z.number().int().min(1).max(12).describe('Months per rotation cycle this stock is bought'),
  useReserve: z.boolean().describe('Pullback reserve may be spent on this stock'),
});

const marketCurrency: Record<string, string> = { US: 'USD', SG: 'SGD', MY: 'MYR' };

async function requirePlan(): Promise<InvestmentPlan> {
  const plan = await getPlan();
  if (!plan) throw new Error('No investment plan yet — create one with set_investment_plan');
  return plan;
}

// Everything the web card shows, for the current or a given month
async function overview(month: string) {
  const plan = await requirePlan();
  const [events, alerts, state] = await Promise.all([getEvents(), getAlerts(), getState()]);
  const balance = reserveBalance(plan, events, month);
  const mode = tierMode(plan, balance);
  return {
    plan,
    rotation: buildRotation(plan.holdings),
    month: monthSummary(plan, events, state.release, month),
    upcoming: [1, 2, 3, 4, 5].map(n => monthSummary(plan, events, state.release, addMonths(month, n))).map(s => ({ month: s.month, symbol: s.symbol, buyAmount: s.buyAmount })),
    reserve: {
      balance,
      mode: `${mode} tiers`,
      tiers: tierRules(mode).map(r => ({ dropPct: r.dropPct, use: r.fraction === 1 ? 'all that is left' : `${Math.round(r.fraction * 100)}% of what is left` })),
      release: state.release,
    },
    watch: Object.values(state.watch).map(w => ({
      ...w,
      nextTierPrice: w.episode
        ? (tierRules(w.episode.mode).map((r, i) => ({ ...r, tier: i + 1 })).find(r => !w.episode!.firedTiers.includes(r.tier)) ?? null)
        : { dropPct: 10, price: tierPrice(w.high52, 10) },
    })),
    lastCheckAt: state.lastCheckAt ?? null,
    openAlerts: alerts.filter(a => a.status === 'open'),
    recentEvents: [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
  };
}

export function registerInvestmentPlanTools(server: McpServer): void {

  server.tool(
    'get_investment_plan',
    '每月投资计划总览：本月要买哪只股票和金额、回调资金余额与档位、QQQM/SPYM 等离 52 周高点跌了多少、未处理的回调提醒、最近记录。用户问“这个月买什么”“回调资金还有多少”“现在跌了多少”时先调用。',
    { month: MONTH.optional().describe('YYYY-MM, default this month (Singapore)') },
    async ({ month }) => json(await overview(month ?? monthOf(sgToday()))),
  );

  server.tool(
    'set_investment_plan',
    '建立或修改每月投资计划。改金额时用 effectiveMonth 决定从哪个月开始生效（之前的月份不变）。改股票清单会让轮流顺序从 effectiveMonth 重新开始。没有计划时会用默认值建立（SGD 1500、70/30、QQQM×3、SPYM×2、DBS×1）。',
    {
      monthlyAmount: z.number().positive().optional().describe('每月总投资金额（计划币种）'),
      buyPct: z.number().min(0).max(100).optional().describe('定投比例 %，其余进回调资金（默认 70）'),
      effectiveMonth: MONTH.optional().describe('新金额/新股票从哪个月开始，默认本月'),
      startMonth: MONTH.optional().describe('只在建立计划时使用：计划第一个月'),
      currency: z.enum(['SGD', 'USD', 'MYR']).optional().describe('只在建立计划时使用'),
      holdings: z.array(holdingSchema).min(1).optional().describe('完整的股票清单（会取代旧清单）'),
      threeTierFrom: z.number().min(0).optional().describe('回调资金达到这个数用三档，否则两档（默认 5000）'),
      idleMonths: z.number().int().min(1).optional().describe('回调资金多久没用就开始释放（默认 12）'),
      releaseMonths: z.number().int().min(1).optional().describe('分几个月释放（默认 6）'),
      telegramMonthly: z.boolean().optional().describe('每月 1 号 Telegram 提醒本月要买什么'),
      telegramPullback: z.boolean().optional().describe('回调触发时 Telegram 提醒'),
    },
    async (input) => {
      const thisMonth = monthOf(sgToday());
      const existing = await getPlan();
      const effective = input.effectiveMonth ?? thisMonth;
      let plan: InvestmentPlan = existing ?? defaultPlan(input.startMonth ?? thisMonth);
      if (!existing && input.currency) plan = { ...plan, currency: input.currency };

      if (input.monthlyAmount !== undefined || input.buyPct !== undefined) {
        const from = existing ? effective : plan.startMonth;
        const current = versionFor(plan, from)!;
        plan = withAmount(plan, from, input.monthlyAmount ?? current.monthlyAmount, input.buyPct ?? current.buyPct);
      }
      if (input.holdings) {
        const holdings: InvestHolding[] = input.holdings.map(h => ({
          symbol: h.symbol.toUpperCase(), market: h.market, currency: h.currency ?? marketCurrency[h.market],
          timesPerCycle: h.timesPerCycle, useReserve: h.useReserve,
        }));
        plan = { ...plan, holdings, rotationAnchor: existing ? effective : plan.startMonth };
      }
      for (const key of ['threeTierFrom', 'idleMonths', 'releaseMonths', 'telegramMonthly', 'telegramPullback'] as const) {
        if (input[key] !== undefined) plan = { ...plan, [key]: input[key] };
      }
      plan = { ...plan, updatedAt: new Date().toISOString() };
      await savePlan(plan);
      return json({ success: true, created: !existing, plan, rotation: buildRotation(plan.holdings) });
    },
  );

  server.tool(
    'record_plan_purchase',
    '记录按计划买入的股票：同时写入股票交易（stocks）和计划记录。monthlyAmount = 算作本月定投的金额，reserveAmount = 用回调资金的金额（计划币种，例如 SGD），两者可以同时有（释放月份）。用户说“我买了 QQQM 4 股 @268”时：先用 get_investment_plan 看本月和未处理提醒，金额换算成计划币种后再写入。',
    {
      symbol: z.string().min(1),
      date: DATE.describe('交易日期'),
      quantity: z.number().positive(),
      pricePerShare: z.number().positive().describe('每股价格（交易币种）'),
      fees: z.number().min(0).optional().describe('手续费（交易币种）'),
      market: z.enum(['US', 'SG', 'MY']).optional().describe('默认取计划里的设定'),
      currency: z.enum(['USD', 'SGD', 'MYR']).optional().describe('交易币种，默认取计划里的设定'),
      monthlyAmount: z.number().min(0).optional().describe('算作本月定投的金额（计划币种）'),
      reserveAmount: z.number().min(0).optional().describe('用掉的回调资金（计划币种）'),
      month: MONTH.optional().describe('算在哪个计划月份，默认交易日期的月份'),
      alertId: z.string().optional().describe('对应的回调/释放提醒 id，记录后会标记为已处理'),
    },
    async (input) => {
      const plan = await requirePlan();
      const monthlyPart = input.monthlyAmount ?? 0;
      const reservePart = input.reserveAmount ?? 0;
      if (monthlyPart <= 0 && reservePart <= 0) throw new Error('Give monthlyAmount and/or reserveAmount (plan currency)');

      const symbol = input.symbol.toUpperCase();
      const holding = holdingOf(plan, symbol);
      const market = input.market ?? holding?.market;
      if (!market) throw new Error(`${symbol} is not in the plan — pass market and currency`);
      const currency = input.currency ?? holding?.currency ?? marketCurrency[market];
      const month = input.month ?? monthOf(input.date);
      const createdAt = new Date().toISOString();

      const stockTxId = newId('stk');
      const tx: StockTransaction = {
        id: stockTxId, symbol, market: market as StockMarket, action: StockAction.BUY, date: input.date,
        quantity: input.quantity, pricePerShare: input.pricePerShare, currency: currency as Currency,
        totalAmount: round2(input.quantity * input.pricePerShare), fees: input.fees ?? 0,
      };
      await upsertDoc(collectionPath('stocks'), stockTxId, tx as unknown as Record<string, unknown>);

      const alerts = input.alertId ? await getAlerts() : [];
      const alert = alerts.find(a => a.id === input.alertId);
      const saved: InvestEvent[] = [];
      if (monthlyPart > 0) {
        saved.push({ id: newId('inv'), type: 'monthly_buy', date: input.date, month, symbol, amount: round2(monthlyPart), stockTxId, createdAt });
      }
      if (reservePart > 0) {
        saved.push({
          id: newId('inv'), type: 'reserve_use', date: input.date, month, symbol, amount: round2(reservePart), stockTxId,
          reason: alert?.kind === 'release' ? 'release' : alert ? 'tier' : 'manual', alertId: alert?.id, createdAt,
        });
      }
      for (const e of saved) await saveEvent(e);
      if (alert) await saveAlert({ ...alert, status: 'done' });

      const events = await getEvents();
      return json({ success: true, stockTransaction: tx, events: saved, reserveBalance: reserveBalance(plan, events, monthOf(sgToday())) });
    },
  );

  server.tool(
    'skip_plan_month',
    '把某个月标记为跳过（这个月不买）。回调资金照常累积。',
    { month: MONTH.optional().describe('默认本月'), note: z.string().optional() },
    async ({ month, note }) => {
      await requirePlan();
      const m = month ?? monthOf(sgToday());
      const e: InvestEvent = { id: newId('inv'), type: 'skip', date: sgToday(), month: m, amount: 0, note, createdAt: new Date().toISOString() };
      await saveEvent(e);
      return json({ success: true, event: e });
    },
  );

  server.tool(
    'adjust_reserve',
    '手动调整回调资金余额，例如计划开始前已经存好的钱（正数）或拿去做别的用途（负数）。',
    { amount: z.number().refine(n => n !== 0, 'amount must not be 0').describe('计划币种，正数加、负数减'), note: z.string().optional() },
    async ({ amount, note }) => {
      const plan = await requirePlan();
      const today = sgToday();
      const e: InvestEvent = { id: newId('inv'), type: 'reserve_adjust', date: today, month: monthOf(today), amount: round2(amount), note, createdAt: new Date().toISOString() };
      await saveEvent(e);
      const events = await getEvents();
      return json({ success: true, event: e, reserveBalance: reserveBalance(plan, events, monthOf(today)) });
    },
  );

  server.tool(
    'delete_investment_event',
    '删除一笔计划记录（买入、跳过、回调资金使用或调整）。不会删除对应的股票交易；要删股票交易请另外用 delete_stock_transaction。',
    { id: z.string().min(1) },
    async ({ id }) => {
      const events = await getEvents();
      const e = events.find(x => x.id === id);
      if (!e) throw new Error(`Event ${id} not found`);
      await deleteEvent(id);
      if (e.alertId) {
        const alert = (await getAlerts()).find(a => a.id === e.alertId);
        if (alert && alert.status === 'done') await saveAlert({ ...alert, status: 'open' });
      }
      return json({ success: true, deleted: e });
    },
  );

  server.tool(
    'dismiss_investment_alert',
    '忽略一个回调/释放提醒（不买）。忽略后它建议的金额不再被预留。',
    { id: z.string().min(1) },
    async ({ id }) => {
      const alert = (await getAlerts()).find(a => a.id === id);
      if (!alert) throw new Error(`Alert ${id} not found`);
      await saveAlert({ ...alert, status: 'dismissed' });
      return json({ success: true });
    },
  );

  server.tool(
    'check_pullback_now',
    '立刻检查一次回调（平时每天新加坡时间早上自动检查）。notify=true 时新提醒也会发 Telegram。',
    { notify: z.boolean().optional().describe('默认 false') },
    async ({ notify }) => json(await runInvestmentCheck({ notify: notify ?? false, scheduled: false })),
  );
}
