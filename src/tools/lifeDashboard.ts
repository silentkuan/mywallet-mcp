import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, upsertDocPlain } from '../firestore.js';
import { TaskInstance, TaskTemplate, TaskCompletion, TaskCategory, DailyNutrition, MealRecord, WaterIntakeRecord, TravelPlan } from '../types.js';

const INSTANCES_COLLECTION = 'taskInstances';
const TEMPLATES_COLLECTION = 'taskTemplates';
const COMPLETIONS_COLLECTION = 'taskCompletions';
const CATEGORIES_COLLECTION = 'taskCategories';
const NUTRITION_COLLECTION = 'dailyNutrition';
const MEALS_COLLECTION = 'mealRecords';
const WATER_COLLECTION = 'waterIntakeRecords';
const TRAVEL_COLLECTION = 'travelPlans';

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getWeekRange(): { start: string; end: string } {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return { start: toDateStr(monday), end: toDateStr(sunday) };
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');
  while (d <= end) {
    dates.push(toDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function calcDueDatesForRange(
  tmpl: TaskTemplate,
  lastCompletedDate: string | undefined,
  rangeDays: string[]
): string[] {
  const cfg = tmpl.recurrenceConfig || {};
  const type = tmpl.recurrenceType;

  if (type === 'daily') {
    if (!lastCompletedDate) return rangeDays;
    return rangeDays.filter(d => d >= lastCompletedDate);
  }

  if (type === 'weekly' || type === 'custom_days') {
    const daysOfWeek: number[] = cfg.days_of_week || [];
    const matchingDays = rangeDays.filter(d => {
      const date = new Date(d + 'T12:00:00');
      const dayNum = date.getDay() === 0 ? 7 : date.getDay();
      return daysOfWeek.includes(dayNum);
    });
    if (!lastCompletedDate) return matchingDays;
    return matchingDays.filter(d => d >= lastCompletedDate);
  }

  if (type === 'biweekly') {
    const daysOfWeek: number[] = cfg.days_of_week || [];
    if (!lastCompletedDate) {
      const baseWeek = cfg.base_week;
      if (baseWeek) {
        const base = new Date(baseWeek + 'T12:00:00');
        const weekStart = new Date(rangeDays[0] + 'T12:00:00');
        const diffWeeks = Math.floor((weekStart.getTime() - base.getTime()) / (7 * 86400000));
        if (diffWeeks % 2 === 0) {
          return rangeDays.filter(d => {
            const date = new Date(d + 'T12:00:00');
            const dayNum = date.getDay() === 0 ? 7 : date.getDay();
            return daysOfWeek.includes(dayNum);
          });
        }
      }
      return [];
    }
    const lastDate = new Date(lastCompletedDate + 'T12:00:00');
    const nextDate = new Date(lastDate);
    nextDate.setDate(nextDate.getDate() + 14);
    const nextDue = toDateStr(nextDate);
    if (rangeDays.includes(nextDue)) return [nextDue];
    return [];
  }

  if (type === 'monthly') {
    if (!lastCompletedDate) return [];
    const lastDate = new Date(lastCompletedDate + 'T12:00:00');
    const nextDate = new Date(lastDate);
    nextDate.setMonth(nextDate.getMonth() + 1);
    const nextDue = toDateStr(nextDate);
    if (rangeDays.includes(nextDue)) return [nextDue];
    return [];
  }

  if (type === 'one_time') {
    const dueDate = cfg.date;
    if (dueDate && rangeDays.includes(dueDate) && (!lastCompletedDate || dueDate > lastCompletedDate)) {
      return [dueDate];
    }
    return [];
  }

  return [];
}

export function registerLifeDashboardTools(server: McpServer): void {

  server.tool(
    'get_life_dashboard',
    '生活总览仪表盘。返回今日任务、喝水、营养、出行计划、本周完成率等概要数据。',
    {},
    async () => {
      const today = todayStr();

      // ── Tasks from templates + completions (matching frontend approach) ──
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const categoriesPath = collectionPath(CATEGORIES_COLLECTION);

      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];
      const allCategories = (await fetchCollection(categoriesPath)) as unknown as TaskCategory[];

      // Today's tasks
      const weekDays = [today];
      let todayPending = 0;
      let todayCompleted = 0;
      const todayTaskDetails: { id: string; title: string; categoryId: string; dueDate: string; status: string; priority: number; overdueDays?: number }[] = [];

      // Overdue tasks
      const overdueTasks: (TaskInstance & { overdueDays: number })[] = [];

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;

        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const lastCompletion = tmplCompletions
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, weekDays);
        const todayCompletedCount = tmplCompletions.filter(
          c => c.completedDate === today
        ).length;

        if (dueDates.includes(today)) {
          if (todayCompletedCount > 0) {
            todayCompleted++;
            todayTaskDetails.push({
              id: `tmpl-${tmpl.id}-${today}`,
              title: tmpl.title,
              categoryId: tmpl.categoryId,
              dueDate: today,
              status: 'completed',
              priority: tmpl.priority,
            });
          } else {
            todayPending++;
            todayTaskDetails.push({
              id: `tmpl-${tmpl.id}-${today}`,
              title: tmpl.title,
              categoryId: tmpl.categoryId,
              dueDate: today,
              status: 'pending',
              priority: tmpl.priority,
            });
          }
        }

        // Check overdue for daily tasks
        if (tmpl.recurrenceType === 'daily' && lastCompletion) {
          const lastDate = lastCompletion.completedDate;
          if (lastDate < today) {
            const daysSince = Math.floor(
              (new Date(today).getTime() - new Date(lastDate).getTime()) / (86400000)
            );
            if (daysSince > 1) {
              const missedCount = daysSince - 1;
              const oldDate = new Date(lastDate + 'T12:00:00');
              oldDate.setDate(oldDate.getDate() + 1);
              overdueTasks.push({
                id: `tmpl-${tmpl.id}-${toDateStr(oldDate)}`,
                templateId: tmpl.id,
                title: `${tmpl.title} (${missedCount}d)`,
                categoryId: tmpl.categoryId,
                dueDate: toDateStr(oldDate),
                dueTime: undefined,
                status: 'overdue',
                priority: tmpl.priority,
                note: tmpl.note,
                overdueDays: missedCount,
              });
            }
          }
        }
      }

      // Also get from instances collection as supplement
      const taskPath = collectionPath(INSTANCES_COLLECTION);
      const allTaskInstances = (await fetchCollection(taskPath)) as unknown as TaskInstance[];
      const instanceOverdue = allTaskInstances.filter(t => t.status === 'pending' && t.dueDate < today);

      // Merge overdue (avoid duplicates)
      const seenOverdue = new Set(overdueTasks.map(t => `${t.templateId}-${t.dueDate}`));
      for (const instTask of instanceOverdue) {
        const key = `${instTask.templateId}-${instTask.dueDate}`;
        if (!seenOverdue.has(key)) {
          seenOverdue.add(key);
          overdueTasks.push({
            ...instTask,
            overdueDays: Math.floor((new Date(today).getTime() - new Date(instTask.dueDate).getTime()) / (86400000)),
          });
        }
      }

      // ═══ Weekly rates ═══
      const { start, end } = getWeekRange();
      const weekDaysList = dateRange(start, end);
      const weeklyRates: { date: string; rate: number }[] = [];
      for (const day of weekDaysList) {
        const dayCompletions = allCompletions.filter(c => c.completedDate === day).length;
        // Count expected tasks for this day from templates
        let dayDue = 0;
        for (const tmpl of allTemplates) {
          if (tmpl.isActive === false) continue;
          const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
          const lastComp = tmplCompletions.sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];
          const dDates = calcDueDatesForRange(tmpl, lastComp?.completedDate, [day]);
          if (dDates.includes(day)) dayDue++;
        }
        weeklyRates.push({
          date: day,
          rate: dayDue > 0 ? Math.round((dayCompletions / dayDue) * 100) : 0,
        });
      }

      // ── Nutrition ──
      const nutritionPath = collectionPath(NUTRITION_COLLECTION);
      const mealsPath = collectionPath(MEALS_COLLECTION);
      const waterPath = collectionPath(WATER_COLLECTION);

      const allNutrition = (await fetchCollection(nutritionPath)) as unknown as DailyNutrition[];
      const todayNutrition = allNutrition.find((n: DailyNutrition) => n.date === today);

      const allMeals = (await fetchCollection(mealsPath)) as unknown as MealRecord[];
      const todayMeals = allMeals.filter(m => m.date === today);

      const allWaters = (await fetchCollection(waterPath)) as unknown as WaterIntakeRecord[];
      const todayWaters = allWaters.filter(w => w.date === today);
      const todayWaterMl = todayWaters.reduce((acc, w) => acc + (w.amountMl || 0), 0);

      // ── Nutrition progress ──
      let nutritionProgress = null;
      if (todayNutrition) {
        nutritionProgress = {
          calories: { current: todayNutrition.calories, goal: todayNutrition.caloriesGoal, percentage: todayNutrition.caloriesGoal > 0 ? Math.round((todayNutrition.calories / todayNutrition.caloriesGoal) * 100) : 0 },
          protein: { current: todayNutrition.proteinG, goal: todayNutrition.proteinGoalG, percentage: todayNutrition.proteinGoalG > 0 ? Math.round((todayNutrition.proteinG / todayNutrition.proteinGoalG) * 100) : 0 },
          water: { current: todayWaterMl, goal: todayNutrition.waterGoalMl, percentage: todayNutrition.waterGoalMl > 0 ? Math.round((todayWaterMl / todayNutrition.waterGoalMl) * 100) : 0 },
        };
      }

      // ── Active travel plans ──
      const travelPath = collectionPath(TRAVEL_COLLECTION);
      const allTravels = (await fetchCollection(travelPath)) as unknown as TravelPlan[];
      const activeTravel = allTravels.find(
        p => p.isActive && !p.isCompleted && p.startDate <= today && p.endDate >= today
      );

      // ── Summary ──
      const dashboard = {
        date: today,
        tasks: {
          total: todayPending + todayCompleted,
          pending: todayPending,
          completed: todayCompleted,
          overdue: overdueTasks.length,
          completionRate: (todayPending + todayCompleted) > 0
            ? Math.round((todayCompleted / (todayPending + todayCompleted)) * 100)
            : 0,
        },
        nutrition: nutritionProgress || {
          calories: { current: 0, goal: 0, percentage: 0 },
          protein: { current: 0, goal: 0, percentage: 0 },
          water: { current: todayWaterMl, goal: 2000, percentage: Math.round((todayWaterMl / 2000) * 100) },
        },
        meals: todayMeals,
        activeTravel: activeTravel || null,
        weeklyRates,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(dashboard, null, 2) }],
      };
    }
  );

  server.tool(
    'get_weekly_report',
    '获取本周（周一到周日）的统计数据。包括任务完成情况、营养平均值等。',
    {
      startDate: z.string().optional().describe('自定义起始日期 YYYY-MM-DD'),
      endDate: z.string().optional().describe('自定义结束日期 YYYY-MM-DD'),
    },
    async ({ startDate, endDate }) => {
      const range = getWeekRange();
      const start = startDate || range.start;
      const end = endDate || range.end;

      // ── Tasks from templates + completions ──
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      const weekDays = dateRange(start, end);
      let total = 0;
      let completed = 0;
      let skipped = 0;
      const pending: string[] = [];

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;
        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const lastCompletion = tmplCompletions
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, weekDays);
        const weekCompletions = tmplCompletions.filter(c => weekDays.includes(c.completedDate));

        total += dueDates.length;
        completed += weekCompletions.length;
        for (const due of dueDates) {
          if (!weekCompletions.some(c => c.completedDate === due)) {
            pending.push(`${tmpl.title} (${due})`);
          }
        }
      }

      // Also get from instances collection
      const taskPath = collectionPath(INSTANCES_COLLECTION);
      const allTaskInstances = (await fetchCollection(taskPath)) as unknown as TaskInstance[];
      const weekInstances = allTaskInstances.filter(t => t.dueDate >= start && t.dueDate <= end);
      skipped = weekInstances.filter(t => t.status === 'skipped').length;

      // ── Nutrition averages ──
      const nutritionPath = collectionPath(NUTRITION_COLLECTION);
      const allNutrition = (await fetchCollection(nutritionPath)) as unknown as DailyNutrition[];
      const weekNutrition = allNutrition.filter((n: DailyNutrition) => n.date >= start && n.date <= end);

      const avgNutrition = weekNutrition.length > 0
        ? {
            avgCalories: Math.round(weekNutrition.reduce((s, n) => s + n.calories, 0) / weekNutrition.length),
            avgProtein: Math.round(weekNutrition.reduce((s, n) => s + n.proteinG, 0) / weekNutrition.length),
            avgFat: Math.round(weekNutrition.reduce((s, n) => s + n.fatG, 0) / weekNutrition.length),
            avgCarbs: Math.round(weekNutrition.reduce((s, n) => s + n.carbsG, 0) / weekNutrition.length),
            avgWaterMl: Math.round(weekNutrition.reduce((s, n) => s + n.waterMl, 0) / weekNutrition.length),
          }
        : null;

      // ── Daily breakdown ──
      const dailyBreakdown: Record<string, { tasks: { total: number; completed: number }; meals: number }> = {};
      for (const day of weekDays) {
        if (!dailyBreakdown[day]) {
          dailyBreakdown[day] = { tasks: { total: 0, completed: 0 }, meals: 0 };
        }
      }
      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;
        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const lastComp = tmplCompletions.sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];
        const dueDates = calcDueDatesForRange(tmpl, lastComp?.completedDate, weekDays);
        for (const d of dueDates) {
          if (dailyBreakdown[d]) {
            dailyBreakdown[d].tasks.total++;
            if (tmplCompletions.some(c => c.completedDate === d)) {
              dailyBreakdown[d].tasks.completed++;
            }
          }
        }
      }

      // Count meals per day
      const mealsPath = collectionPath(MEALS_COLLECTION);
      const allMeals = (await fetchCollection(mealsPath)) as unknown as MealRecord[];
      const weekMeals = allMeals.filter(m => m.date >= start && m.date <= end);
      for (const meal of weekMeals) {
        if (dailyBreakdown[meal.date]) {
          dailyBreakdown[meal.date].meals++;
        }
      }

      const report = {
        period: { start, end },
        tasks: {
          total,
          completed,
          skipped,
          overdue: pending.length,
          pending: pending.length,
          completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
        },
        nutrition: avgNutrition,
        dailyBreakdown,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    }
  );
}
