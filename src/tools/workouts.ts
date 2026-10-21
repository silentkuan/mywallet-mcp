import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, dateSchema, generateId, nowISO, round, jsonResult, mergePatch, addDays, todayStr,
  saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';

const COLLECTION = HEALTH_COLLECTIONS.workouts;

export const WORKOUT_TYPES = [
  'strength', 'stair_stepper', 'running', 'walking', 'cycling', 'indoor_cycling', 'elliptical', 'rowing',
  'swimming', 'hiit', 'functional', 'yoga', 'pilates', 'core', 'stretching', 'badminton', 'basketball',
  'football', 'tennis', 'hiking', 'other',
] as const;

const setSchema = z.object({
  reps: z.number().int().min(0).optional(),
  weightKg: z.number().min(0).optional().describe('总重量 kg（器械按显示重量）'),
  durationSec: z.number().min(0).optional().describe('计时动作，如平板支撑'),
  rpe: z.number().min(1).max(10).optional(),
});

const exerciseSchema = z.object({
  name: z.string().describe('动作名称，如 Bench Press、Lat Pulldown；同一动作每次用同一名字'),
  muscleGroup: z.enum(['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cardio']).optional(),
  sets: z.array(setSchema).optional(),
  notes: z.string().optional(),
});

const workoutShape = {
  date: dateSchema,
  startTime: z.string().optional().describe('HH:mm'),
  endTime: z.string().optional().describe('HH:mm'),
  type: z.enum(WORKOUT_TYPES).describe('Apple Watch: Traditional Strength Training→strength, Stair Stepper→stair_stepper, Functional Strength→functional'),
  name: z.string().optional().describe('显示名称，如「Push Day」「Traditional Strength Training」'),
  durationMin: z.number().min(0),
  activeKcal: z.number().min(0).optional().describe('活动消耗（Apple Watch 的 Active Calories）'),
  totalKcal: z.number().min(0).optional(),
  avgHeartRate: z.number().min(0).optional(),
  minHeartRate: z.number().min(0).optional(),
  maxHeartRate: z.number().min(0).optional(),
  distanceKm: z.number().min(0).optional(),
  elevationM: z.number().min(0).optional(),
  avgPace: z.string().optional().describe('如 6:30 /km'),
  effort: z.number().min(1).max(10).optional().describe('Apple Watch 训练强度 1–10'),
  exercises: z.array(exerciseSchema).optional().describe('重训的动作、组数、次数、重量'),
  source: z.enum(['apple_watch', 'manual', 'gym_machine', 'other']).optional(),
  notes: z.string().optional(),
};

const workoutObject = z.object(workoutShape);
export type Workout = z.infer<typeof workoutObject> & { id: string; createdAt: string; updatedAt?: string };

export async function listWorkouts(startDate?: string, endDate?: string): Promise<Workout[]> {
  const w = await listHealthDocs<Workout>(COLLECTION, startDate, endDate);
  return w.sort((a, b) => `${b.date} ${b.startTime ?? ''}`.localeCompare(`${a.date} ${a.startTime ?? ''}`));
}

export function summarizeWorkouts(workouts: Workout[], startDate: string, endDate: string) {
  const days = Math.max(1, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1);
  const byType: Record<string, { sessions: number; minutes: number; kcal: number }> = {};
  let minutes = 0, kcal = 0;
  for (const w of workouts) {
    minutes += w.durationMin;
    kcal += w.activeKcal ?? 0;
    const t = (byType[w.type] ??= { sessions: 0, minutes: 0, kcal: 0 });
    t.sessions++; t.minutes += w.durationMin; t.kcal += w.activeKcal ?? 0;
  }
  return {
    startDate, endDate, days,
    sessions: workouts.length,
    activeDays: new Set(workouts.map(w => w.date)).size,
    totalMinutes: round(minutes, 0),
    totalActiveKcal: round(kcal, 0),
    avgMinutesPerDay: round(minutes / days, 0),
    strengthSessions: workouts.filter(w => w.type === 'strength' || w.type === 'functional').length,
    byType,
  };
}

// Best set per exercise over time — shows whether strength is progressing
function exerciseProgress(workouts: Workout[]) {
  const progress: Record<string, { date: string; bestWeightKg: number; repsAtBest: number; volumeKg: number }[]> = {};
  for (const w of [...workouts].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const ex of w.exercises ?? []) {
      const sets = ex.sets ?? [];
      if (!sets.length) continue;
      const best = sets.reduce((b, s) => ((s.weightKg ?? 0) > (b.weightKg ?? 0) ? s : b), sets[0]);
      const volume = sets.reduce((v, s) => v + (s.weightKg ?? 0) * (s.reps ?? 0), 0);
      (progress[ex.name] ??= []).push({ date: w.date, bestWeightKg: best.weightKg ?? 0, repsAtBest: best.reps ?? 0, volumeKg: round(volume, 0) });
    }
  }
  return progress;
}

export function registerWorkoutTools(server: McpServer): void {

  server.tool(
    'log_workout',
    '记录一次运动。可从 Apple Watch 截图读取（类型、时长、活动卡路里、心率），或由用户文字描述。重训尽量记录每个动作的组数、次数和重量。只记录单次运动；「过去 7 天平均」这类汇总不要当成一次运动记录。',
    workoutShape,
    async (input) => {
      const id = generateId('workout');
      const workout: Workout = { ...input, id, createdAt: nowISO() };
      await saveHealthDoc(COLLECTION, id, workout as Record<string, unknown>);
      return jsonResult({ success: true, workout });
    }
  );

  server.tool(
    'get_workouts',
    '获取运动记录和统计（次数、运动天数、总时长、活动卡路里、按类型分）。includeProgress=true 时附带每个重训动作的最佳重量走势。默认最近 28 天。',
    {
      startDate: dateSchema.optional(),
      endDate: dateSchema.optional(),
      type: z.enum(WORKOUT_TYPES).optional(),
      includeProgress: z.boolean().optional(),
    },
    async ({ startDate, endDate, type, includeProgress }) => {
      const end = endDate ?? todayStr();
      const start = startDate ?? addDays(end, -27);
      const workouts = (await listWorkouts(start, end)).filter(w => !type || w.type === type);
      return jsonResult({
        summary: summarizeWorkouts(workouts, start, end),
        workouts,
        exerciseProgress: includeProgress ? exerciseProgress(await listWorkouts()) : undefined,
      });
    }
  );

  server.tool(
    'update_workout',
    '修改一次运动记录。只传要改的字段；传 exercises 会整体替换动作列表；传 null 清除字段。',
    {
      id: z.string(),
      ...Object.fromEntries(Object.entries(workoutShape).map(([k, s]) => [k, (s as z.ZodTypeAny).nullable().optional()])),
    },
    async ({ id, ...patch }) => {
      const existing = await getHealthDoc<Workout>(COLLECTION, id);
      if (!existing) return jsonResult({ success: false, error: `Workout ${id} not found` });
      const updated = mergePatch(existing as Record<string, unknown>, patch) as Workout;
      updated.updatedAt = nowISO();
      await saveHealthDoc(COLLECTION, id, updated as Record<string, unknown>);
      return jsonResult({ success: true, workout: updated });
    }
  );

  server.tool(
    'delete_workout',
    '删除一次运动记录。',
    { id: z.string() },
    async ({ id }) => jsonResult({ success: await deleteHealthDoc(COLLECTION, id) })
  );
}
