import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, upsertDocPlain } from '../firestore.js';
import { TravelPlan } from '../types.js';

const COLLECTION = 'travelPlans';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function registerTravelTools(server: McpServer): void {

  server.tool(
    'create_travel_plan',
    '创建出行计划。出行期间可暂停工作日/周末提醒和指定分类的任务。',
    {
      title: z.string().min(1).describe('计划标题，如「上海出差」'),
      destination: z.string().optional().describe('目的地'),
      startDate: z.string().describe('出发日期 YYYY-MM-DD'),
      endDate: z.string().describe('返回日期 YYYY-MM-DD'),
      pauseWorkdayReminders: z.boolean().optional().default(true).describe('是否暂停工作日提醒'),
      pauseWeekendReminders: z.boolean().optional().default(true).describe('是否暂停周末提醒'),
      pauseCategoryIds: z.array(z.string()).optional().default([]).describe('暂停的任务分类 ID 列表'),
      note: z.string().optional().describe('备注'),
    },
    async (input) => {
      const id = generateId('travel');
      const plan: TravelPlan = {
        id,
        title: input.title,
        destination: input.destination,
        startDate: input.startDate,
        endDate: input.endDate,
        pauseWorkdayReminders: input.pauseWorkdayReminders ?? true,
        pauseWeekendReminders: input.pauseWeekendReminders ?? true,
        pauseCategoryIds: input.pauseCategoryIds ?? [],
        isActive: true,
        isCompleted: false,
        note: input.note,
      };
      await upsertDocPlain(collectionPath(COLLECTION), id, plan as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, plan }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_travel_plans',
    '获取所有出行计划。可按活跃状态筛选。',
    {
      isActive: z.boolean().optional().describe('按活跃状态筛选'),
      isCompleted: z.boolean().optional().describe('按完成状态筛选'),
    },
    async ({ isActive, isCompleted }) => {
      const path = collectionPath(COLLECTION);
      let items = (await fetchCollection(path)) as unknown as TravelPlan[];
      if (isActive !== undefined) items = items.filter(p => p.isActive === isActive);
      if (isCompleted !== undefined) items = items.filter(p => p.isCompleted === isCompleted);
      // Sort by startDate descending
      items.sort((a, b) => b.startDate.localeCompare(a.startDate));
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  server.tool(
    'toggle_travel_plan',
    '更新出行计划的状态。可启用/禁用计划，或标记为已完成。',
    {
      id: z.string().describe('出行计划 ID'),
      isActive: z.boolean().optional().describe('是否启用'),
      isCompleted: z.boolean().optional().describe('是否已完成'),
    },
    async ({ id, isActive, isCompleted }) => {
      const path = collectionPath(COLLECTION);
      const all = (await fetchCollection(path)) as unknown as TravelPlan[];
      const existing = all.find(p => p.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Plan ${id} not found` }) }] };
      }
      if (isActive !== undefined) existing.isActive = isActive;
      if (isCompleted !== undefined) existing.isCompleted = isCompleted;
      await upsertDocPlain(path, id, existing as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, plan: existing }, null, 2) }],
      };
    }
  );
}
