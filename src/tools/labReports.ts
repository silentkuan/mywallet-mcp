import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, dateSchema, generateId, nowISO, jsonResult, mergePatch,
  saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';

const COLLECTION = HEALTH_COLLECTIONS.labReports;

// Canonical codes keep the same test comparable across labs and over time.
export const LAB_CODES: Record<string, { name: string; category: string }> = {
  TC: { name: 'Total cholesterol', category: 'lipid' },
  LDL: { name: 'LDL cholesterol', category: 'lipid' },
  HDL: { name: 'HDL cholesterol', category: 'lipid' },
  TG: { name: 'Triglycerides', category: 'lipid' },
  NON_HDL: { name: 'Non-HDL cholesterol', category: 'lipid' },
  TC_HDL_RATIO: { name: 'TC / HDL ratio', category: 'lipid' },
  FBG: { name: 'Fasting glucose', category: 'glucose' },
  HBA1C: { name: 'HbA1c', category: 'glucose' },
  ALT: { name: 'ALT', category: 'liver' },
  AST: { name: 'AST', category: 'liver' },
  GGT: { name: 'GGT', category: 'liver' },
  ALP: { name: 'ALP', category: 'liver' },
  BILI: { name: 'Total bilirubin', category: 'liver' },
  ALB: { name: 'Albumin', category: 'liver' },
  CREAT: { name: 'Creatinine', category: 'kidney' },
  EGFR: { name: 'eGFR', category: 'kidney' },
  UREA: { name: 'Urea', category: 'kidney' },
  URIC: { name: 'Uric acid', category: 'kidney' },
  HB: { name: 'Haemoglobin', category: 'blood' },
  WBC: { name: 'White blood cells', category: 'blood' },
  PLT: { name: 'Platelets', category: 'blood' },
  TSH: { name: 'TSH', category: 'thyroid' },
  VITD: { name: 'Vitamin D (25-OH)', category: 'vitamin' },
  B12: { name: 'Vitamin B12', category: 'vitamin' },
  FERRITIN: { name: 'Ferritin', category: 'vitamin' },
  CRP: { name: 'CRP / hs-CRP', category: 'inflammation' },
  SBP: { name: 'Systolic blood pressure', category: 'vitals' },
  DBP: { name: 'Diastolic blood pressure', category: 'vitals' },
};

const itemSchema = z.object({
  code: z.string().describe(`标准代码，尽量用：${Object.keys(LAB_CODES).join(', ')}；不在列表里就用简短的大写英文代码`),
  name: z.string().describe('报告上的项目名称'),
  category: z.enum(['lipid', 'glucose', 'liver', 'kidney', 'blood', 'thyroid', 'vitamin', 'inflammation', 'vitals', 'urine', 'other']).optional(),
  value: z.number(),
  unit: z.string().describe('照报告原样，如 mmol/L、mg/dL、%'),
  refLow: z.number().optional().describe('参考范围下限'),
  refHigh: z.number().optional().describe('参考范围上限'),
  flag: z.enum(['low', 'normal', 'high', 'borderline']).optional().describe('报告标注的结果；不填就按参考范围自动判断'),
});

const reportShape = {
  date: dateSchema.describe('采血 / 检测日期'),
  provider: z.string().optional().describe('化验所 / 诊所'),
  fasting: z.boolean().optional(),
  items: z.array(itemSchema).min(1),
  doctorComments: z.string().optional(),
  notes: z.string().optional(),
};

type LabItem = z.infer<typeof itemSchema>;
export type LabReport = { id: string; date: string; provider?: string; fasting?: boolean; items: LabItem[]; doctorComments?: string; notes?: string; createdAt: string; updatedAt?: string };

