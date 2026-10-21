import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, dateSchema, generateId, nowISO, round, jsonResult, mergePatch,
  saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';

const COLLECTION = HEALTH_COLLECTIONS.bodyScans;

// Body composition metrics (InBody / Evolt 360 / Tanita style BIA scans).
const metricShape = {
  weightKg: z.number().positive().optional().describe('体重 kg'),
  bodyFatPct: z.number().min(0).max(100).optional().describe('体脂率 %'),
  bodyFatMassKg: z.number().min(0).optional().describe('体脂肪量 kg'),
  leanBodyMassKg: z.number().min(0).optional().describe('瘦体重 / 去脂体重 kg'),
  skeletalMuscleMassKg: z.number().min(0).optional().describe('骨骼肌 kg'),
  proteinKg: z.number().min(0).optional(),
  mineralKg: z.number().min(0).optional(),
  totalBodyWaterKg: z.number().min(0).optional(),
  subcutaneousFatKg: z.number().min(0).optional(),
  subcutaneousFatPct: z.number().min(0).optional(),
  visceralFatMassKg: z.number().min(0).optional(),
  visceralFatPct: z.number().min(0).optional(),
  visceralFatAreaCm2: z.number().min(0).optional(),
  visceralFatLevel: z.number().min(0).optional(),
  intracellularWaterKg: z.number().min(0).optional().describe('ICF kg'),
  intracellularWaterPct: z.number().min(0).optional().describe('ICF %'),
  extracellularWaterKg: z.number().min(0).optional().describe('ECF kg'),
  extracellularWaterPct: z.number().min(0).optional().describe('ECF %'),
  bmrKcal: z.number().min(0).optional().describe('基础代谢'),
  teeKcal: z.number().min(0).optional().describe('每日总消耗 TEE'),
  bioAge: z.number().min(0).optional(),
  bwiScore: z.number().min(0).optional().describe('Evolt BWI 分数（满分 10）'),
  waistCm: z.number().min(0).optional().describe('腰围 / 腹围 cm'),
  waistToHipRatio: z.number().min(0).optional(),
  bmi: z.number().min(0).optional(),
};

export const METRIC_KEYS = Object.keys(metricShape) as (keyof typeof metricShape)[];

const segmentSchema = z.object({
  leanKg: z.number().min(0).optional(),
  fatKg: z.number().min(0).optional(),
  leanRange: z.tuple([z.number(), z.number()]).optional().describe('[low, high] 参考范围'),
  fatRange: z.tuple([z.number(), z.number()]).optional(),
});

const scanShape = {
  date: dateSchema.describe('测量日期 YYYY-MM-DD'),
  time: z.string().optional().describe('测量时间 HH:mm（BIA 受进食和喝水影响，时间有助于比较）'),
  device: z.string().optional().describe('仪器，如 Evolt 360、InBody 570'),
  location: z.string().optional(),
  ...metricShape,
  ranges: z.record(z.string(), z.tuple([z.number(), z.number()])).optional()
    .describe('报告上印的参考范围，key 用上面的字段名，如 {"bodyFatPct":[15,20],"bodyFatMassKg":[8.8,13.2]}'),
  segments: z.object({
    leftArm: segmentSchema.optional(),
    rightArm: segmentSchema.optional(),
    torso: segmentSchema.optional(),
    leftLeg: segmentSchema.optional(),
    rightLeg: segmentSchema.optional(),
  }).optional().describe('分段分析（四肢 + 躯干）'),
  upperLowerBalance: z.enum(['balanced', 'unbalanced']).optional(),
  leftRightBalance: z.enum(['balanced', 'unbalanced']).optional(),
  recommendation: z.object({
    caloriesMin: z.number().optional(), caloriesMax: z.number().optional(),
    proteinMinG: z.number().optional(), proteinMaxG: z.number().optional(),
    carbsMinG: z.number().optional(), carbsMaxG: z.number().optional(),
    fatMinG: z.number().optional(), fatMaxG: z.number().optional(),
  }).optional().describe('报告给出的每日营养建议'),
  conditions: z.string().optional().describe('测量状态，如「空腹」「运动前」「饭后 2 小时」'),
  notes: z.string().optional(),
};

