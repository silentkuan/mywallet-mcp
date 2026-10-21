import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, NUTRIENTS, NUTRIENT_KEYS, NutrientKey, NutrientTotals, NutritionTargets, TargetStatus,
  dateSchema, generateId, nowISO, todayStr, addDays, round, jsonResult, mergePatch, emptyTotals, evaluate,
  optionalNutrientShape, saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';
import { loadHealthProfile, effectiveTargets } from './healthProfile.js';

const MEALS = HEALTH_COLLECTIONS.meals;
const WATER = HEALTH_COLLECTIONS.water;
const FOODS = HEALTH_COLLECTIONS.foods;

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'drink', 'supplement'] as const;

export type Meal = {
  id: string; date: string; time?: string; mealType: (typeof MEAL_TYPES)[number]; description: string;
  foodId?: string; servings?: number; estimated?: boolean; recordedAt: string; updatedAt?: string;
} & Partial<NutrientTotals>;

export type WaterLog = { id: string; date: string; amountMl: number; recordedAt: string; source?: string };

export type Food = {
  id: string; name: string; aliases?: string[]; serving: string; brand?: string; notes?: string;
  createdAt: string; updatedAt?: string;
} & Partial<NutrientTotals>;

const coreNutrientShape = {
  calories: z.number().min(0).describe('热量（千卡）'),
  proteinG: z.number().min(0).describe('蛋白质（克）'),
  fatG: z.number().min(0).describe('脂肪（克）'),
  carbsG: z.number().min(0).describe('碳水（克）'),
  sodiumMg: z.number().min(0).describe('钠（毫克）'),
};

// Meals logged from the finance page before this change only carried calories, with macros stored as 0.
// Treat those zeros as "not recorded" rather than "zero grams".
function isCaloriesOnly(m: Partial<NutrientTotals>): boolean {
  return (m.calories ?? 0) > 0 && !m.proteinG && !m.fatG && !m.carbsG;
}

function hasValue(m: Partial<NutrientTotals>, k: NutrientKey): boolean {
  return typeof m[k] === 'number' && !(k !== 'calories' && isCaloriesOnly(m));
}

function sumNutrients(meals: Partial<NutrientTotals>[]): { totals: NutrientTotals; recorded: Set<NutrientKey> } {
  const totals = emptyTotals();
  const recorded = new Set<NutrientKey>();
  for (const m of meals) for (const k of NUTRIENT_KEYS) if (hasValue(m, k)) { totals[k] += m[k]!; recorded.add(k); }
  for (const k of NUTRIENT_KEYS) totals[k] = round(totals[k], 1);
  return { totals, recorded };
}

// Fraction of meals that recorded each nutrient, so "0 g fiber" can be told apart
// from "fiber was never estimated".
function coverage(meals: Partial<NutrientTotals>[]): Record<NutrientKey, number> {
  return Object.fromEntries(NUTRIENT_KEYS.map(k => [
    k, meals.length ? round(meals.filter(m => hasValue(m, k)).length / meals.length, 2) : 0,
  ])) as Record<NutrientKey, number>;
}

function compare(totals: Partial<Record<string, number>>, targets: NutritionTargets, recorded: Set<string>) {
  const rows: Record<string, { value: number | null; unit: string; min?: number; max?: number; status: TargetStatus }> = {};
  for (const k of [...NUTRIENT_KEYS, 'waterMl'] as const) {
    const t = targets[k];
    const unit = k === 'waterMl' ? 'ml' : NUTRIENTS[k as NutrientKey].unit;
    if (!recorded.has(k)) { rows[k] = { value: null, unit, min: t?.min, max: t?.max, status: 'no_data' }; continue; }
    const value = totals[k] ?? 0;
    rows[k] = { value, unit, min: t?.min, max: t?.max, status: evaluate(value, t) };
  }
  return rows;
}

