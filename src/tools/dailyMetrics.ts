import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, dateSchema, generateId, nowISO, jsonResult, mergePatch, addDays, todayStr,
  saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';

const METRICS = HEALTH_COLLECTIONS.dailyMetrics;
const SUPPLEMENTS = HEALTH_COLLECTIONS.supplements;

const metricsShape = {
  weightKg: z.number().positive().optional().describe('家里体重秤（最好早上空腹）'),
  waistCm: z.number().positive().optional(),
  steps: z.number().int().min(0).optional(),
  activeKcal: z.number().min(0).optional().describe('Apple Watch Move 活动卡路里（全天）'),
  exerciseMin: z.number().min(0).optional().describe('Apple Watch Exercise 分钟'),
  standHours: z.number().min(0).optional(),
  restingHeartRate: z.number().min(0).optional(),
  hrvMs: z.number().min(0).optional(),
  vo2Max: z.number().min(0).optional(),
  sleepHours: z.number().min(0).max(24).optional(),
  systolicBp: z.number().min(0).optional(),
  diastolicBp: z.number().min(0).optional(),
  notes: z.string().optional(),
};

const metricsObject = z.object(metricsShape);
export type DailyMetrics = z.infer<typeof metricsObject> & { id: string; date: string; updatedAt: string };

export type SupplementLog = { id: string; date: string; name: string; dose?: string; time?: string; notes?: string; createdAt: string };

export async function listDailyMetrics(startDate?: string, endDate?: string): Promise<DailyMetrics[]> {
  const m = await listHealthDocs<DailyMetrics>(METRICS, startDate, endDate);
  return m.sort((a, b) => b.date.localeCompare(a.date));
}

export function registerDailyMetricsTools(server: McpServer): void {

  server.tool(
    'log_daily_metrics',
    '记录某一天的日常身体数据：体重、腰围、步数、全天活动卡路里、运动分钟、静息心率、HRV、睡眠、血压。每天一份，重复调用会合并（只覆盖这次传入的字段）。',
    { date: dateSchema.optional().describe('默认今天'), ...metricsShape },
    async ({ date, ...fields }) => {
      const d = date ?? todayStr();
      const existing = await getHealthDoc<DailyMetrics>(METRICS, d);
      const merged = mergePatch((existing ?? { id: d, date: d }) as Record<string, unknown>, fields) as DailyMetrics;
      merged.updatedAt = nowISO();
      await saveHealthDoc(METRICS, d, merged as Record<string, unknown>);
      return jsonResult({ success: true, metrics: merged });
    }
  );

  server.tool(
    'get_daily_metrics',
    '获取日常身体数据（体重、步数、睡眠、心率等），默认最近 30 天，新到旧。',
    { startDate: dateSchema.optional(), endDate: dateSchema.optional() },
    async ({ startDate, endDate }) => {
      const end = endDate ?? todayStr();
      const start = startDate ?? addDays(end, -29);
      const metrics = await listDailyMetrics(start, end);
      return jsonResult({ startDate: start, endDate: end, count: metrics.length, metrics });
    }
  );

  server.tool(
    'delete_daily_metrics',
    '删除某一天的日常身体数据，或只清除其中几个字段（传 fields）。',
    { date: dateSchema, fields: z.array(z.enum(Object.keys(metricsShape) as [string, ...string[]])).optional() },
    async ({ date, fields }) => {
      if (!fields?.length) return jsonResult({ success: await deleteHealthDoc(METRICS, date) });
      const existing = await getHealthDoc<DailyMetrics>(METRICS, date);
      if (!existing) return jsonResult({ success: false, error: `No metrics for ${date}` });
      const updated = mergePatch(existing as Record<string, unknown>, Object.fromEntries(fields.map(f => [f, null]))) as DailyMetrics;
      updated.updatedAt = nowISO();
      await saveHealthDoc(METRICS, date, updated as Record<string, unknown>);
      return jsonResult({ success: true, metrics: updated });
    }
  );

  server.tool(
    'log_supplement',
    '记录服用的补充品，如蛋白粉、鱼油、维他命 D、肌酸。蛋白粉的营养应另外用 log_meal 记录。',
    {
      date: dateSchema.optional().describe('默认今天'),
      name: z.string(),
      dose: z.string().optional().describe('如「1 勺 30g」「1000 IU」'),
      time: z.string().optional().describe('HH:mm'),
      notes: z.string().optional(),
    },
    async ({ date, ...rest }) => {
      const id = generateId('supp');
      const log: SupplementLog = { ...rest, id, date: date ?? todayStr(), createdAt: nowISO() };
      await saveHealthDoc(SUPPLEMENTS, id, log as unknown as Record<string, unknown>);
      return jsonResult({ success: true, supplement: log });
    }
  );

  server.tool(
    'get_supplements',
    '获取补充品记录，默认最近 30 天。',
    { startDate: dateSchema.optional(), endDate: dateSchema.optional() },
    async ({ startDate, endDate }) => {
      const end = endDate ?? todayStr();
      const start = startDate ?? addDays(end, -29);
      const logs = await listHealthDocs<SupplementLog>(SUPPLEMENTS, start, end);
      return jsonResult({ startDate: start, endDate: end, count: logs.length, supplements: logs });
    }
  );

  server.tool(
    'delete_supplement',
    '删除一条补充品记录。',
    { id: z.string() },
    async ({ id }) => jsonResult({ success: await deleteHealthDoc(SUPPLEMENTS, id) })
  );
}