function normalizeItem(item: LabItem): LabItem {
  const known = LAB_CODES[item.code.toUpperCase()];
  const code = item.code.toUpperCase();
  let flag = item.flag;
  if (!flag && (item.refLow !== undefined || item.refHigh !== undefined)) {
    if (item.refLow !== undefined && item.value < item.refLow) flag = 'low';
    else if (item.refHigh !== undefined && item.value > item.refHigh) flag = 'high';
    else flag = 'normal';
  }
  return { ...item, code, category: item.category ?? (known?.category as LabItem['category']) ?? 'other', flag };
}

export async function listLabReports(): Promise<LabReport[]> {
  const reports = await listHealthDocs<LabReport>(COLLECTION);
  return reports.sort((a, b) => b.date.localeCompare(a.date));
}

// Latest value of each code with its previous value, for trend summaries
export function latestLabValues(reports: LabReport[]) {
  const byCode: Record<string, { code: string; name: string; unit: string; latest: { date: string; value: number; flag?: string }; previous?: { date: string; value: number } }> = {};
  for (const r of [...reports].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const item of r.items) {
      const entry = byCode[item.code];
      if (!entry) byCode[item.code] = { code: item.code, name: item.name, unit: item.unit, latest: { date: r.date, value: item.value, flag: item.flag } };
      else if (!entry.previous && entry.unit === item.unit) entry.previous = { date: r.date, value: item.value };
    }
  }
  return Object.values(byCode);
}

export function registerLabReportTools(server: McpServer): void {

  server.tool(
    'add_lab_report',
    '记录一份验血 / 化验报告（血脂、血糖、肝肾功能、血常规等），也可用于血压。每个项目要有数值、单位和参考范围。单位照报告原样；同一项目尽量和之前的报告用同一单位，方便看趋势。写入前先列给用户确认。',
    reportShape,
    async (input) => {
      const id = generateId('lab');
      const report: LabReport = { ...input, items: input.items.map(normalizeItem), id, createdAt: nowISO() };
      await saveHealthDoc(COLLECTION, id, report as unknown as Record<string, unknown>);
      return jsonResult({ success: true, report });
    }
  );

  server.tool(
    'get_lab_reports',
    '获取验血报告。可按日期或项目代码过滤（例如 codes=["LDL","HDL","TC","TG"] 看血脂趋势）。同时返回每个项目的最新值和上一次的值。',
    {
      startDate: dateSchema.optional(),
      endDate: dateSchema.optional(),
      codes: z.array(z.string()).optional(),
    },
    async ({ startDate, endDate, codes }) => {
      const wanted = codes?.map(c => c.toUpperCase());
      const reports = (await listLabReports())
        .filter(r => (!startDate || r.date >= startDate) && (!endDate || r.date <= endDate))
        .map(r => wanted ? { ...r, items: r.items.filter(i => wanted.includes(i.code)) } : r)
        .filter(r => r.items.length > 0);
      return jsonResult({ count: reports.length, reports, latestValues: latestLabValues(reports) });
    }
  );

  server.tool(
    'update_lab_report',
    '修改一份验血报告。传 items 会整份替换项目列表。',
    {
      id: z.string(),
      date: dateSchema.optional(),
      provider: z.string().nullable().optional(),
      fasting: z.boolean().nullable().optional(),
      items: z.array(itemSchema).min(1).optional(),
      doctorComments: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    async ({ id, items, ...patch }) => {
      const existing = await getHealthDoc<LabReport>(COLLECTION, id);
      if (!existing) return jsonResult({ success: false, error: `Lab report ${id} not found` });
      const updated = mergePatch(existing as unknown as Record<string, unknown>, patch) as unknown as LabReport;
      if (items) updated.items = items.map(normalizeItem);
      updated.updatedAt = nowISO();
      await saveHealthDoc(COLLECTION, id, updated as unknown as Record<string, unknown>);
      return jsonResult({ success: true, report: updated });
    }
  );

  server.tool(
    'delete_lab_report',
    '删除一份验血报告。',
    { id: z.string() },
    async ({ id }) => jsonResult({ success: await deleteHealthDoc(COLLECTION, id) })
  );
}