export async function listMeals(startDate?: string, endDate?: string): Promise<Meal[]> {
  const meals = await listHealthDocs<Meal>(MEALS, startDate, endDate);
  return meals.sort((a, b) => `${b.date} ${b.time ?? b.recordedAt}`.localeCompare(`${a.date} ${a.time ?? a.recordedAt}`));
}

// Per-day intake, averages over logged days, and status against targets
export async function nutritionSummary(startDate: string, endDate: string) {
  const [meals, water, profile] = await Promise.all([
    listMeals(startDate, endDate),
    listHealthDocs<WaterLog>(WATER, startDate, endDate),
    loadHealthProfile(),
  ]);
  const targets = effectiveTargets(profile);

  const days: Record<string, { meals: Meal[]; waterMl: number }> = {};
  for (const m of meals) (days[m.date] ??= { meals: [], waterMl: 0 }).meals.push(m);
  for (const w of water) (days[w.date] ??= { meals: [], waterMl: 0 }).waterMl += w.amountMl || 0;

  const daily = Object.entries(days)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, d]) => {
      const { totals, recorded } = sumNutrients(d.meals);
      const recordedKeys = new Set<string>(recorded);
      if (d.waterMl > 0) recordedKeys.add('waterMl');
      const dayTotals = { ...totals, waterMl: d.waterMl };
      return { date, mealCount: d.meals.length, totals: dayTotals, recorded: [...recordedKeys], vsTarget: compare(dayTotals, targets, recordedKeys) };
    });

  // Average each nutrient over the days that actually recorded it
  const loggedDays = daily.filter(d => d.mealCount > 0);
  const average: Record<string, number> = {};
  const averagedOver: Record<string, number> = {};
  for (const k of [...NUTRIENT_KEYS, 'waterMl'] as const) {
    const withData = daily.filter(d => d.recorded.includes(k));
    averagedOver[k] = withData.length;
    if (withData.length) average[k] = round(withData.reduce((s, d) => s + (d.totals[k] ?? 0), 0) / withData.length, 1);
  }
  const vsTarget = compare(average, targets, new Set(Object.keys(average)));

  // How many logged days each nutrient was out of range — "sodium high on 5 of 7 days"
  const outOfRange: Record<string, { low: number; high: number }> = {};
  for (const d of loggedDays) {
    for (const [k, row] of Object.entries(d.vsTarget)) {
      if (row.status === 'low' || row.status === 'high') (outOfRange[k] ??= { low: 0, high: 0 })[row.status]++;
    }
  }

  return {
    startDate, endDate,
    loggedDays: loggedDays.length,
    totalDays: Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1,
    averagePerLoggedDay: average,
    daysWithDataPerNutrient: averagedOver,
    vsTarget,
    shortfalls: Object.entries(vsTarget).filter(([, r]) => r.status === 'low').map(([k]) => k),
    excesses: Object.entries(vsTarget).filter(([, r]) => r.status === 'high').map(([k]) => k),
    daysOutOfRange: outOfRange,
    nutrientCoverage: coverage(meals),
    targets,
    daily,
  };
}

