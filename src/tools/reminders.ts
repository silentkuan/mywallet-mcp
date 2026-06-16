import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, upsertDocPlain, deleteDocById } from '../firestore.js';
import { ReminderRule, ReminderLog, TaskTemplate, TaskCompletion } from '../types.js';

const RULES_COLLECTION = 'reminderRules';
const LOGS_COLLECTION = 'reminderLogs';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function currentHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function registerReminderTools(server: McpServer): void {

  server.tool(
    'create_reminder_rule',
    '创建提醒规则。可关联任务模板、分类或自定义消息。支持定时、重复提醒。',
    {
      title: z.string().min(1).describe('提醒标题'),
      templateId: z.string().optional().describe('关联的任务模板 ID'),
      categoryId: z.string().optional().describe('关联的任务分类 ID'),
      channel: z.enum(['telegram', 'push', 'system']).describe('提醒渠道'),
      messageTemplate: z.string().optional().describe('消息模板，可用 {title} {time} 等变量'),
      scheduleConfig: z.record(z.any()).describe('调度配置 JSON，如 {"time":"09:00","daysOfWeek":[1,2,3,4,5]}'),
      suspendStartDate: z.string().optional().describe('暂停开始日期 YYYY-MM-DD'),
      suspendEndDate: z.string().optional().describe('暂停结束日期 YYYY-MM-DD'),
    },
    async (input) => {
      const id = generateId('rr');
      const rule: ReminderRule = {
        id,
        title: input.title,
        templateId: input.templateId,
        categoryId: input.categoryId,
        channel: input.channel,
        messageTemplate: input.messageTemplate,
        scheduleConfig: input.scheduleConfig,
        isActive: true,
        suspendStartDate: input.suspendStartDate,
        suspendEndDate: input.suspendEndDate,
      };
      await upsertDocPlain(collectionPath(RULES_COLLECTION), id, rule as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, rule }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_reminder_rules',
    '获取所有提醒规则列表。可按活跃状态筛选。',
    {
      isActive: z.boolean().optional().describe('按活跃状态筛选'),
    },
    async ({ isActive }) => {
      const path = collectionPath(RULES_COLLECTION);
      let items = (await fetchCollection(path)) as unknown as ReminderRule[];
      if (isActive !== undefined) {
        items = items.filter(r => r.isActive === isActive);
      }

      // Enrich rules with categoryId with task stats for the current week
      const templatesPath = collectionPath('taskTemplates');
      const completionsPath = collectionPath('taskCompletions');
      const allTemplates = (await fetchCollection(templatesPath)) as unknown as TaskTemplate[];
      const allCompletions = (await fetchCollection(completionsPath)) as unknown as TaskCompletion[];

      // Compute current week range (Monday to Sunday in Singapore time)
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const fmt = (d: Date) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      };
      const weekStart = fmt(monday);
      const weekEnd = fmt(sunday);

      const enriched = items.map(rule => {
        if (!rule.categoryId) return rule;

        // Find all templates in this category
        const catTemplates = allTemplates.filter(t => t.categoryId === rule.categoryId && t.isActive !== false);

        // Find weekly completions for these templates
        const weekCompletions = allCompletions.filter(c =>
          catTemplates.some(t => t.id === c.templateId) &&
          c.completedDate >= weekStart &&
          c.completedDate <= weekEnd
        );

        // Count completed per template per day
        const completedCount = weekCompletions.length;

        // Compute expected tasks this week: for each template, determine expected count
        // For daily tasks: 7 days; for weekly tasks: depends on days_of_week; etc.
        let expectedCount = 0;
        const weekDays: string[] = [];
        const d = new Date(monday);
        while (fmt(d) <= weekEnd) {
          weekDays.push(fmt(d));
          d.setDate(d.getDate() + 1);
        }

        for (const tmpl of catTemplates) {
          const cfg = tmpl.recurrenceConfig || {};
          switch (tmpl.recurrenceType) {
            case 'daily':
              expectedCount += 7;
              break;
            case 'weekly': {
              const daysOfWeek = cfg.days_of_week || [];
              if (daysOfWeek.length === 0) {
                expectedCount += 1;
              } else {
                expectedCount += daysOfWeek.length;
              }
              break;
            }
            case 'custom_days': {
              const daysOfWeek = cfg.days_of_week || [];
              expectedCount += daysOfWeek.length;
              break;
            }
            case 'biweekly': {
              // Check if this is an "on" week via base_week
              const baseWeek = cfg.base_week;
              if (baseWeek) {
                const base = new Date(baseWeek + 'T12:00:00');
                const diffWeeks = Math.floor((monday.getTime() - base.getTime()) / (7 * 86400000));
                if (diffWeeks % 2 === 0) {
                  const daysOfWeek = cfg.days_of_week || [];
                  expectedCount += daysOfWeek.length > 0 ? daysOfWeek.length : 1;
                }
              } else {
                expectedCount += 1;
              }
              break;
            }
            case 'monthly':
              expectedCount += 1;
              break;
            default:
              expectedCount += 1;
          }
        }

        // Get today's suggested tasks
        const today = fmt(new Date());
        const todaySuggested = catTemplates
          .filter(tmpl => {
            const cfg = tmpl.recurrenceConfig || {};
            const todayDay = new Date().getDay();
            switch (tmpl.recurrenceType) {
              case 'daily': return true;
              case 'weekly':
              case 'custom_days': {
                const daysOfWeek = cfg.days_of_week || [];
                return daysOfWeek.includes(todayDay === 0 ? 7 : todayDay);
              }
              default: return false;
            }
          })
          .map(t => t.title);

        // Get uncompleted tasks (pending instances for this category)
        const uncompletedList = catTemplates
          .map(tmpl => {
            const lastComp = allCompletions
              .filter(c => c.templateId === tmpl.id)
              .sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];
            return {
              templateId: tmpl.id,
              title: tmpl.title,
              lastCompletedDate: lastComp?.completedDate || null,
            };
          });

        return {
          ...rule,
          categoryStats: {
            total: expectedCount,
            completed: completedCount,
            pending: Math.max(0, expectedCount - completedCount),
            completionRate: expectedCount > 0 ? Math.round((completedCount / expectedCount) * 100) : 0,
            todaySuggested,
            templates: uncompletedList,
          },
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
      };
    }
  );

  server.tool(
    'toggle_reminder',
    '开启或关闭一个提醒规则。设置 isActive 来控制是否触发。',
    {
      id: z.string().describe('提醒规则 ID'),
      isActive: z.boolean().describe('true=开启，false=关闭'),
    },
    async ({ id, isActive }) => {
      const path = collectionPath(RULES_COLLECTION);
      const all = (await fetchCollection(path)) as unknown as ReminderRule[];
      const existing = all.find(r => r.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Rule ${id} not found` }) }] };
      }
      existing.isActive = isActive;
      await upsertDocPlain(path, id, existing as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, isActive }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_pending_reminders',
    '获取当前待发送的提醒列表。根据当前时间和规则配置判断哪些提醒应该触发但尚未发送。',
    {},
    async () => {
      const rulesPath = collectionPath(RULES_COLLECTION);
      const logsPath = collectionPath(LOGS_COLLECTION);

      const rules = (await fetchCollection(rulesPath)) as unknown as ReminderRule[];
      const allLogs = (await fetchCollection(logsPath)) as unknown as ReminderLog[];

      const today = todayStr();
      const nowTime = currentHHmm();

      // Only active rules that are not suspended
      const activeRules = rules.filter(r => {
        if (!r.isActive) return false;
        if (r.suspendStartDate && r.suspendStartDate <= today && r.suspendEndDate && r.suspendEndDate >= today) {
          return false; // currently suspended
        }
        return true;
      });

      const pending: {
        ruleId: string;
        title: string;
        channel: string;
        messageTemplate?: string;
        scheduledTime: string;
      }[] = [];

      for (const rule of activeRules) {
        const type = rule.scheduleConfig['type'];

        if (type === 'fixed') {
          const scheduledTime = rule.scheduleConfig['time'];
          if (!scheduledTime) continue;

          // Check if already sent today
          const alreadySent = allLogs.some(
            l => l.ruleId === rule.id && l.scheduledTime.startsWith(today) && l.status !== 'skipped'
          );
          if (alreadySent) continue;

          // Check if it's time to send (scheduled time <= current time)
          if (scheduledTime <= nowTime) {
            pending.push({
              ruleId: rule.id,
              title: rule.title,
              channel: rule.channel,
              messageTemplate: rule.messageTemplate,
              scheduledTime: `${today} ${scheduledTime}`,
            });
          }
        } else if (type === 'interval') {
          const startTime = rule.scheduleConfig['start_time'];
          const endTime = rule.scheduleConfig['end_time'];
          const intervalMin = rule.scheduleConfig['interval_minutes'] || 60;
          const workdaysOnly = rule.scheduleConfig['workdays_only'];
          
          if (!startTime || !endTime) continue;

          // Check workday rule
          const dayOfWeek = new Date().getDay(); // 0=Sun
          if (workdaysOnly && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

          // Check if current time is within the window
          if (nowTime < startTime || nowTime > endTime) continue;

          // Calculate how many intervals have passed since start_time
          const startMins = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]);
          const nowMins = parseInt(nowTime.split(':')[0]) * 60 + parseInt(nowTime.split(':')[1]);
          const elapsedMins = nowMins - startMins;
          const intervalsPassed = Math.floor(elapsedMins / intervalMin);

          if (intervalsPassed >= 0) {
            const scheduledMin = startMins + (intervalsPassed * intervalMin);
            const hh = String(Math.floor(scheduledMin / 60)).padStart(2, '0');
            const mm = String(scheduledMin % 60).padStart(2, '0');
            const intervalTime = `${hh}:${mm}`;

            // Check if already sent for this interval
            const alreadySent = allLogs.some(
              l => l.ruleId === rule.id && l.scheduledTime.includes(` ${intervalTime}`) && l.status !== 'skipped'
            );
            if (alreadySent) continue;

            pending.push({
              ruleId: rule.id,
              title: rule.title,
              channel: rule.channel,
              messageTemplate: rule.messageTemplate || `⏰ ${rule.title}`,
              scheduledTime: `${today} ${intervalTime}`,
            });
          }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(pending, null, 2) }],
      };
    }
  );

  server.tool(
    'acknowledge_reminder',
    '确认提醒已送达。创建或更新一条提醒日志记录，标记为已发送。',
    {
      ruleId: z.string().describe('提醒规则 ID'),
      instanceId: z.string().optional().describe('关联的任务实例 ID'),
      channel: z.string().optional().describe('实际发送渠道'),
      status: z.enum(['sent', 'delivered', 'failed']).optional().default('sent').describe('发送状态'),
      errorMessage: z.string().optional().describe('失败时的错误信息'),
    },
    async ({ ruleId, instanceId, channel, status, errorMessage }) => {
      const id = generateId('rl');
      const now = nowISO();
      const scheduleTime = `${todayStr()} ${currentHHmm()}`;
      const log: ReminderLog = {
        id,
        ruleId,
        instanceId,
        scheduledTime: scheduleTime,
        sentAt: now,
        channel: channel || 'telegram',
        status: status as ReminderLog['status'],
        errorMessage,
        deliveredAt: status === 'delivered' ? now : undefined,
      };
      await upsertDocPlain(collectionPath(LOGS_COLLECTION), id, log as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, log }, null, 2) }],
      };
    });

  // ── Delete Reminder Rule ──
  server.tool(
    'delete_reminder_rule',
    '删除一条提醒规则。删除后不会影响已有提醒日志。',
    {
      id: z.string().describe('提醒规则 ID'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(RULES_COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );
}
