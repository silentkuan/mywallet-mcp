import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDocPlain, deleteDocById } from '../firestore.js';
import { ContentTemplate } from '../types.js';

const COLLECTION = 'contentTemplates';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function registerContentTemplateTools(server: McpServer): void {

  // ── Create ──
  server.tool(
    'create_content_template',
    '创建内容模板。定义提醒消息的生成格式和 AI prompt。',
    {
      reminderRuleId: z.string().optional().describe('关联的提醒规则 ID（可选）'),
      title: z.string().min(1).describe('模板标题，如 🤖 双语科技早报'),
      format: z.string().min(1).describe('生成格式模板（支持变量替换）'),
      prompt: z.string().min(1).describe('AI prompt 提示词'),
      isActive: z.boolean().optional().default(true).describe('是否启用'),
    },
    async (input) => {
      const id = generateId('ct');
      const template: ContentTemplate = {
        id,
        reminderRuleId: input.reminderRuleId,
        title: input.title,
        format: input.format,
        prompt: input.prompt,
        isActive: input.isActive ?? true,
      };
      await upsertDocPlain(collectionPath(COLLECTION), id, template as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, template }, null, 2) }],
      };
    }
  );

  // ── List ──
  server.tool(
    'get_content_templates',
    '列出所有内容模板。可按 reminderRuleId 筛选。',
    {
      reminderRuleId: z.string().optional().describe('按提醒规则 ID 筛选'),
      isActive: z.boolean().optional().describe('按活跃状态筛选'),
    },
    async ({ reminderRuleId, isActive }) => {
      const path = collectionPath(COLLECTION);
      let items = (await fetchCollection(path)) as unknown as ContentTemplate[];
      if (reminderRuleId) {
        items = items.filter(t => t.reminderRuleId === reminderRuleId);
      }
      if (isActive !== undefined) {
        items = items.filter(t => t.isActive === isActive);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // ── Update ──
  server.tool(
    'update_content_template',
    '更新内容模板的字段。只传入需要修改的字段。',
    {
      id: z.string().describe('模板 ID'),
      reminderRuleId: z.string().optional().nullable(),
      title: z.string().optional(),
      format: z.string().optional(),
      prompt: z.string().optional(),
      isActive: z.boolean().optional(),
    },
    async ({ id, ...updates }) => {
      const path = collectionPath(COLLECTION);
      const all = (await fetchCollection(path)) as unknown as ContentTemplate[];
      const existing = all.find(t => t.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `ContentTemplate ${id} not found` }) }] };
      }
      const updated: ContentTemplate = { ...existing } as ContentTemplate;
      if (updates.title !== undefined) updated.title = updates.title;
      if (updates.format !== undefined) updated.format = updates.format;
      if (updates.prompt !== undefined) updated.prompt = updates.prompt;
      if (updates.isActive !== undefined) updated.isActive = updates.isActive;
      if (updates.reminderRuleId !== undefined) {
        updated.reminderRuleId = updates.reminderRuleId || undefined;
      }
      await upsertDocPlain(path, id, updated as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, template: updated }, null, 2) }],
      };
    }
  );

  // ── Delete ──
  server.tool(
    'delete_content_template',
    '删除一个内容模板。',
    {
      id: z.string().describe('模板 ID'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );
}
