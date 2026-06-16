import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, fetchNamedDoc, upsertDoc, upsertDocPlain, deleteDocById } from '../firestore.js';
import { DailyNutrition, MealRecord, WaterIntakeRecord } from '../types.js';

const NUTRITION_COLLECTION = 'dailyNutrition';
const MEALS_COLLECTION = 'mealRecords';
const WATER_COLLECTION = 'waterIntakeRecords';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

const DEFAULT_GOALS = {
  caloriesGoal: 2000,
  proteinGoalG: 60,
  fatMinGoalG: 50,
  fatMaxGoalG: 80,
  sodiumGoalMg: 2400,
  waterGoalMl: 2000,
};

/**
 * Fetch or create daily nutrition doc for a given date.
 * If doc doesn't exist, returns a blank one with default goals.
 */
async function getOrCreateDailyNutrition(date: string): Promise<DailyNutrition> {
  const path = collectionPath(NUTRITION_COLLECTION);
  const all = (await fetchCollection(path)) as unknown as DailyNutrition[];
  const existing = all.find((d: DailyNutrition) => d.date === date);

  if (existing) {
    // Recalculate from meal records and water records for accuracy
    const meals = (await fetchCollection(collectionPath(MEALS_COLLECTION))) as unknown as MealRecord[];
    const waters = (await fetchCollection(collectionPath(WATER_COLLECTION))) as unknown as WaterIntakeRecord[];
    const todayMeals = meals.filter(m => m.date === date);
    const todayWaters = waters.filter(w => w.date === date);

    const totals = todayMeals.reduce(
      (acc, m) => {
        acc.calories += m.calories || 0;
        acc.proteinG += m.proteinG || 0;
        acc.fatG += m.fatG || 0;
        acc.carbsG += m.carbsG || 0;
        acc.sodiumMg += m.sodiumMg || 0;
        return acc;
      },
      { calories: 0, proteinG: 0, fatG: 0, carbsG: 0, sodiumMg: 0 }
    );

    const waterTotal = todayWaters.reduce((acc, w) => acc + (w.amountMl || 0), 0);

    const updated: DailyNutrition = {
      ...existing,
      ...totals,
      waterMl: waterTotal,
    };
    return updated;
  }

  // Return blank with defaults
  return {
    date,
    calories: 0,
    proteinG: 0,
    fatG: 0,
    carbsG: 0,
    sodiumMg: 0,
    waterMl: 0,
    ...DEFAULT_GOALS,
  };
}