export function registerNutritionTools(server: McpServer): void {

  server.tool(
    'log_meal',
    '记录一餐。热量、蛋白质、脂肪、碳水、钠必填；饱和脂肪、纤维、糖、胆固醇、钾等也要尽量估算（降胆固醇要看饱和脂肪和纤维）。可传 foodId + servings 直接使用食物库的营养数据（显式传入的数值优先）。估算出来的数值设 estimated=true。',
    {
      date: dateSchema.describe('日期 YYYY-MM-DD'),
      time: z.string().optional().describe('HH:mm'),
      mealType: z.enum(MEAL_TYPES).describe('餐别'),
      description: z.string().min(1).describe('吃了什么，如「鸡胸肉沙拉 + 糙米饭」'),
      foodId: z.string().optional().describe('食物库 ID（来自 search_foods）'),
      servings: z.number().positive().optional().describe('份数，配合 foodId，默认 1'),
      estimated: z.boolean().optional().describe('营养数据是估算的（如从照片判断）'),
      calories: coreNutrientShape.calories.optional(),
      proteinG: coreNutrientShape.proteinG.optional(),
      fatG: coreNutrientShape.fatG.optional(),
      carbsG: coreNutrientShape.carbsG.optional(),
      sodiumMg: coreNutrientShape.sodiumMg.optional(),
      ...optionalNutrientShape,
    },
    async (input) => {
      const { foodId, servings, ...rest } = input;
      const nutrients: Partial<NutrientTotals> = {};
      if (foodId) {
        const food = await getHealthDoc<Food>(FOODS, foodId);
        if (!food) return jsonResult({ success: false, error: `Food ${foodId} not found in library` });
        const n = servings ?? 1;
        for (const k of NUTRIENT_KEYS) if (typeof food[k] === 'number') nutrients[k] = round(food[k]! * n, 1);
      }
      for (const k of NUTRIENT_KEYS) if (typeof rest[k] === 'number') nutrients[k] = rest[k];
      const missing = (['calories', 'proteinG', 'fatG', 'carbsG', 'sodiumMg'] as const).filter(k => typeof nutrients[k] !== 'number');
      if (missing.length) return jsonResult({ success: false, error: `Missing required nutrients: ${missing.join(', ')}` });

      const id = generateId('meal');
      const meal: Meal = {
        id, date: rest.date, time: rest.time, mealType: rest.mealType, description: rest.description,
        foodId, servings: foodId ? (servings ?? 1) : undefined, estimated: rest.estimated,
        ...nutrients, recordedAt: nowISO(),
      };
      await saveHealthDoc(MEALS, id, meal as Record<string, unknown>);
      const day = await nutritionSummary(rest.date, rest.date);
      return jsonResult({ success: true, meal, dayTotals: day.daily[0]?.totals, dayVsTarget: day.vsTarget });
    }
  );

  server.tool(
    'update_meal',
    '修改一餐记录。只传要改的字段；可选营养素传 null 可清除。',
    {
      id: z.string(),
      date: dateSchema.optional(),
      time: z.string().nullable().optional(),
      mealType: z.enum(MEAL_TYPES).optional(),
      description: z.string().min(1).optional(),
      estimated: z.boolean().nullable().optional(),
      ...Object.fromEntries(Object.entries(coreNutrientShape).map(([k, s]) => [k, s.optional()])),
      ...Object.fromEntries(Object.entries(optionalNutrientShape).map(([k, s]) => [k, s.nullable()])),
    },
    async ({ id, ...patch }) => {
      const existing = await getHealthDoc<Meal>(MEALS, id);
      if (!existing) return jsonResult({ success: false, error: `Meal ${id} not found` });
      const updated = mergePatch(existing as Record<string, unknown>, patch) as Meal;
      updated.updatedAt = nowISO();
      await saveHealthDoc(MEALS, id, updated as Record<string, unknown>);
      return jsonResult({ success: true, meal: updated });
    }
  );

  server.tool(
    'delete_meal',
    '删除一餐记录。',
    {
      mealId: z.string().describe('餐食记录 ID'),
      date: z.string().optional().describe('不再需要，保留是为了兼容'),
    },
    async ({ mealId }) => jsonResult({ success: await deleteHealthDoc(MEALS, mealId) })
  );

  server.tool(
    'get_daily_nutrition',
    '获取某一天吃了什么、营养总量，以及每项和目标相比是不足（low）、达标（ok）还是超标（high）。',
    { date: dateSchema.optional().describe('默认今天') },
    async ({ date }) => {
      const d = date ?? todayStr();
      const [summary, meals] = await Promise.all([nutritionSummary(d, d), listMeals(d, d)]);
      return jsonResult({
        date: d,
        totals: summary.daily[0]?.totals ?? { ...emptyTotals(), waterMl: 0 },
        vsTarget: summary.vsTarget,
        shortfalls: summary.shortfalls,
        excesses: summary.excesses,
        nutrientCoverage: summary.nutrientCoverage,
        meals,
      });
    }
  );

  server.tool(
    'get_nutrition_summary',
    '分析一段时间的饮食：每天的营养总量、平均每天摄取 vs 目标、哪些长期不足或超标、各营养素有几天超出范围。默认最近 7 天。status=no_data 表示没有记录该营养素（不等于 0）。平均值只计算有记录的天数（daysWithDataPerNutrient）。nutrientCoverage 低于 0.7 时结论不可靠。',
    {
      startDate: dateSchema.optional(),
      endDate: dateSchema.optional(),
      includeDaily: z.boolean().optional().describe('是否附带每天明细，默认 true'),
    },
    async ({ startDate, endDate, includeDaily }) => {
      const end = endDate ?? todayStr();
      const start = startDate ?? addDays(end, -6);
      const summary = await nutritionSummary(start, end);
      return jsonResult(includeDaily === false ? { ...summary, daily: undefined } : summary);
    }
  );

  server.tool(
    'log_water',
    '记录喝水，自动累加到当天总量。',
    {
      date: dateSchema.optional().describe('默认今天'),
      amountMl: z.number().min(0).describe('喝水量（毫升）'),
      source: z.enum(['manual', 'reminder_auto', 'quick_button']).optional().default('manual'),
    },
    async ({ date, amountMl, source }) => {
      const id = generateId('water');
      const water: WaterLog = { id, date: date ?? todayStr(), amountMl, source, recordedAt: nowISO() };
      await saveHealthDoc(WATER, id, water as unknown as Record<string, unknown>);
      const all = await listHealthDocs<WaterLog>(WATER, water.date, water.date);
      return jsonResult({ success: true, water, dailyWaterMl: all.reduce((s, w) => s + (w.amountMl || 0), 0) });
    }
  );

  // Food library: the AI saves foods the user eats often so repeat logs are fast and consistent.

  server.tool(
    'search_foods',
    '在食物库搜索常吃的食物（按名称或别名）。记录饮食前先搜，找到就用 foodId 记录。不传 query 列出全部。',
    { query: z.string().optional() },
    async ({ query }) => {
      const foods = await listHealthDocs<Food>(FOODS);
      const q = query?.toLowerCase().trim();
      const hits = q
        ? foods.filter(f => [f.name, f.brand ?? '', ...(f.aliases ?? [])].some(s => s.toLowerCase().includes(q)))
        : foods;
      return jsonResult({ count: hits.length, foods: hits.sort((a, b) => a.name.localeCompare(b.name)) });
    }
  );

  server.tool(
    'save_food',
    '把常吃的食物存进食物库（每份的营养数据）。同一种食物第二次出现，或用户提供包装营养标签时，主动保存。传 id 表示更新已有食物。',
    {
      id: z.string().optional(),
      name: z.string().min(1),
      aliases: z.array(z.string()).optional().describe('别名，如「鸡饭」「海南鸡饭」'),
      brand: z.string().optional(),
      serving: z.string().describe('一份是多少，如「1 碟」「100 g」「1 勺 (30 g)」'),
      ...coreNutrientShape,
      ...optionalNutrientShape,
      notes: z.string().optional(),
    },
    async ({ id, ...fields }) => {
      const existing = id ? await getHealthDoc<Food>(FOODS, id) : null;
      if (id && !existing) return jsonResult({ success: false, error: `Food ${id} not found` });
      const foodId = id ?? generateId('food');
      const food: Food = { ...(existing ?? {}), ...fields, id: foodId, createdAt: existing?.createdAt ?? nowISO(), updatedAt: existing ? nowISO() : undefined };
      await saveHealthDoc(FOODS, foodId, food as Record<string, unknown>);
      return jsonResult({ success: true, food });
    }
  );

  server.tool(
    'delete_food',
    '从食物库删除一个食物（不影响已记录的餐）。',
    { id: z.string() },
    async ({ id }) => jsonResult({ success: await deleteHealthDoc(FOODS, id) })
  );
}
