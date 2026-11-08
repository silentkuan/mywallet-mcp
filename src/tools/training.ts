import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_COLLECTIONS, dateSchema, generateId, nowISO, nowHHmm, round, jsonResult, addDays, daysBetween, todayStr,
  slugify, saveHealthDoc, listHealthDocs, getHealthDoc, deleteHealthDoc,
} from './healthCommon.js';
import {
  Workout, Exercise, WorkoutSet, WorkoutSource, WORKOUT_TYPES, WORKOUT_SOURCES, MUSCLE_GROUPS, EQUIPMENT,
  setSchema, listWorkouts, setTotalKg, workoutSources, workoutMuscleGroups,
} from './workouts.js';
import { listLibrary, matchExercise, LibraryExercise } from './exerciseLibrary.js';
import type { DailyMetrics } from './dailyMetrics.js';

const WORKOUTS = HEALTH_COLLECTIONS.workouts;
const PLAN = HEALTH_COLLECTIONS.trainingPlan;
const PLAN_ID = 'weekly';

// ─── Shared helpers (also used by the backfill script) ────────────────────────

// Apple Watch names map onto these; a coach-logged "strength" session pairs with any of them
const TYPE_FAMILIES: string[][] = [
  ['strength', 'functional', 'core', 'hiit'],
  ['stair_stepper'],
  ['walking', 'hiking'],
  ['running'],
  ['cycling', 'indoor_cycling'],
];

