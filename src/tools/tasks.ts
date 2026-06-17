import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById, upsertDocPlain } from '../firestore.js';
import {
  TaskCategory,
  TaskTemplate,
  TaskInstance,
  TaskCompletion,
} from '../types.js';

const CATEGORIES_COLLECTION = 'taskCategories';
const TEMPLATES_COLLECTION = 'taskTemplates';
const INSTANCES_COLLECTION = 'taskInstances';
const COMPLETIONS_COLLECTION = 'taskCompletions';

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

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Get Monday 00:00:00 of the current week (Singapore timezone) */
function getMondayOfWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0 ? 6 : day - 1); // How many days since Monday
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - diff);
  return monday;
}

/** Get Sunday 23:59:59 of the current week */
function getSundayOfWeek(): Date {
  const monday = getMondayOfWeek();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

function getWeekRangeStr(): { startDate: string; endDate: string } {
  return { startDate: toDateStr(getMondayOfWeek()), endDate: toDateStr(getSundayOfWeek()) };
}

/**
 * Generate all date strings between startDate and endDate inclusive.
 */
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

/**
 * Calculate which dates in a range a template is due.
 * Mirrors the frontend calcDueDatesForWeek but works for any date range.
 */
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

/**
 * Calculate the next due date based on recurrence type and config.
 */
function calcNextDueDate(
  recurrenceType: TaskTemplate['recurrenceType'],
  recurrenceConfig: Record<string, any>,
  lastDueDate: string
): string | null {
  const last = new Date(lastDueDate + 'T00:00:00');

  switch (recurrenceType) {
    case 'daily': {
      const next = new Date(last);
      next.setDate(next.getDate() + 1);
      return toDateStr(next);
    }

    case 'weekly': {
      const daysOfWeek: number[] = recurrenceConfig?.days_of_week || [];
      if (daysOfWeek.length === 0) {
        const next = new Date(last);
        next.setDate(next.getDate() + 7);
        return toDateStr(next);
      }
      // Convert raw getDay() (0=Sun..6=Sat) to our 1=Mon..7=Sun system
      const nextWeekDayMap = daysOfWeek.map(d => (d === 7 ? 0 : d));
      for (let offset = 1; offset <= 7; offset++) {
        const next = new Date(last);
        next.setDate(next.getDate() + offset);
        const dayOfWeek = next.getDay();
        if (nextWeekDayMap.includes(dayOfWeek)) {
          return toDateStr(next);
        }
      }
      const next = new Date(last);
      next.setDate(next.getDate() + 7);
      return toDateStr(next);
    }

    case 'biweekly': {
      const next = new Date(last);
      next.setDate(next.getDate() + 14);
      return toDateStr(next);
    }

    case 'monthly': {
      const next = new Date(last);
      next.setMonth(next.getMonth() + 1);
      return toDateStr(next);
    }

    case 'custom_days': {
      const daysOfWeek: number[] = recurrenceConfig?.days_of_week || [];
      if (daysOfWeek.length === 0) {
        const next = new Date(last);
        next.setDate(next.getDate() + 1);
        return toDateStr(next);
      }
      // Convert raw getDay() (0=Sun..6=Sat) to our 1=Mon..7=Sun system
      const nextWeekDayMap = daysOfWeek.map(d => (d === 7 ? 0 : d));
      for (let offset = 1; offset <= 14; offset++) {
        const next = new Date(last);
        next.setDate(next.getDate() + offset);
        const dayOfWeek = next.getDay();
        if (nextWeekDayMap.includes(dayOfWeek)) {
          return toDateStr(next);
        }
      }
      return null;
    }

    case 'interval': {
      const intervalDays = recurrenceConfig?.intervalDays || 1;
      const next = new Date(last);
      next.setDate(next.getDate() + intervalDays);
      return toDateStr(next);
    }

    case 'one_time':
      return null;

    default:
      return null;
  }
}

export function registerTaskTools(server: McpServer): void {

  // ───────────────────────
  // Task Categories
  // ───────────────────────

  server.tool(
    'create_task_category',
    '创建任务分类（如：家务、健康、饮食等）。返回新创建的分类对象。',
    {
      name: z.string().min(1).describe('分类名称（如：家务、健康、学习）'),
      icon: z.string().optional().describe('Emoji 图标，如 🏠'),
      color: z.string().optional().describe('颜色代码，如 #FF6B6B'),
      sortOrder: z.number().optional().describe('排序序号，越小越靠前'),
    },
    async (input) => {
      const id = generateId('tc');
      const category: TaskCategory = {
        id,
        name: input.name,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        isActive: true,
      };
      await upsertDocPlain(collectionPath(CATEGORIES_COLLECTION), id, category as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, category }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_task_categories',
    '获取所有任务分类列表。可按活跃状态筛选。',
    {
      isActive: z.boolean().optional().describe('筛选活跃分类'),
    },
    async ({ isActive }) => {
      const path = collectionPath(CATEGORIES_COLLECTION);
      let items = (await fetchCollection(path)) as unknown as TaskCategory[];
      if (isActive !== undefined) {
        items = items.filter(c => c.isActive === isActive);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // ───────────────────────
  // Task Templates
  // ───────────────────────

  server.tool(
    'create_task_template',
    '创建任务模板（习惯定义）。模板定义了重复任务的基本规则。',
    {
      categoryId: z.string().min(1).describe('所属分类 ID'),
      title: z.string().min(1).describe('任务标题'),
      description: z.string().optional().describe('任务描述'),
      recurrenceType: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'custom_days', 'interval', 'one_time']).describe('重复类型'),
      recurrenceConfig: z.record(z.any()).describe('重复配置 JSON 对象，如 {"days":[1,3,5],"intervalDays":3}'),
      priority: z.number().min(1).max(5).optional().default(3).describe('优先级，1-5（5最高）'),
      estimatedMinutes: z.number().optional().describe('预计耗时（分钟）'),
      isAutoPausable: z.boolean().optional().default(false).describe('出行时是否自动暂停'),
      note: z.string().optional().describe('备注'),
    },
    async (input) => {
      const id = generateId('tt');
      const template: TaskTemplate = {
        id,
        categoryId: input.categoryId,
        title: input.title,
        description: input.description,
        recurrenceType: input.recurrenceType,
        recurrenceConfig: input.recurrenceConfig,
        priority: input.priority ?? 3,
        estimatedMinutes: input.estimatedMinutes,
        isActive: true,
        isAutoPausable: input.isAutoPausable ?? false,
        note: input.note,
      };
      await upsertDocPlain(collectionPath(TEMPLATES_COLLECTION), id, template as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, template }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_task_templates',
    '获取任务模板列表。可按分类或活跃状态筛选。',
    {
      categoryId: z.string().optional().describe('按分类筛选'),
      isActive: z.boolean().optional().describe('按活跃状态筛选'),
    },
    async ({ categoryId, isActive }) => {
      const path = collectionPath(TEMPLATES_COLLECTION);
      let items = (await fetchCollection(path)) as unknown as TaskTemplate[];
      if (categoryId) items = items.filter(t => t.categoryId === categoryId);
      if (isActive !== undefined) items = items.filter(t => t.isActive === isActive);

      // Enrich each template with lastCompletedDate and nextDueDate
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const instancesPath = collectionPath(INSTANCES_COLLECTION);
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];
      const allInstances = (await fetchCollection(instancesPath)) as unknown as TaskInstance[];

      const enriched = items.map(tmpl => {
        // Last completed date: most recent completion for this template
        const templateCompletions = allCompletions
          .filter(c => c.templateId === tmpl.id)
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
        const lastCompletedDate = templateCompletions.length > 0
          ? templateCompletions[0].completedDate
          : null;

        // Next due date: next pending instance for this template
        const pendingInstances = allInstances
          .filter(inst => inst.templateId === tmpl.id && (inst.status === 'pending' || inst.status === 'overdue'))
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        const nextDueDate = pendingInstances.length > 0
          ? pendingInstances[0].dueDate
          : null;

        return {
          ...tmpl,
          lastCompletedDate,
          nextDueDate,
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
      };
    }
  );

  server.tool(
    'update_task_template',
    '更新任务模板的字段。只传入需要修改的字段。',
    {
      id: z.string().describe('模板 ID'),
      categoryId: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional().nullable(),
      recurrenceType: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'custom_days', 'interval', 'one_time']).optional(),
      recurrenceConfig: z.record(z.any()).optional(),
      priority: z.number().min(1).max(5).optional(),
      estimatedMinutes: z.number().optional().nullable(),
      isActive: z.boolean().optional(),
      isAutoPausable: z.boolean().optional(),
      note: z.string().optional().nullable(),
    },
    async ({ id, ...updates }) => {
      const path = collectionPath(TEMPLATES_COLLECTION);
      const all = (await fetchCollection(path)) as unknown as TaskTemplate[];
      const existing = all.find(t => t.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Template ${id} not found` }) }] };
      }
      const updated: TaskTemplate = { ...existing, ...updates } as TaskTemplate;
      if (updates.description === null) updated.description = undefined;
      if (updates.estimatedMinutes === null) updated.estimatedMinutes = undefined;
      if (updates.note === null) updated.note = undefined;
      await upsertDocPlain(path, id, updated as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, template: updated }, null, 2) }],
      };
    }
  );

  server.tool(
    'delete_task_template',
    '删除一个任务模板。删除后不会影响已有任务实例。',
    {
      id: z.string().describe('模板 ID'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(TEMPLATES_COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );

  // ───────────────────────
  // Task Instances
  // ───────────────────────

  server.tool(
    'create_task_instance',
    '手动创建任务实例（用于 seed 测试数据）。直接将一条待办写入 taskInstances 集合。',
    {
      templateId: z.string().describe('关联的模板 ID'),
      title: z.string().min(1).describe('任务标题'),
      description: z.string().optional(),
      categoryId: z.string().describe('分类 ID'),
      dueDate: z.string().describe('到期日 YYYY-MM-DD'),
      dueTime: z.string().optional().describe('到期时间 HH:MM'),
      status: z.enum(['pending', 'completed', 'skipped', 'overdue']).optional().default('pending'),
      priority: z.number().min(1).max(5).optional().default(3),
      note: z.string().optional(),
    },
    async (input) => {
      const id = generateId('ti');
      const instance: TaskInstance = {
        id,
        templateId: input.templateId,
        title: input.title,
        description: input.description,
        categoryId: input.categoryId,
        dueDate: input.dueDate,
        dueTime: input.dueTime,
        status: input.status as TaskInstance['status'],
        priority: input.priority ?? 3,
        note: input.note,
      };
      await upsertDocPlain(collectionPath(INSTANCES_COLLECTION), id, instance as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, instance }, null, 2) }],
      };
    }
  );

  server.tool(
    'generate_task_instances',
    '从所有活跃模板自动生成指定日期范围内的任务实例，写入 taskInstances 集合。',
    {
      startDate: z.string().describe('起始日期 YYYY-MM-DD'),
      endDate: z.string().describe('结束日期 YYYY-MM-DD'),
    },
    async ({ startDate, endDate }) => {
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const instancesPath = collectionPath(INSTANCES_COLLECTION);

      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];
      const allInstances = (await fetchCollection(instancesPath)) as unknown as TaskInstance[];

      const activeTemplates = allTemplates.filter(t => t.isActive !== false);
      const rangeDays = dateRange(startDate, endDate);

      const created: TaskInstance[] = [];
      let skipped = 0;

      for (const tmpl of activeTemplates) {
        const lastCompletion = allCompletions
          .filter(c => c.templateId === tmpl.id)
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, rangeDays);

        for (const dueDate of dueDates) {
          // Skip if instance already exists for this template+date
          const exists = allInstances.some(
            inst => inst.templateId === tmpl.id && inst.dueDate === dueDate
          );
          if (exists) {
            skipped++;
            continue;
          }

          // Skip if already completed
          const alreadyDone = allCompletions.some(
            c => c.templateId === tmpl.id && c.completedDate === dueDate
          );
          if (alreadyDone) {
            skipped++;
            continue;
          }

          const id = generateId('ti');
          const instance: TaskInstance = {
            id,
            templateId: tmpl.id,
            title: tmpl.title,
            description: tmpl.description,
            categoryId: tmpl.categoryId,
            dueDate,
            status: 'pending',
            priority: tmpl.priority,
            note: tmpl.note,
          };
          await upsertDocPlain(instancesPath, id, instance as unknown as Record<string, unknown>);
          created.push(instance);
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            created: created.length,
            skipped,
            instances: created,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'get_task_instances_by_period',
    '按週/月/雙週/自定義獲取任務實例列表。',
    {
      periodType: z.enum(['week', 'month', 'biweek', 'custom']).describe('週期類型'),
      startDate: z.string().optional().describe('自定義起始日期 YYYY-MM-DD（custom 類型必填）'),
      endDate: z.string().optional().describe('自定義結束日期 YYYY-MM-DD（custom 類型必填）'),
    },
    async ({ periodType, startDate, endDate }) => {
      let sDate: string;
      let eDate: string;
      const today = new Date();
      const sgOffset = 8 * 60;
      const localOffset = today.getTimezoneOffset();
      const sgTime = new Date(today.getTime() + (localOffset + sgOffset) * 60000);

      switch (periodType) {
        case 'week': {
          const monday = getMondayOfWeek();
          const sunday = getSundayOfWeek();
          sDate = toDateStr(monday);
          eDate = toDateStr(sunday);
          break;
        }
        case 'month': {
          sDate = `${sgTime.getFullYear()}-${String(sgTime.getMonth() + 1).padStart(2, '0')}-01`;
          const lastDay = new Date(sgTime.getFullYear(), sgTime.getMonth() + 1, 0);
          eDate = toDateStr(lastDay);
          break;
        }
        case 'biweek': {
          const monday = getMondayOfWeek();
          const twoWeeksLater = new Date(monday);
          twoWeeksLater.setDate(twoWeeksLater.getDate() + 13);
          sDate = toDateStr(monday);
          eDate = toDateStr(twoWeeksLater);
          break;
        }
        case 'custom': {
          sDate = startDate || todayStr();
          eDate = endDate || todayStr();
          break;
        }
        default: {
          sDate = todayStr();
          eDate = todayStr();
        }
      }

      // Get instances from taskInstances collection
      const instancesPath = collectionPath(INSTANCES_COLLECTION);
      const allInstances = (await fetchCollection(instancesPath)) as unknown as TaskInstance[];
      let instances = allInstances.filter(inst => inst.dueDate >= sDate && inst.dueDate <= eDate);

      // Also get template+completion based tasks for this period
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      const rangeDays = dateRange(sDate, eDate);

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;
        const lastCompletion = allCompletions
          .filter(c => c.templateId === tmpl.id)
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];
        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, rangeDays);

        for (const dueDate of dueDates) {
          const existsInInstances = instances.some(
            inst => inst.templateId === tmpl.id && inst.dueDate === dueDate
          );
          if (existsInInstances) continue;

          const completedCompletion = allCompletions.find(
            c => c.templateId === tmpl.id && c.completedDate === dueDate
          );

          instances.push({
            id: `tmpl-${tmpl.id}-${dueDate}`,
            templateId: tmpl.id,
            title: tmpl.title,
            description: tmpl.description,
            categoryId: tmpl.categoryId,
            dueDate,
            status: completedCompletion ? 'completed' : 'pending',
            completedAt: completedCompletion?.completedAt,
            priority: tmpl.priority,
            note: tmpl.note,
          });
        }
      }

      // Sort by date, then priority
      instances.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.priority - a.priority);

      return {
        content: [{ type: 'text', text: JSON.stringify({ period: { startDate: sDate, endDate: eDate }, total: instances.length, instances }, null, 2) }],
      };
    }
  );

  server.tool(
    'search_task_history',
    '搜索任务历史，支持日期范围、模板和分類篩選，返回列表及彙總統計。',
    {
      startDate: z.string().describe('起始日期 YYYY-MM-DD'),
      endDate: z.string().describe('结束日期 YYYY-MM-DD'),
      templateId: z.string().optional().describe('按模板筛选'),
      categoryId: z.string().optional().describe('按分类筛选'),
    },
    async ({ startDate, endDate, templateId, categoryId }) => {
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const categoriesPath = collectionPath(CATEGORIES_COLLECTION);

      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];
      const allCategories = (await fetchCollection(categoriesPath)) as unknown as TaskCategory[];

      let filteredTemplates = allTemplates;
      if (templateId) filteredTemplates = filteredTemplates.filter(t => t.id === templateId);
      if (categoryId) filteredTemplates = filteredTemplates.filter(t => t.categoryId === categoryId);

      const rangeDays = dateRange(startDate, endDate);
      const categoryMap = new Map(allCategories.map(c => [c.id, c]));

      // Build history entries
      interface HistoryEntry {
        templateId: string;
        title: string;
        categoryId: string;
        categoryName: string;
        categoryIcon: string;
        recurrenceType: string;
        dueDate: string;
        completedAt: string | null;
        completed: boolean;
      }

      const entries: HistoryEntry[] = [];
      const templateStats: Record<string, { total: number; completed: number }> = {};

      for (const tmpl of filteredTemplates) {
        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const tmplCompletionDates = new Set(tmplCompletions.map(c => c.completedDate));
        const catInfo = categoryMap.get(tmpl.categoryId);
        const catName = catInfo?.name || 'General';
        const catIcon = catInfo?.icon || '📋';

        const lastCompletion = tmplCompletions
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, rangeDays);
        const allDatesInRange = new Set(dueDates);

        // Also include any completions in the range that we might have missed
        for (const comp of tmplCompletions) {
          if (comp.completedDate >= startDate && comp.completedDate <= endDate) {
            allDatesInRange.add(comp.completedDate);
          }
        }

        if (!templateStats[tmpl.id]) {
          templateStats[tmpl.id] = { total: 0, completed: 0 };
        }

        for (const date of [...allDatesInRange].sort()) {
          const isCompleted = tmplCompletionDates.has(date);
          const completion = tmplCompletions.find(c => c.completedDate === date);
          entries.push({
            templateId: tmpl.id,
            title: tmpl.title,
            categoryId: tmpl.categoryId,
            categoryName: catName,
            categoryIcon: catIcon,
            recurrenceType: tmpl.recurrenceType,
            dueDate: date,
            completedAt: completion?.completedAt || null,
            completed: isCompleted,
          });
          templateStats[tmpl.id].total++;
          if (isCompleted) templateStats[tmpl.id].completed++;
        }
      }

      // Summary stats
      const totalEntries = entries.length;
      const completedEntries = entries.filter(e => e.completed).length;
      const completionRate = totalEntries > 0 ? Math.round((completedEntries / totalEntries) * 100) : 0;

      // Category breakdown
      const byCategory: Record<string, { total: number; completed: number; rate: number }> = {};
      for (const entry of entries) {
        if (!byCategory[entry.categoryName]) {
          byCategory[entry.categoryName] = { total: 0, completed: 0, rate: 0 };
        }
        byCategory[entry.categoryName].total++;
        if (entry.completed) byCategory[entry.categoryName].completed++;
      }
      for (const key of Object.keys(byCategory)) {
        byCategory[key].rate = byCategory[key].total > 0
          ? Math.round((byCategory[key].completed / byCategory[key].total) * 100) : 0;
      }

      // Daily breakdown
      const byDate: Record<string, { total: number; completed: number }> = {};
      for (const entry of entries) {
        if (!byDate[entry.dueDate]) byDate[entry.dueDate] = { total: 0, completed: 0 };
        byDate[entry.dueDate].total++;
        if (entry.completed) byDate[entry.dueDate].completed++;
      }

      entries.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            period: { startDate, endDate },
            summary: {
              total: totalEntries,
              completed: completedEntries,
              pending: totalEntries - completedEntries,
              completionRate,
            },
            byCategory,
            byDate,
            templateStats,
            entries,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'get_today_tasks',
    '获取某天的任务列表。默认返回今天的任务。从模板+完成記錄計算，也讀取 taskInstances 作為補充。',
    {
      date: z.string().optional().describe('日期 YYYY-MM-DD，默认今天'),
      status: z.enum(['pending', 'completed', 'skipped', 'overdue']).optional().describe('按状态筛选'),
    },
    async ({ date, status }) => {
      const targetDate = date || todayStr();

      // Get from instances collection
      const instancesPath = collectionPath(INSTANCES_COLLECTION);
      const allInstances = (await fetchCollection(instancesPath)) as unknown as TaskInstance[];
      let items = allInstances.filter(t => t.dueDate === targetDate);

      // Also compute from templates + completions (like frontend does)
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;

        const lastCompletion = allCompletions
          .filter(c => c.templateId === tmpl.id)
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const rangeDays = [targetDate];
        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, rangeDays);

        if (dueDates.length === 0) continue;

        // Check if already in items
        const exists = items.some(t => t.templateId === tmpl.id);
        if (exists) continue;

        const isCompleted = allCompletions.some(
          c => c.templateId === tmpl.id && c.completedDate === targetDate
        );
        const actualStatus = isCompleted ? 'completed' : 'pending';

        items.push({
          id: `tmpl-${tmpl.id}-${targetDate}`,
          templateId: tmpl.id,
          title: tmpl.title,
          description: tmpl.description,
          categoryId: tmpl.categoryId,
          dueDate: targetDate,
          status: actualStatus as 'pending' | 'completed',
          priority: tmpl.priority,
          note: tmpl.note,
        });
      }

      if (status) {
        if (status === 'overdue') {
          items = items.filter(t => t.dueDate < targetDate && t.status === 'pending');
        } else {
          items = items.filter(t => t.status === status);
        }
      }

      items.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        const ta = a.dueTime || '00:00';
        const tb = b.dueTime || '00:00';
        return ta.localeCompare(tb);
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  server.tool(
    'complete_task',
    '完成任务。将任务实例标记为 completed，并在完成记录中添加一条记录。根据模板的 recurrenceType 自动生成下一次任务实例。',
    {
      instanceId: z.string().describe('任务实例 ID'),
      note: z.string().optional().describe('完成备注'),
      method: z.enum(['manual', 'auto', 'voice', 'batch']).optional().default('manual').describe('完成方式'),
    },
    async ({ instanceId, note, method }) => {
      const path = collectionPath(INSTANCES_COLLECTION);
      const all = (await fetchCollection(path)) as unknown as TaskInstance[];
      const instance = all.find(t => t.id === instanceId);
      if (!instance) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Instance ${instanceId} not found` }) }] };
      }

      const now = new Date().toISOString();
      instance.status = 'completed';
      instance.completedAt = now;
      instance.note = note || instance.note;
      await upsertDocPlain(path, instanceId, instance as unknown as Record<string, unknown>);

      // Create completion record
      const completionId = generateId('tcmp');
      const completion: TaskCompletion = {
        id: completionId,
        instanceId,
        templateId: instance.templateId,
        completedDate: instance.dueDate,
        completedAt: now,
        method: method as TaskCompletion['method'],
        note,
      };
      await upsertDocPlain(
        collectionPath(COMPLETIONS_COLLECTION),
        completionId,
        completion as unknown as Record<string, unknown>
      );

      // Generate next task instance based on recurrence
      let nextInstance: TaskInstance | null = null;
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const template = allTemplates.find(t => t.id === instance.templateId);

      if (template) {
        const nextDueDate = calcNextDueDate(template.recurrenceType, template.recurrenceConfig, instance.dueDate);
        if (nextDueDate) {
          const nextId = generateId('ti');
          nextInstance = {
            id: nextId,
            templateId: template.id,
            title: template.title,
            description: template.description,
            categoryId: template.categoryId,
            dueDate: nextDueDate,
            dueTime: instance.dueTime,
            status: 'pending',
            priority: template.priority,
            note: template.note,
          };
          await upsertDocPlain(
            collectionPath(INSTANCES_COLLECTION),
            nextId,
            nextInstance as unknown as Record<string, unknown>
          );
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            instance,
            completionId,
            nextInstance: nextInstance ? { id: nextInstance.id, dueDate: nextInstance.dueDate } : null,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'skip_task',
    '跳过任务。将任务实例标记为 skipped。不会创建完成记录。',
    {
      instanceId: z.string().describe('任务实例 ID'),
    },
    async ({ instanceId }) => {
      const path = collectionPath(INSTANCES_COLLECTION);
      const all = (await fetchCollection(path)) as unknown as TaskInstance[];
      const instance = all.find(t => t.id === instanceId);
      if (!instance) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Instance ${instanceId} not found` }) }] };
      }
      instance.status = 'skipped';
      await upsertDocPlain(path, instanceId, instance as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, instance }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_overdue_tasks',
    '获取超期未完成的任务。同時檢查 taskInstances 和模板+完成記錄。',
    {},
    async () => {
      const today = todayStr();

      // Only consider tasks within the last 3 days as overdue
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const cutoff = toDateStr(threeDaysAgo);

      // Get from instances collection
      const instancesPath = collectionPath(INSTANCES_COLLECTION);
      const allInstances = (await fetchCollection(instancesPath)) as unknown as TaskInstance[];
      const overdueFromInstances = allInstances.filter(
        t => t.status === 'pending' && t.dueDate < today && t.dueDate >= cutoff
      );

      // Get from templates + completions
      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      const overdueFromTemplates: (TaskInstance & { overdueDays: number })[] = [];

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;

        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const lastCompletion = tmplCompletions
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        // For daily tasks: check if there are missed days since last completion
        if (tmpl.recurrenceType === 'daily') {
          if (!lastCompletion) {
            // Never completed anything, but not really overdue - skip
            continue;
          }
          const lastDate = lastCompletion.completedDate;
          if (lastDate < today) {
            const daysSince = Math.floor(
              (new Date(today).getTime() - new Date(lastDate).getTime()) / (86400000)
            );
            // Count missed days within the last 3 days
            for (let i = 1; i < daysSince; i++) {
              const missedDate = new Date(lastDate + 'T12:00:00');
              missedDate.setDate(missedDate.getDate() + i);
              const missedDateStr = toDateStr(missedDate);
              if (missedDateStr >= today) break;
              if (missedDateStr < cutoff) continue;  // Skip tasks older than 3 days

              // Check if already covered by instances
              const existsInInstances = overdueFromInstances.some(
                inst => inst.templateId === tmpl.id && inst.dueDate === missedDateStr
              );
              if (existsInInstances) continue;

              // Check if actually completed on that date (maybe completed late)
              const actuallyDone = allCompletions.some(
                c => c.templateId === tmpl.id && c.completedDate === missedDateStr
              );
              if (actuallyDone) continue;

              overdueFromTemplates.push({
                id: `tmpl-${tmpl.id}-${missedDateStr}`,
                templateId: tmpl.id,
                title: tmpl.title,
                description: tmpl.description,
                categoryId: tmpl.categoryId,
                dueDate: missedDateStr,
                status: 'overdue',
                priority: tmpl.priority,
                note: tmpl.note,
                overdueDays: Math.floor(
                  (new Date(today).getTime() - new Date(missedDateStr).getTime()) / (86400000)
                ),
              });
            }
          }
        }

        // For weekly/custom_days: check if the last due day was missed
        if (tmpl.recurrenceType === 'weekly' || tmpl.recurrenceType === 'custom_days') {
          const daysOfWeek: number[] = tmpl.recurrenceConfig?.days_of_week || [];
          if (daysOfWeek.length === 0) continue;

          if (!lastCompletion) {
            // Never completed, check if any of this week's due days have passed
            const weekRange = getWeekRangeStr();
            const rangeDays = dateRange(weekRange.startDate, weekRange.endDate);
            for (const day of rangeDays) {
              if (day >= today) break;
              if (day < cutoff) continue;  // Skip tasks older than 3 days
              const date = new Date(day + 'T12:00:00');
              const dayNum = date.getDay() === 0 ? 7 : date.getDay();
              if (daysOfWeek.includes(dayNum)) {
                const existsInInstances = overdueFromInstances.some(
                  inst => inst.templateId === tmpl.id && inst.dueDate === day
                );
                if (!existsInInstances) {
                  overdueFromTemplates.push({
                    id: `tmpl-${tmpl.id}-${day}`,
                    templateId: tmpl.id,
                    title: tmpl.title,
                    description: tmpl.description,
                    categoryId: tmpl.categoryId,
                    dueDate: day,
                    status: 'overdue',
                    priority: tmpl.priority,
                    note: tmpl.note,
                    overdueDays: Math.floor((new Date(today).getTime() - new Date(day).getTime()) / (86400000)),
                  });
                }
              }
            }
            continue;
          }

          // Has completions, check if last completion was overdue
          const lastDate = lastCompletion.completedDate;
          // Find the NEXT due date after last completion
          const cfg = tmpl.recurrenceConfig || {};
          const nextDueDates = [];
          const lastDt = new Date(lastDate + 'T12:00:00');
          for (let offset = 1; offset <= 14; offset++) {
            const check = new Date(lastDt);
            check.setDate(check.getDate() + offset);
            const dayNum = check.getDay() === 0 ? 7 : check.getDay();
            if (daysOfWeek.includes(dayNum)) {
              nextDueDates.push(toDateStr(check));
              break; // Just the next one
            }
          }
          // nextDueDates now has the next expected due date
          for (const nextDue of nextDueDates) {
            if (nextDue < today && nextDue >= cutoff) {
              const existsInInstances = overdueFromInstances.some(
                inst => inst.templateId === tmpl.id && inst.dueDate === nextDue
              );
              if (!existsInInstances) {
                const actuallyDone = allCompletions.some(
                  c => c.templateId === tmpl.id && c.completedDate === nextDue
                );
                if (!actuallyDone) {
                  overdueFromTemplates.push({
                    id: `tmpl-${tmpl.id}-${nextDue}`,
                    templateId: tmpl.id,
                    title: tmpl.title,
                    description: tmpl.description,
                    categoryId: tmpl.categoryId,
                    dueDate: nextDue,
                    status: 'overdue',
                    priority: tmpl.priority,
                    note: tmpl.note,
                    overdueDays: Math.floor((new Date(today).getTime() - new Date(nextDue).getTime()) / (86400000)),
                  });
                }
              }
            }
          }
        }
      }

      // Merge and deduplicate
      const seen = new Set<string>();
      const merged: (TaskInstance & { overdueDays?: number })[] = [];

      for (const item of [...overdueFromInstances, ...overdueFromTemplates]) {
        const key = `${item.templateId}-${item.dueDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }

      merged.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.priority - a.priority);

      return {
        content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
      };
    }
  );

  server.tool(
    'get_task_stats',
    '获取任务统计。可按日期范围筛选。返回完成数、跳过数、超期数、完成率等。',
    {
      startDate: z.string().optional().describe('起始日期 YYYY-MM-DD'),
      endDate: z.string().optional().describe('结束日期 YYYY-MM-DD'),
    },
    async ({ startDate, endDate }) => {
      const path = collectionPath(INSTANCES_COLLECTION);
      const all = (await fetchCollection(path)) as unknown as TaskInstance[];

      let filtered = all;
      if (startDate) filtered = filtered.filter(t => t.dueDate >= startDate);
      if (endDate) filtered = filtered.filter(t => t.dueDate <= endDate);

      const total = filtered.length;
      const completed = filtered.filter(t => t.status === 'completed').length;
      const skipped = filtered.filter(t => t.status === 'skipped').length;
      const overdue = filtered.filter(t => t.status === 'overdue').length;
      const pending = filtered.filter(t => t.status === 'pending').length;
      const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

      // Category breakdown
      const categoriesPath = collectionPath(CATEGORIES_COLLECTION);
      const categories = (await fetchCollection(categoriesPath)) as unknown as TaskCategory[];
      const categoryMap = new Map(categories.map(c => [c.id, c.name]));

      const byCategory: Record<string, { total: number; completed: number; rate: number }> = {};
      for (const task of filtered) {
        const catName = categoryMap.get(task.categoryId) || task.categoryId;
        if (!byCategory[catName]) byCategory[catName] = { total: 0, completed: 0, rate: 0 };
        byCategory[catName].total++;
        if (task.status === 'completed') byCategory[catName].completed++;
      }
      for (const key of Object.keys(byCategory)) {
        byCategory[key].rate = byCategory[key].total > 0
          ? Math.round((byCategory[key].completed / byCategory[key].total) * 100)
          : 0;
      }

      // Also get stats from completions
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];
      let filteredCompletions = allCompletions;
      if (startDate) filteredCompletions = filteredCompletions.filter(c => c.completedDate >= startDate);
      if (endDate) filteredCompletions = filteredCompletions.filter(c => c.completedDate <= endDate);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            fromInstances: { total, completed, skipped, overdue, pending, completionRate, byCategory },
            fromCompletions: {
              total: filteredCompletions.length,
            },
          }, null, 2),
        }],
      };
    }
  );

  // ───────────────────────
  // This Week Stats (Fixed)
  // ───────────────────────

  server.tool(
    'get_this_week_stats',
    '获取本周（周一到周日）的任务统计。從模板+完成記錄計算（與前端一致）。',
    {},
    async () => {
      const { startDate, endDate } = getWeekRangeStr();
      const weekDays = dateRange(startDate, endDate);

      const templatesPath = collectionPath(TEMPLATES_COLLECTION);
      const completionsPath = collectionPath(COMPLETIONS_COLLECTION);

      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      const pendingTasks: { id: string; title: string; dueDate: string; dueTime?: string; status: string; priority: number }[] = [];
      let totalDue = 0;
      let completedCount = 0;
      const tasks: { templateId: string; title: string; totalDue: number; completed: number; rate: number }[] = [];

      for (const tmpl of allTemplates) {
        if (tmpl.isActive === false) continue;

        const tmplCompletions = allCompletions.filter(c => c.templateId === tmpl.id);
        const weekCompletions = tmplCompletions.filter(c => weekDays.includes(c.completedDate));
        const lastCompletion = tmplCompletions
          .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];

        const dueDates = calcDueDatesForRange(tmpl, lastCompletion?.completedDate, weekDays);
        const tmplCompleted = weekCompletions.length;
        const tmplDue = dueDates.length;

        totalDue += tmplDue;
        completedCount += tmplCompleted;

        for (const dueDate of dueDates) {
          const isDone = weekCompletions.some(c => c.completedDate === dueDate);
          pendingTasks.push({
            id: `tmpl-${tmpl.id}-${dueDate}`,
            title: tmpl.title,
            dueDate,
            status: isDone ? 'completed' : 'pending',
            priority: tmpl.priority,
          });
        }

        tasks.push({
          templateId: tmpl.id,
          title: tmpl.title,
          totalDue: tmplDue,
          completed: tmplCompleted,
          rate: tmplDue > 0 ? Math.round((tmplCompleted / tmplDue) * 100) : 100,
        });
      }

      const completionRate = totalDue > 0 ? Math.round((completedCount / totalDue) * 100) : 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            startDate,
            endDate,
            total: totalDue,
            completed: completedCount,
            pending: totalDue - completedCount,
            completionRate,
            pendingTasks: pendingTasks.sort((a, b) =>
              a.status === 'completed' && b.status !== 'completed' ? 1 :
              b.status === 'completed' && a.status !== 'completed' ? -1 :
              a.dueDate.localeCompare(b.dueDate) || b.priority - a.priority
            ),
            tasks: tasks.filter(t => t.totalDue > 0 || t.completed > 0),
          }, null, 2),
        }],
      };
    }
  );
}
