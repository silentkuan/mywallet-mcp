import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../firebase.js';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById, parsePayload, preparePayload } from '../firestore.js';
import {
  PeriodRecord, NoodleRecord, NoBrushRecord, HerState, forecastPeriod, countStats, brushStreak,
  PREP_TIPS_ZH, PERIOD_TIPS_ZH,
} from '../herLogic.js';
import { sgToday } from '../investPlan.js';

export const HER_COLLECTIONS = { period: 'herPeriods', noodle: 'herNoodles', nobrush: 'herNoBrush' } as const;

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

async function list<T>(kind: keyof typeof HER_COLLECTIONS): Promise<T[]> {
  const items = await fetchCollection(collectionPath(HER_COLLECTIONS[kind]));
  return items.filter(i => !i['_decryptionFailed']) as unknown as T[];
}
export const listPeriods = () => list<PeriodRecord>('period');
export const listNoodles = () => list<NoodleRecord>('noodle');
export const listNoBrush = () => list<NoBrushRecord>('nobrush');
const save = (kind: keyof typeof HER_COLLECTIONS, item: { id: string }) =>
  upsertDoc(collectionPath(HER_COLLECTIONS[kind]), item.id, item as unknown as Record<string, unknown>);

export async function getHerState(): Promise<HerState> {
  const snap = await db.collection(collectionPath('herMeta')).doc('state').get();
  if (!snap.exists) return { id: 'state' };
  const data = parsePayload({ id: snap.id, ...snap.data() });
  return data['_decryptionFailed'] ? { id: 'state' } : (data as unknown as HerState);
}
export async function saveHerState(state: HerState): Promise<void> {
  await db.collection(collectionPath('herMeta')).doc('state').set(preparePayload({ ...state, id: 'state' } as Record<string, unknown>, ['id']));
}

export async function herOverview(today = sgToday()) {
  const [periods, noodles, noBrush] = await Promise.all([listPeriods(), listNoodles(), listNoBrush()]);
  const forecast = forecastPeriod(periods, today);
  return {
    today,
    period: {
      forecast,
      tips: forecast.phase === 'period' ? PERIOD_TIPS_ZH : forecast.phase === 'prep' || forecast.phase === 'due' ? PREP_TIPS_ZH : [],
      recent: [...periods].sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, 6),
    },
    noodles: { ...countStats(noodles, today), recent: [...noodles].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10) },
    noBrush: { ...countStats(noBrush, today), brushStreak: brushStreak(noBrush, today), recent: [...noBrush].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10) },
  };
}

export function registerHerTools(server: McpServer): void {

  server.tool(
    'her_overview',
    '「她」（女友）总览：月经预测（下次日期、还有几天、是否在准备期/经期、准备事项）、这周/这个月吃了几次泡面、距离上次多少天、连续几晚有刷牙。问到她的月经、泡面、刷牙时先调用。',
    {},
    async () => json(await herOverview()),
  );

  server.tool(
    'her_log_period',
    '记录她的月经开始（同一个开始日期再记一次会更新那笔）。pain 0–5。',
    {
      startDate: DATE.optional().describe('开始日期，默认今天（新加坡）'),
      endDate: DATE.optional().describe('结束日期（知道的话）'),
      pain: z.number().int().min(0).max(5).optional().describe('经痛程度 0–5'),
      mood: z.string().optional(),
      symptoms: z.array(z.string()).optional().describe('例如 腹痛、腰酸、头痛、长痘'),
      note: z.string().optional(),
    },
    async (input) => {
      const startDate = input.startDate ?? sgToday();
      const existing = (await listPeriods()).find(p => p.startDate === startDate);
      const record: PeriodRecord = {
        ...(existing ?? { id: newId('per'), startDate, createdAt: new Date().toISOString() }),
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        startDate,
      } as PeriodRecord;
      if (record.endDate && record.endDate < record.startDate) throw new Error('endDate is before startDate');
      await save('period', record);
      return json({ success: true, updated: !!existing, record, forecast: forecastPeriod(await listPeriods(), sgToday()) });
    },
  );

  server.tool(
    'her_end_period',
    '记录她这次月经结束（写在最近一笔还没有结束日期的记录上）。',
    { endDate: DATE.optional().describe('默认今天') },
    async ({ endDate }) => {
      const end = endDate ?? sgToday();
      const open = (await listPeriods()).filter(p => !p.endDate && p.startDate <= end).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
      if (!open) throw new Error('No period without an end date — log the start first with her_log_period');
      const record = { ...open, endDate: end };
      await save('period', record);
      return json({ success: true, record });
    },
  );

  server.tool(
    'her_log_noodle',
    '记录她吃了一次泡面 / Maggi 面 / 辣面。',
    {
      date: DATE.optional().describe('默认今天'),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:mm'),
      kind: z.enum(['maggi', 'instant', 'spicy', 'other']).optional().describe('maggi=Maggi 面, instant=泡面, spicy=辣面'),
      note: z.string().optional(),
    },
    async (input) => {
      const today = sgToday();
      const record: NoodleRecord = { id: newId('ndl'), date: input.date ?? today, time: input.time, kind: input.kind ?? 'instant', note: input.note, createdAt: new Date().toISOString() };
      await save('noodle', record);
      return json({ success: true, record, stats: countStats(await listNoodles(), today) });
    },
  );

  server.tool(
    'her_log_no_brush',
    '记录她有一晚没刷牙就睡觉。date 是那一晚的日期（默认昨晚）。',
    { date: DATE.optional().describe('那一晚的日期，默认昨天'), note: z.string().optional() },
    async ({ date, note }) => {
      const today = sgToday();
      const night = date ?? new Date(Date.parse(today) - 86400_000).toISOString().slice(0, 10);
      const existing = (await listNoBrush()).find(r => r.date === night);
      if (existing) return json({ success: true, alreadyLogged: true, record: existing });
      const record: NoBrushRecord = { id: newId('nb'), date: night, note, createdAt: new Date().toISOString() };
      await save('nobrush', record);
      const all = await listNoBrush();
      return json({ success: true, record, stats: countStats(all, today), brushStreak: brushStreak(all, today) });
    },
  );

  server.tool(
    'her_list',
    '列出她的记录（月经 / 泡面 / 没刷牙），最新的在前，可用来找要删除的 id。',
    { type: z.enum(['period', 'noodle', 'nobrush']), limit: z.number().int().min(1).max(100).optional() },
    async ({ type, limit }) => {
      const items = await list<{ id: string; date?: string; startDate?: string }>(type);
      items.sort((a, b) => String(b.startDate ?? b.date).localeCompare(String(a.startDate ?? a.date)));
      return json(items.slice(0, limit ?? 20));
    },
  );

  server.tool(
    'her_delete',
    '删除她的一笔记录（记错时用）。',
    { type: z.enum(['period', 'noodle', 'nobrush']), id: z.string().min(1) },
    async ({ type, id }) => {
      const items = await list<{ id: string }>(type);
      if (!items.some(i => i.id === id)) throw new Error(`${type} record ${id} not found`);
      await deleteDocById(collectionPath(HER_COLLECTIONS[type]), id);
      return json({ success: true });
    },
  );
}