export function typesCompatible(a: string, b: string): boolean {
  return a === b || TYPE_FAMILIES.some(f => f.includes(a) && f.includes(b));
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

function interval(startTime?: string, endTime?: string, durationMin?: number): [number, number] | null {
  if (!startTime) return null;
  const s = toMin(startTime);
  let e = endTime ? toMin(endTime) : s + (durationMin ?? 0);
  if (e < s) e += 24 * 60; // finished after midnight
  return [s, e];
}

/** Same session if the times overlap or are within two hours. Unknown times can't rule a match out. */
export function timesClose(a: [number, number] | null, b: [number, number] | null): boolean {
  if (!a || !b) return true;
  const gap = a[0] <= b[1] && b[0] <= a[1] ? 0 : (b[0] > a[1] ? b[0] - a[1] : a[0] - b[1]);
  return gap <= 120;
}

const hasExercises = (w: Workout) => (w.exercises ?? []).length > 0;
const hasKcal = (w: Workout) => (w.activeKcal ?? 0) > 0 || (w.totalKcal ?? 0) > 0;

/** Likely duplicates: same day, one has exercises but no calories, the other calories but no exercises. */
export function findDuplicatePairs(workouts: Workout[]): { date: string; withExercises: Workout; withCalories: Workout }[] {
  const pairs: { date: string; withExercises: Workout; withCalories: Workout }[] = [];
  for (const a of workouts) {
    if (!hasExercises(a) || hasKcal(a)) continue;
    for (const b of workouts) {
      if (b.id === a.id || b.date !== a.date || hasExercises(b) || !hasKcal(b) || !typesCompatible(a.type, b.type)) continue;
      pairs.push({ date: a.date, withExercises: a, withCalories: b });
    }
  }
  return pairs;
}

const SUMMARY_FIELDS = [
  'startTime', 'endTime', 'durationMin', 'activeKcal', 'totalKcal', 'avgHeartRate', 'minHeartRate', 'maxHeartRate',
  'distanceKm', 'elevationM', 'avgPace', 'effort',
] as const;
const MERGE_SCALAR_FIELDS = ['type', 'name', 'source', ...SUMMARY_FIELDS] as const;
type ScalarField = typeof MERGE_SCALAR_FIELDS[number];

export type MergeConflict = { field: string; primary?: unknown; secondary?: unknown; kept?: unknown; note?: string };

const setKey = (s: WorkoutSet) => [s.type ?? '', setTotalKg(s) ?? '', s.reps ?? '', s.durationSec ?? ''].join('|');

/** Combine two workouts into the primary. Nothing from either side is dropped silently. */
export function mergeWorkoutPair(primary: Workout, secondary: Workout, useSecondaryFor: string[] = []) {
  const conflicts: MergeConflict[] = [];
  const merged: Workout = { ...primary };

  for (const field of MERGE_SCALAR_FIELDS) {
    const p = primary[field as ScalarField];
    const s = secondary[field as ScalarField];
    if (s === undefined || s === null) continue;
    if (p === undefined || p === null) { (merged as Record<string, unknown>)[field] = s; continue; }
    if (p !== s) {
      const kept = useSecondaryFor.includes(field) ? s : p;
      (merged as Record<string, unknown>)[field] = kept;
      conflicts.push({ field, primary: p, secondary: s, kept });
    }
  }

  if (primary.notes && secondary.notes && primary.notes !== secondary.notes) {
    merged.notes = `${primary.notes} / ${secondary.notes}`;
    conflicts.push({ field: 'notes', note: '两笔都有备注，已合并成一段' });
  } else {
    merged.notes = primary.notes ?? secondary.notes;
  }

  const exercises: Exercise[] = (primary.exercises ?? []).map(e => ({ ...e, sets: [...(e.sets ?? [])] }));
  for (const ex of secondary.exercises ?? []) {
    const target = exercises.find(e => slugify(e.name) === slugify(ex.name));
    if (!target) { exercises.push({ ...ex, sets: [...(ex.sets ?? [])] }); continue; }
    const seen = new Set((target.sets ?? []).map(setKey));
    const extra = (ex.sets ?? []).filter(s => !seen.has(setKey(s)));
    if (extra.length && target.sets?.length) {
      conflicts.push({ field: `exercises.${ex.name}`, note: `两笔都有这个动作的组数，已合并（另加 ${extra.length} 组）并重新编号` });
    }
    target.sets = [...(target.sets ?? []), ...extra].map((s, i) => ({ ...s, setNo: i + 1 }));
    target.nameZh ??= ex.nameZh;
    target.equipment ??= ex.equipment;
    target.muscleGroup ??= ex.muscleGroup;
  }
  if (exercises.length) merged.exercises = exercises;

  merged.sources = [...new Set([...workoutSources(primary), ...workoutSources(secondary)])];
  merged.createdAt = primary.createdAt < secondary.createdAt ? primary.createdAt : secondary.createdAt;
  merged.updatedAt = nowISO();
  return { merged, conflicts };
}

function withSource(w: Workout, source: WorkoutSource): WorkoutSource[] {
  const list = workoutSources(w);
  return list.includes(source) ? list : [...list, source];
}

const brief = (w: Workout) => ({
  id: w.id, date: w.date, type: w.type, name: w.name, startTime: w.startTime, endTime: w.endTime,
  durationMin: w.durationMin, activeKcal: w.activeKcal, sources: workoutSources(w),
  exercises: (w.exercises ?? []).map(e => `${e.name} × ${(e.sets ?? []).length} 组`),
});

// ─── Exercise history ─────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function exerciseNames(query: string, lib?: LibraryExercise): Set<string> {
  return new Set([query, lib?.name, lib?.nameZh, ...(lib?.aliases ?? [])].filter((n): n is string => !!n).map(norm));
}

function sessionStats(sets: WorkoutSet[]) {
  const working = sets.filter(s => s.type !== 'warmup');
  const counted = working.length ? working : sets;
  const best = counted.reduce<WorkoutSet | undefined>((b, s) => ((setTotalKg(s) ?? 0) > (setTotalKg(b ?? {}) ?? -1) ? s : b), undefined);
  const volume = counted.reduce((v, s) => v + (setTotalKg(s) ?? 0) * (s.reps ?? 0), 0);
  return { best, bestWeightKg: best ? setTotalKg(best) ?? 0 : 0, volumeKg: round(volume, 0) };
}

// ─── Training plan ────────────────────────────────────────────────────────────

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = typeof DAY_KEYS[number];
const dayKey = (date: string): DayKey => DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

const planDaySchema = z.object({
  focus: z.array(z.string()).describe('这天练什么：部位（chest/back/shoulders/legs/arms/glutes/core/cardio）或文字，如 "爬楼梯 30 分钟"、"休息"'),
  targetMin: z.number().min(0).optional().describe('目标时长（分钟）'),
  notes: z.string().optional(),
});
type PlanDay = z.infer<typeof planDaySchema>;
type TrainingPlan = { id: string; days: Partial<Record<DayKey, PlanDay>>; goal?: string; notes?: string; updatedAt: string };

