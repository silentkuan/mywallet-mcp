import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HEALTH_COLLECTIONS, nowISO, jsonResult, slugify, saveHealthDoc, listHealthDocs, getHealthDoc } from './healthCommon.js';
import { MUSCLE_GROUPS, EQUIPMENT } from './workouts.js';

const LIBRARY = HEALTH_COLLECTIONS.exerciseLibrary;

const libraryShape = {
  name: z.string().min(1).describe('统一英文名，如 Goblet Squat；记录训练时也用这个名字'),
  nameZh: z.string().optional().describe('中文名，如 高脚杯深蹲'),
  aliases: z.array(z.string()).optional().describe('其他叫法（中英文），如 ["杯式深蹲", "DB Goblet Squat"]'),
  muscleGroup: z.enum(MUSCLE_GROUPS).optional(),
  equipment: z.enum(EQUIPMENT).optional(),
  cues: z.array(z.string()).optional().describe('动作要点，3-4 条'),
  imageQuery: z.string().optional().describe('搜示范图用的英文关键词，如 "goblet squat proper form"'),
  imageUrl: z.string().url().optional(),
};

const libraryObject = z.object(libraryShape);
export type LibraryExercise = z.infer<typeof libraryObject> & { id: string; aliases: string[]; cues: string[]; updatedAt: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function listLibrary(): Promise<LibraryExercise[]> {
  return listHealthDocs<LibraryExercise>(LIBRARY);
}

/** Find a library entry by English name, Chinese name or alias. */
export function matchExercise(library: LibraryExercise[], query: string): LibraryExercise | undefined {
  const q = norm(query);
  const id = slugify(query);
  return library.find(e => e.id === id)
    ?? library.find(e => [e.name, e.nameZh ?? '', ...(e.aliases ?? [])].some(n => n && norm(n) === q));
}

export function registerExerciseLibraryTools(server: McpServer): void {

  server.tool(
    'get_exercise',
    '从动作库读取一个动作（中英文名或别名都可以）：动作要点 cues、器材、部位、搜图关键词 imageQuery。',
    { name: z.string().min(1) },
    async ({ name }) => {
      const found = matchExercise(await listLibrary(), name);
      if (!found) return jsonResult({ success: false, error: `动作库还没有「${name}」，可以用 upsert_exercise 新增` });
      return jsonResult(found);
    }
  );

  server.tool(
    'search_exercises',
    '搜索动作库。query 会比对英文名、中文名和别名（部分符合即可）；可按部位、器材筛选。都不传就列出全部。',
    {
      query: z.string().optional(),
      muscleGroup: z.enum(MUSCLE_GROUPS).optional(),
      equipment: z.enum(EQUIPMENT).optional(),
    },
    async ({ query, muscleGroup, equipment }) => {
      const q = query ? norm(query) : '';
      const results = (await listLibrary())
        .filter(e => !muscleGroup || e.muscleGroup === muscleGroup)
        .filter(e => !equipment || e.equipment === equipment)
        .filter(e => !q || [e.name, e.nameZh ?? '', ...(e.aliases ?? [])].some(n => norm(n).includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonResult({ count: results.length, exercises: results });
    }
  );

  server.tool(
    'upsert_exercise',
    '新增或修改动作库里的动作（以英文 name 为准）。只传要改的字段；aliases、cues 传了会整份替换。第一次教用户一个动作时建议存进来，下次就有要点和搜图关键词。',
    libraryShape,
    async (input) => {
      const id = slugify(input.name);
      if (!id) return jsonResult({ success: false, error: 'name 需要是英文名，例如 Goblet Squat' });
      const existing = await getHealthDoc<LibraryExercise>(LIBRARY, id);
      const entry: LibraryExercise = {
        ...existing,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        id,
        aliases: input.aliases ?? existing?.aliases ?? [],
        cues: input.cues ?? existing?.cues ?? [],
        updatedAt: nowISO(),
      } as LibraryExercise;
      await saveHealthDoc(LIBRARY, id, entry as Record<string, unknown>);
      return jsonResult({ success: true, created: !existing, exercise: entry });
    }
  );
}
