import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, nowISO, jsonResult, slugify, saveHealthDoc, listHealthDocs, getHealthDoc,
} from './healthCommon.js';
import { GYM_COACH_SEED } from '../seeds/gymCoach.js';

const MODES = HEALTH_COLLECTIONS.coachModes;
const VERSIONS = HEALTH_COLLECTIONS.coachModeVersions;

export type CoachMode = {
  id: string;
  name: string;
  description?: string;
  triggers: string[];
  instructions: string;
  isActive: boolean;
  version: number;
  updatedAt: string;
  createdAt: string;
};

// Every version (including the current one) is kept as a full snapshot, so history and rollback
// never depend on diffs.
export type CoachModeVersion = CoachMode & { modeId: string; changeNote?: string };

const versionId = (modeId: string, version: number) => `${modeId}-v${version}`;

async function saveVersion(mode: CoachMode, changeNote?: string): Promise<void> {
  const snapshot: CoachModeVersion = { ...mode, id: versionId(mode.id, mode.version), modeId: mode.id, changeNote };
  await saveHealthDoc(VERSIONS, snapshot.id, snapshot as Record<string, unknown>);
}

export async function getCoachMode(name: string): Promise<CoachMode | null> {
  return getHealthDoc<CoachMode>(MODES, slugify(name));
}

/** Write a new version of a mode (creating it when missing) and keep the snapshot. */
export async function writeCoachMode(
  name: string,
  patch: Partial<Pick<CoachMode, 'description' | 'triggers' | 'instructions' | 'isActive'>>,
  changeNote?: string,
): Promise<CoachMode> {
  const id = slugify(name);
  if (!id) throw new Error('name 需要包含英文字母或数字，例如 gym-coach');
  const existing = await getHealthDoc<CoachMode>(MODES, id);
  if (!existing && !patch.instructions) throw new Error(`教练模式 ${name} 不存在，新建时必须提供 instructions`);
  const now = nowISO();
  const mode: CoachMode = {
    id,
    name: existing?.name ?? name,
    description: patch.description ?? existing?.description,
    triggers: patch.triggers ?? existing?.triggers ?? [],
    instructions: patch.instructions ?? existing!.instructions,
    isActive: patch.isActive ?? existing?.isActive ?? true,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveHealthDoc(MODES, id, mode as Record<string, unknown>);
  await saveVersion(mode, changeNote);
  return mode;
}

/** Create gym-coach v1 the first time the server starts against a database without it. */
export async function seedCoachModes(): Promise<void> {
  if (await getCoachMode(GYM_COACH_SEED.name)) return;
  const { name, ...rest } = GYM_COACH_SEED;
  await writeCoachMode(name, { ...rest, isActive: true }, '初始版本');
  console.log('🌱 Seeded coach mode gym-coach v1');
}

async function listVersions(modeId: string): Promise<CoachModeVersion[]> {
  const all = await listHealthDocs<CoachModeVersion>(VERSIONS);
  return all.filter(v => v.modeId === modeId).sort((a, b) => b.version - a.version);
}

export function registerCoachModeTools(server: McpServer): void {

  server.tool(
    'list_coach_modes',
    '列出所有教练模式（名称、说明、触发说法、是否启用、目前版本），不含完整内容。要看内容用 get_coach_mode。',
    {},
    async () => {
      const modes = await listHealthDocs<CoachMode>(MODES);
      return jsonResult(modes
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ instructions, ...m }) => ({ ...m, instructionsLength: instructions?.length ?? 0 })));
    }
  );

  server.tool(
    'get_coach_mode',
    '读取一个教练模式的完整内容（instructions 是要照着执行的规则）。用户在健身房、问今天练什么、说「下一个」「第 N 组完成」「这个几 kg」时，先调用 get_coach_mode("gym-coach")。',
    { name: z.string().min(1).describe('模式名称，如 gym-coach') },
    async ({ name }) => {
      const mode = await getCoachMode(name);
      if (!mode) return jsonResult({ success: false, error: `找不到教练模式 ${name}，可用 list_coach_modes 查看` });
      return jsonResult(mode);
    }
  );

  server.tool(
    'upsert_coach_mode',
    '新增或修改教练模式。用户要新增或修改教练方式时使用（例如「以后组间休息改 90 秒」）：先 get_coach_mode 拿到目前内容，改好后传完整的 instructions。每次保存版本号 +1，旧版本保留可回滚。只传要改的字段，其他沿用。',
    {
      name: z.string().min(1).describe('模式名称（英文，如 gym-coach）'),
      instructions: z.string().min(1).optional().describe('完整的规则内容（markdown），会整份替换；新建时必填'),
      description: z.string().optional(),
      triggers: z.array(z.string()).optional().describe('触发这个模式的中文说法，整份替换'),
      isActive: z.boolean().optional(),
      changeNote: z.string().optional().describe('这次改了什么，一句话，会记在历史版本里'),
    },
    async ({ name, changeNote, ...patch }) => {
      try {
        const mode = await writeCoachMode(name, patch, changeNote);
        return jsonResult({ success: true, mode });
      } catch (e) {
        return jsonResult({ success: false, error: (e as Error).message });
      }
    }
  );

  server.tool(
    'get_coach_mode_history',
    '列出教练模式的历史版本（新到旧），含每版的修改说明。includeInstructions=true 时附完整内容。',
    {
      name: z.string().min(1),
      includeInstructions: z.boolean().optional(),
    },
    async ({ name, includeInstructions }) => {
      const versions = await listVersions(slugify(name));
      if (!versions.length) return jsonResult({ success: false, error: `找不到教练模式 ${name} 的历史` });
      return jsonResult(versions.map(({ instructions, ...v }) => (
        includeInstructions ? { ...v, instructions } : { ...v, instructionsLength: instructions.length }
      )));
    }
  );

  server.tool(
    'rollback_coach_mode',
    '把教练模式回滚到某个历史版本。不会删除任何版本：会用旧版本的内容存成一个新版本（版本号继续 +1）。',
    {
      name: z.string().min(1),
      version: z.number().int().min(1).describe('要回到的版本号，可用 get_coach_mode_history 查'),
    },
    async ({ name, version }) => {
      const id = slugify(name);
      const target = await getHealthDoc<CoachModeVersion>(VERSIONS, versionId(id, version));
      if (!target) return jsonResult({ success: false, error: `找不到 ${name} 的第 ${version} 版` });
      const mode = await writeCoachMode(name, {
        instructions: target.instructions,
        description: target.description,
        triggers: target.triggers,
        isActive: target.isActive,
      }, `回滚到第 ${version} 版`);
      return jsonResult({ success: true, rolledBackTo: version, mode });
    }
  );
}