const getPlan = () => getHealthDoc<TrainingPlan>(PLAN, PLAN_ID);

// ─── Tools ────────────────────────────────────────────────────────────────────

export function registerTrainingTools(server: McpServer): void {

  server.tool(
    'log_set',
    '记录刚做完的一组（健身房教练模式用，每组完成就调用一次）。传 workoutId，或只传 date（默认今天）：当天还没有重训记录就自动新建一笔。同一个动作的组数会往后接；传了已存在的 setNo 会覆盖那一组（用户纠正时用）。重量照用户说的记：weight + unit，挂片机器/杠铃每边重量设 perSide=true，杠铃加 barKg=20；系统会算出总重 weightKg。',
    {
      workoutId: z.string().optional().describe('要记到哪一笔 workout；不传就按 date 找当天的重训'),
      date: dateSchema.optional().describe('默认今天'),
      exercise: z.object({
        name: z.string().min(1).describe('统一英文名，如 Goblet Squat；动作库有的话会自动对齐名称'),
        nameZh: z.string().optional(),
        equipment: z.enum(EQUIPMENT).optional(),
        muscleGroup: z.enum(MUSCLE_GROUPS).optional(),
        notes: z.string().optional(),
      }),
      set: setSchema.omit({ loggedAt: true, weightKg: true }).extend({
        weightKg: z.number().min(0).optional().describe('只有在没有 weight 时才直接填总重 kg'),
      }),
    },
    async ({ workoutId, date, exercise, set }) => {
      let workout: Workout | null = null;
      let created = false;
      const day = date ?? todayStr();

      if (workoutId) {
        workout = await getHealthDoc<Workout>(WORKOUTS, workoutId);
        if (!workout) return jsonResult({ success: false, error: `Workout ${workoutId} not found` });
      } else {
        const strength = (await listWorkouts(day, day)).filter(w => typesCompatible(w.type, 'strength'));
        const coach = strength.filter(w => workoutSources(w).includes('coach-log'));
        if (coach.length === 1) workout = coach[0];
        else if (coach.length === 0 && strength.length === 1) workout = strength[0];
        else if (coach.length > 1 || strength.length > 1) {
          return jsonResult({
            success: false, status: 'ambiguous',
            error: '这天有多笔重训记录，请问用户是哪一笔，再带 workoutId 重试',
            candidates: (coach.length > 1 ? coach : strength).map(brief),
          });
        }
      }

      if (!workout) {
        const now = nowISO();
        workout = {
          id: generateId('workout'), date: day, type: 'strength', name: 'Strength Training',
          durationMin: 0, exercises: [], sources: ['coach-log'], createdAt: now,
          ...(day === todayStr() ? { startTime: nowHHmm() } : {}),
        };
        created = true;
      }

      // Use the library's canonical name so history lines up across sessions
      const library = await listLibrary();
      const lib = matchExercise(library, exercise.name) ?? (exercise.nameZh ? matchExercise(library, exercise.nameZh) : undefined);
      const name = lib?.name ?? exercise.name;
      const exercises = (workout.exercises ?? []).map(e => ({ ...e, sets: [...(e.sets ?? [])] }));
      let target = exercises.find(e => exerciseNames(name, lib).has(norm(e.name)));
      if (!target) {
        target = { name, sets: [] };
        exercises.push(target);
      }
      target.nameZh ??= exercise.nameZh ?? lib?.nameZh;
      target.equipment ??= exercise.equipment ?? lib?.equipment;
      target.muscleGroup ??= exercise.muscleGroup ?? lib?.muscleGroup;
      if (exercise.notes) target.notes = exercise.notes;

      const sets = target.sets ?? [];
      const setNo = set.setNo ?? sets.length + 1;
      const entry: WorkoutSet = { ...set, setNo, loggedAt: nowISO() };
      entry.weightKg = setTotalKg(entry);
      const at = sets.findIndex(s => s.setNo === setNo);
      const replaced = at >= 0;
      if (replaced) sets[at] = entry; else sets.push(entry);
      target.sets = sets.sort((a, b) => (a.setNo ?? 0) - (b.setNo ?? 0));

      const updated: Workout = { ...workout, exercises, sources: withSource(workout, 'coach-log'), updatedAt: nowISO() };
      // Until a watch summary arrives, keep a rough duration from the first to the latest set
      if (!workoutSources(updated).includes('apple-watch-screenshot') && day === todayStr() && updated.startTime) {
        updated.endTime = nowHHmm();
        const span = interval(updated.startTime, updated.endTime);
        if (span) updated.durationMin = span[1] - span[0];
      }
      await saveHealthDoc(WORKOUTS, updated.id, updated as Record<string, unknown>);

      return jsonResult({
        success: true, created, replaced, workoutId: updated.id,
        exercise: { name: target.name, nameZh: target.nameZh, sets: target.sets },
        totalSetsToday: exercises.reduce((n, e) => n + (e.sets ?? []).length, 0),
      });
    }
  );

  server.tool(
    'get_exercise_history',
    '某个动作最近几次的训练（每组重量次数、最佳重量、总训练量）和历史最佳（PR）。教练模式里给建议重量前先调用，用上次的重量当起点。中英文名或别名都可以。',
    {
      name: z.string().min(1),
      limit: z.number().int().min(1).max(30).optional().describe('最近几次，默认 5'),
    },
    async ({ name, limit }) => {
      const lib = matchExercise(await listLibrary(), name);
      const names = exerciseNames(name, lib);
      const sessions = [];
      for (const w of await listWorkouts()) {
        const ex = (w.exercises ?? []).find(e => names.has(norm(e.name)) || (e.nameZh && names.has(norm(e.nameZh))));
        if (!ex?.sets?.length) continue;
        const sets = ex.sets.map(s => ({ ...s, weightKg: setTotalKg(s) }));
        const { best, bestWeightKg, volumeKg } = sessionStats(sets);
        sessions.push({ date: w.date, workoutId: w.id, bestWeightKg, repsAtBest: best?.reps ?? 0, bestSet: best, volumeKg, sets });
      }
      const pr = sessions.reduce<typeof sessions[number] | undefined>((b, s) => (s.bestWeightKg > (b?.bestWeightKg ?? -1) ? s : b), undefined);
      return jsonResult({
        exercise: lib?.name ?? name,
        library: lib ?? null,
        totalSessions: sessions.length,
        personalRecord: pr ? { date: pr.date, weightKg: pr.bestWeightKg, reps: pr.repsAtBest } : null,
        lastSession: sessions[0] ?? null,
        recent: sessions.slice(0, limit ?? 5),
      });
    }
  );

  server.tool(
    'get_training_context',
    '决定今天练什么所需的资料：本周（周一起）每天练了什么、各部位上次训练日期、昨天练过的部位、最近几天的睡眠/静息心率/HRV、本周训练计划和今天的计划。教练模式开始时和 get_coach_mode 一起调用。',
    { date: dateSchema.optional().describe('默认今天') },
    async ({ date }) => {
      const day = date ?? todayStr();
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      const weekStart = addDays(day, -((dow + 6) % 7));
      const [recent, plan, metrics] = await Promise.all([
        listWorkouts(addDays(day, -60), day),
        getPlan(),
        listHealthDocs<DailyMetrics>(HEALTH_COLLECTIONS.dailyMetrics, addDays(day, -3), day),
      ]);

      const groupsOf = (w: Workout) => workoutMuscleGroups(w);
      const thisWeek = recent.filter(w => w.date >= weekStart).map(w => ({
        ...brief(w), muscleGroups: groupsOf(w), setsLogged: (w.exercises ?? []).reduce((n, e) => n + (e.sets ?? []).length, 0),
      }));
      const trainedThisWeek: Record<string, string[]> = {};
      for (const w of thisWeek) for (const g of w.muscleGroups) (trainedThisWeek[g] ??= []).includes(w.date) || trainedThisWeek[g].push(w.date);

      const lastTrainedByGroup: Record<string, { date: string; daysAgo: number }> = {};
      for (const w of recent) for (const g of groupsOf(w)) {
        if (!lastTrainedByGroup[g] || w.date > lastTrainedByGroup[g].date) lastTrainedByGroup[g] = { date: w.date, daysAgo: daysBetween(w.date, day) };
      }
      const yesterday = addDays(day, -1);
      const yesterdayGroups = [...new Set(recent.filter(w => w.date === yesterday).flatMap(groupsOf))];

      const plannedGroups = Object.values(plan?.days ?? {}).flatMap(d => d?.focus ?? []).filter(f => (MUSCLE_GROUPS as readonly string[]).includes(f));
      const mainGroups = plannedGroups.length ? [...new Set(plannedGroups)] : ['chest', 'back', 'shoulders', 'legs', 'arms'];
      const sortedMetrics = [...metrics].sort((a, b) => b.date.localeCompare(a.date));
      // Sleep is logged on the morning it ends, so today's entry is last night
      const lastNight = sortedMetrics.find(m => m.sleepHours !== undefined && (m.date === day || m.date === yesterday));

      return jsonResult({
        date: day,
        weekday: dayKey(day),
        weekStart,
        plan: plan ? { today: plan.days[dayKey(day)] ?? null, week: plan.days, goal: plan.goal, notes: plan.notes } : null,
        thisWeek,
        trainedThisWeek,
        notTrainedThisWeek: mainGroups.filter(g => !trainedThisWeek[g]),
        lastTrainedByGroup,
        yesterdayGroups,
        avoidToday: yesterdayGroups.filter(g => g !== 'cardio'),
        sleepLastNight: lastNight ? { date: lastNight.date, hours: lastNight.sleepHours } : null,
        lowSleep: lastNight?.sleepHours !== undefined ? lastNight.sleepHours < 6 : null,
        recentMetrics: sortedMetrics.map(m => ({
          date: m.date, sleepHours: m.sleepHours, restingHeartRate: m.restingHeartRate, hrvMs: m.hrvMs, steps: m.steps,
        })),
        todayWorkouts: recent.filter(w => w.date === day).map(brief),
      });
    }
  );

  server.tool(
    'get_training_plan',
    '读取每周训练计划（周一到周日各练什么、目标时长）。',
    {},
    async () => jsonResult((await getPlan()) ?? { days: {}, note: '还没有设定每周计划，可用 set_training_plan' })
  );

  server.tool(
    'set_training_plan',
    '设定或调整每周训练计划。days 只传要改的那几天（mon/tue/wed/thu/fri/sat/sun），其他天保留；replace=true 时整份替换。练完后调整本周剩下的安排也用这个。',
    {
      days: z.object(Object.fromEntries(DAY_KEYS.map(k => [k, planDaySchema.optional()])) as Record<DayKey, z.ZodOptional<typeof planDaySchema>>).optional(),
      goal: z.string().optional().describe('训练目标，如「减脂增肌，一周 5 练」'),
      notes: z.string().optional(),
      replace: z.boolean().optional(),
    },
    async ({ days, goal, notes, replace }) => {
      const existing = replace ? null : await getPlan();
      const plan: TrainingPlan = {
        id: PLAN_ID,
        days: { ...(existing?.days ?? {}), ...Object.fromEntries(Object.entries(days ?? {}).filter(([, v]) => v)) },
        goal: goal ?? existing?.goal,
        notes: notes ?? existing?.notes,
        updatedAt: nowISO(),
      };
      await saveHealthDoc(PLAN, PLAN_ID, plan as Record<string, unknown>);
      return jsonResult({ success: true, plan });
    }
  );

  server.tool(
    'merge_workout_summary',
    '把 Apple Watch / Apple Health 运动截图的摘要合并进当天的 workout，避免同一次训练出现两笔。配对规则：同一天 + 类型相容（传统/功能性力量训练→strength，爬楼梯→stair_stepper）+ 时间重叠或相差 2 小时内。找到 1 笔就补上时长、卡路里、心率并加上来源（不动已记录的组数）；找不到就新建；找到多笔就不写入，返回 ambiguous 和候选清单，请问用户是哪一笔后带 workoutId 重试。截图里的步数、睡眠等每日数据用 log_daily_metrics，不放这里。',
    {
      date: dateSchema,
      type: z.enum(WORKOUT_TYPES).describe('Traditional / Functional Strength Training→strength 或 functional，Stair Stepper→stair_stepper'),
      workoutId: z.string().optional().describe('已知要合并到哪一笔时传（例如 ambiguous 之后用户选好了）'),
      name: z.string().optional().describe('只在新建时用作名称'),
      startTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:mm'),
      endTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:mm'),
      durationMin: z.number().min(0),
      activeKcal: z.number().min(0),
      totalKcal: z.number().min(0).optional(),
      avgHeartRate: z.number().min(0).optional(),
      minHeartRate: z.number().min(0).optional(),
      maxHeartRate: z.number().min(0).optional(),
      distanceKm: z.number().min(0).optional(),
      elevationM: z.number().min(0).optional(),
      effort: z.number().min(1).max(10).optional(),
      source: z.enum(WORKOUT_SOURCES).optional().describe('默认 apple-watch-screenshot'),
    },
    async ({ date, type, workoutId, name, source, ...summary }) => {
      const src: WorkoutSource = source ?? 'apple-watch-screenshot';
      const span = interval(summary.startTime, summary.endTime, summary.durationMin);
      let target: Workout | null = null;

      if (workoutId) {
        target = await getHealthDoc<Workout>(WORKOUTS, workoutId);
        if (!target) return jsonResult({ success: false, error: `Workout ${workoutId} not found` });
      } else {
        const candidates = (await listWorkouts(date, date)).filter(w =>
          typesCompatible(w.type, type) && timesClose(interval(w.startTime, w.endTime, w.durationMin), span));
        if (candidates.length > 1) {
          return jsonResult({ status: 'ambiguous', message: '这天有多笔可能是同一次训练，请问用户是哪一笔，再带 workoutId 重试', candidates: candidates.map(brief) });
        }
        target = candidates[0] ?? null;
      }

      if (!target) {
        const workout: Workout = {
          id: generateId('workout'), date, type, name, ...summary, sources: [src], createdAt: nowISO(),
        };
        await saveHealthDoc(WORKOUTS, workout.id, workout as Record<string, unknown>);
        return jsonResult({ status: 'created', workoutId: workout.id, workout: brief(workout) });
      }

      // Watch numbers are measured, so they replace coach-log estimates; sets are never touched
      const updated: Workout = {
        ...target,
        ...Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined)),
        sources: withSource(target, src),
        updatedAt: nowISO(),
      };
      await saveHealthDoc(WORKOUTS, updated.id, updated as Record<string, unknown>);
      return jsonResult({ status: 'matched', workoutId: updated.id, workout: brief(updated) });
    }
  );

  server.tool(
    'merge_workouts',
    '手动合并两笔重复的 workout：动作和组数合并，时长/卡路里/心率取有值的那一笔，两边都有但不同时列为冲突（默认保留 primary，useSecondaryFor 可指定改用 secondary 的字段）。dryRun 默认 true，只预览不写入；用户确认后用 dryRun=false 执行，secondary 会先备份再删除。',
    {
      primaryId: z.string().describe('保留的那一笔'),
      secondaryId: z.string().describe('合并进来后删除的那一笔'),
      dryRun: z.boolean().optional().describe('默认 true'),
      useSecondaryFor: z.array(z.string()).optional().describe('冲突时改用 secondary 的字段，如 ["durationMin","activeKcal"]'),
    },
    async ({ primaryId, secondaryId, dryRun, useSecondaryFor }) => {
      if (primaryId === secondaryId) return jsonResult({ success: false, error: 'primaryId 和 secondaryId 不能相同' });
      const [primary, secondary] = await Promise.all([
        getHealthDoc<Workout>(WORKOUTS, primaryId),
        getHealthDoc<Workout>(WORKOUTS, secondaryId),
      ]);
      if (!primary || !secondary) return jsonResult({ success: false, error: `找不到 ${!primary ? primaryId : secondaryId}` });
      const { merged, conflicts } = mergeWorkoutPair(primary, secondary, useSecondaryFor);
      const warnings = primary.date !== secondary.date ? [`两笔日期不同（${primary.date} / ${secondary.date}），合并后用 ${primary.date}`] : [];

      if (dryRun !== false) {
        return jsonResult({ dryRun: true, preview: merged, conflicts, warnings, next: '确认后用 dryRun=false 执行' });
      }
      const archiveId = generateId('merge');
      await saveHealthDoc(HEALTH_COLLECTIONS.workoutMergeArchive, archiveId, {
        id: archiveId, date: primary.date, primaryBefore: primary, secondary, mergedAt: nowISO(),
      });
      await saveHealthDoc(WORKOUTS, primary.id, merged as Record<string, unknown>);
      await deleteHealthDoc(WORKOUTS, secondary.id);
      return jsonResult({ success: true, workoutId: primary.id, workout: merged, conflicts, warnings, archiveId });
    }
  );
}