const scanObject = z.object(scanShape);
export type BodyScan = z.infer<typeof scanObject> & { id: string; createdAt: string; updatedAt?: string };

// Change between two scans for every metric present in both
export function scanDelta(newer: BodyScan, older: BodyScan) {
  const delta: Record<string, { from: number; to: number; change: number }> = {};
  for (const k of METRIC_KEYS) {
    const a = older[k], b = newer[k];
    if (typeof a === 'number' && typeof b === 'number') delta[k] = { from: a, to: b, change: round(b - a, 2) };
  }
  return { fromDate: older.date, toDate: newer.date, days: Math.round((Date.parse(newer.date) - Date.parse(older.date)) / 86400000), delta };
}

export async function listScans(startDate?: string, endDate?: string): Promise<BodyScan[]> {
  const scans = await listHealthDocs<BodyScan>(COLLECTION, startDate, endDate);
  return scans.sort((a, b) => `${b.date} ${b.time ?? ''}`.localeCompare(`${a.date} ${a.time ?? ''}`));
}

export function registerBodyScanTools(server: McpServer): void {

  server.tool(
    'add_body_scan',
    '记录一次身体成分检测（Evolt 360 / InBody 等）。从照片或 PDF 读取所有能看到的数字，包括参考范围、分段分析和营养建议。写入前先把读到的数字列给用户确认。',
    scanShape,
    async (input) => {
      const id = generateId('scan');
      const scan: BodyScan = { ...input, id, createdAt: nowISO() };
      await saveHealthDoc(COLLECTION, id, scan as Record<string, unknown>);
      const all = await listScans();
      const previous = all[all.findIndex(s => s.id === id) + 1];
      return jsonResult({ success: true, scan, changeSincePrevious: previous ? scanDelta(scan, previous) : null });
    }
  );

  server.tool(
    'get_body_scans',
    '获取身体成分检测记录（新到旧），附带每一次和上一次的变化。用于分析体脂、肌肉、腰围的趋势。',
    {
      startDate: dateSchema.optional(),
      endDate: dateSchema.optional(),
      limit: z.number().int().positive().optional().describe('最多返回几次，默认全部'),
    },
    async ({ startDate, endDate, limit }) => {
      const all = await listScans();
      const inRange = all.filter(s => (!startDate || s.date >= startDate) && (!endDate || s.date <= endDate));
      const picked = limit ? inRange.slice(0, limit) : inRange;
      const result = picked.map(s => {
        const idx = all.findIndex(x => x.id === s.id);
        const prev = all[idx + 1];
        return { ...s, changeSincePrevious: prev ? scanDelta(s, prev) : null };
      });
      const first = all[all.length - 1], latest = all[0];
      return jsonResult({
        count: result.length,
        scans: result,
        overallChange: first && latest && first.id !== latest.id ? scanDelta(latest, first) : null,
      });
    }
  );

  server.tool(
    'update_body_scan',
    '修改一次身体检测记录。只传要改的字段；传 null 清除字段。',
    {
      id: z.string(),
      ...Object.fromEntries(Object.entries(scanShape).map(([k, s]) => [k, (s as z.ZodTypeAny).nullable().optional()])),
    },
    async ({ id, ...patch }) => {
      const existing = await getHealthDoc<BodyScan>(COLLECTION, id);
      if (!existing) return jsonResult({ success: false, error: `Body scan ${id} not found` });
      const updated = mergePatch(existing as Record<string, unknown>, patch) as BodyScan;
      updated.updatedAt = nowISO();
      await saveHealthDoc(COLLECTION, id, updated as Record<string, unknown>);
      return jsonResult({ success: true, scan: updated });
    }
  );

  server.tool(
    'delete_body_scan',
    '删除一次身体检测记录。',
    { id: z.string() },
    async ({ id }) => jsonResult({ success: await deleteHealthDoc(COLLECTION, id) })
  );
}