export function registerNutritionTools(server: McpServer): void {

  server.tool(
    'log_meal',
    '记录一餐的详细营养信息。系统会自动累加到当天的每日营养总览中。',
    {
      date: z.string().describe('日期 YYYY-MM-DD'),
      mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'drink']).describe('餐别'),
      description: z.string().min(1).describe('食物描述，如「鸡胸肉沙拉 + 糙米饭」'),
      calories: z.number().min(0).describe('热量（千卡）'),
      proteinG: z.number().min(0).describe('蛋白质（克）'),
      fatG: z.number().min(0).describe('脂肪（克）'),
      carbsG: z.number().min(0).describe('碳水（克）'),
      sodiumMg: z.number().min(0).describe('钠（毫克）'),
    },
    async (input) => {
      // Create meal record
      const mealId = generateId('meal');
      const meal: MealRecord = {
        id: mealId,
        date: input.date,
        mealType: input.mealType,
        description: input.description,
        calories: input.calories,
        proteinG: input.proteinG,
        fatG: input.fatG,
        carbsG: input.carbsG,
        sodiumMg: input.sodiumMg,
        recordedAt: nowISO(),
      };
      await upsertDocPlain(collectionPath(MEALS_COLLECTION), mealId, meal as unknown as Record<string, unknown>);

      // Update daily nutrition totals
      const nutrition = await getOrCreateDailyNutrition(input.date);
      const nutritionId = `nutrition-${input.date}`;
      nutrition.calories += input.calories;
      nutrition.proteinG += input.proteinG;
      nutrition.fatG += input.fatG;
      nutrition.carbsG += input.carbsG;
      nutrition.sodiumMg += input.sodiumMg;
      await upsertDocPlain(collectionPath(NUTRITION_COLLECTION), nutritionId, nutrition as unknown as Record<string, unknown>);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, meal, dailyNutrition: nutrition }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'log_water',
    '记录喝水。系统会自动累加到当天总喝水量中。',
    {
      date: z.string().describe('日期 YYYY-MM-DD'),
      amountMl: z.number().min(0).describe('喝水量（毫升）'),
      source: z.enum(['manual', 'reminder_auto', 'quick_button']).optional().default('manual').describe('记录来源'),
    },
    async (input) => {
      // Create water intake record
      const waterId = generateId('water');
      const water: WaterIntakeRecord = {
        id: waterId,
        date: input.date,
        amountMl: input.amountMl,
        recordedAt: nowISO(),
        source: input.source,
      };
      await upsertDocPlain(collectionPath(WATER_COLLECTION), waterId, water as unknown as Record<string, unknown>);

      // Update daily nutrition
      const nutrition = await getOrCreateDailyNutrition(input.date);
      const nutritionId = `nutrition-${input.date}`;
      nutrition.waterMl += input.amountMl;
      await upsertDocPlain(collectionPath(NUTRITION_COLLECTION), nutritionId, nutrition as unknown as Record<string, unknown>);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, water, dailyWaterMl: nutrition.waterMl }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'get_daily_nutrition',
    '获取指定日期的营养概览。包含所有餐食记录、喝水量和营养目标及完成进度。',
    {
      date: z.string().optional().describe('日期 YYYY-MM-DD，默认今天'),
    },
    async ({ date }) => {
      const targetDate = date || todayStr();
      const nutrition = await getOrCreateDailyNutrition(targetDate);

      // Also return meal records for the day
      const meals = (await fetchCollection(collectionPath(MEALS_COLLECTION))) as unknown as MealRecord[];
      const todayMeals = meals.filter(m => m.date === targetDate);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            date: targetDate,
            nutrition,
            meals: todayMeals,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'set_nutrition_goals',
    '设置每日营养目标。只传入需要修改的目标字段。',
    {
      date: z.string().optional().describe('日期 YYYY-MM-DD，默认今天（目标全局适用）'),
      calories: z.number().min(0).optional().describe('热量目标（千卡）'),
      proteinG: z.number().min(0).optional().describe('蛋白质目标（克）'),
      fatMinG: z.number().min(0).optional().describe('脂肪最低摄入（克）'),
      fatMaxG: z.number().min(0).optional().describe('脂肪最高摄入（克）'),
      sodiumMg: z.number().min(0).optional().describe('钠目标（毫克）'),
      waterMl: z.number().min(0).optional().describe('喝水目标（毫升）'),
    },
    async (input) => {
      const targetDate = input.date || todayStr();
      const nutrition = await getOrCreateDailyNutrition(targetDate);
      const nutritionId = `nutrition-${targetDate}`;

      if (input.calories !== undefined) nutrition.caloriesGoal = input.calories;
      if (input.proteinG !== undefined) nutrition.proteinGoalG = input.proteinG;
      if (input.fatMinG !== undefined) nutrition.fatMinGoalG = input.fatMinG;
      if (input.fatMaxG !== undefined) nutrition.fatMaxGoalG = input.fatMaxG;
      if (input.sodiumMg !== undefined) nutrition.sodiumGoalMg = input.sodiumMg;
      if (input.waterMl !== undefined) nutrition.waterGoalMl = input.waterMl;

      await upsertDocPlain(collectionPath(NUTRITION_COLLECTION), nutritionId, nutrition as unknown as Record<string, unknown>);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, nutrition }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'delete_meal',
    '删除一餐记录。删除后系统会重新计算当日营养总览。',
    {
      mealId: z.string().describe('餐食记录 ID'),
      date: z.string().describe('日期 YYYY-MM-DD'),
    },
    async ({ mealId, date }) => {
      // Delete meal record
      await deleteDocById(collectionPath(MEALS_COLLECTION), mealId);

      // Force recalculate and save daily nutrition
      const nutrition = await getOrCreateDailyNutrition(date);
      const nutritionId = 'nutrition-' + date;
      await upsertDocPlain(collectionPath(NUTRITION_COLLECTION), nutritionId, nutrition as unknown as Record<string, unknown>);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, nutrition }, null, 2),
        }],
      };
    }
  );
}
