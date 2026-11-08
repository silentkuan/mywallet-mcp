// End-to-end check of the gym-coach tools against a running server (use a tester account!).
//   MCP_URL=http://127.0.0.1:3010/mcp MCP_API_KEY=... node scripts/test-gym-coach.mjs
// It writes test data: coach mode versions, a library entry, a plan, and workouts today/yesterday.
// Expects no workouts today/yesterday — reset the tester with seed-tester.mjs before re-running.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:3010/mcp';
const client = new Client({ name: 'gym-coach-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_API_KEY}` } },
}));

let failed = 0;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { raw: text, isError: r.isError }; }
};
const check = (label, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!ok) failed++;
};
const sgDate = offset => new Date(Date.now() + 8 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const sgTime = minutesAgo => new Date(Date.now() + 8 * 3600e3 - minutesAgo * 60e3).toISOString().slice(11, 16);
const today = sgDate(0), yesterday = sgDate(-1);

// ── tool list ──
const { tools } = await client.listTools();
const names = new Set(tools.map(t => t.name));
const expected = ['log_set', 'get_exercise_history', 'get_training_context', 'get_exercise', 'search_exercises', 'upsert_exercise',
  'get_training_plan', 'set_training_plan', 'list_coach_modes', 'get_coach_mode', 'upsert_coach_mode', 'get_coach_mode_history',
  'rollback_coach_mode', 'merge_workout_summary', 'merge_workouts',
  'log_workout', 'update_workout', 'get_workouts', 'delete_workout', 'log_daily_metrics', 'get_health_overview'];
check('all tools registered', expected.every(n => names.has(n)), expected.filter(n => !names.has(n)));

// ── coach modes ──
const modes = await call('list_coach_modes');
const seeded = modes.find?.(m => m.id === 'gym-coach');
check('gym-coach seeded', !!seeded && seeded.version >= 1, modes);
const mode = await call('get_coach_mode', { name: 'gym-coach' });
check('get_coach_mode returns instructions', mode.instructions?.includes('健身房实时教练模式'), mode);
const v0 = mode.version;
const edited = await call('upsert_coach_mode', { name: 'gym-coach', instructions: mode.instructions + '\n6. 测试：组间休息 90 秒。', changeNote: '测试修改' });
check('upsert bumps version', edited.mode?.version === v0 + 1, edited);
const history = await call('get_coach_mode_history', { name: 'gym-coach' });
check('history keeps every version', Array.isArray(history) && history.length >= 2 && history[0].version === v0 + 1, history);
const rolled = await call('rollback_coach_mode', { name: 'gym-coach', version: v0 });
check('rollback restores content as a new version', rolled.mode?.version === v0 + 2 && rolled.mode.instructions === mode.instructions, rolled);
const bad = await call('upsert_coach_mode', { name: 'no-such-mode' });
check('new mode without instructions is refused', bad.success === false, bad);

// ── exercise library ──
const ex = await call('upsert_exercise', {
  name: 'Goblet Squat', nameZh: '高脚杯深蹲', aliases: ['杯式深蹲', 'DB Goblet Squat'], muscleGroup: 'legs', equipment: 'dumbbell',
  cues: ['哑铃贴胸', '膝盖跟脚尖同方向', '蹲到大腿平行'], imageQuery: 'goblet squat proper form',
});
check('upsert_exercise', ex.success && ex.exercise.id === 'goblet-squat', ex);
const found = await call('get_exercise', { name: '高脚杯深蹲' });
check('get_exercise by Chinese name', found.name === 'Goblet Squat', found);
const search = await call('search_exercises', { query: '杯式' });
check('search_exercises by alias', search.count >= 1, search);

// ── plan & context ──
const plan = await call('set_training_plan', { goal: '减脂增肌', days: { mon: { focus: ['chest', 'arms'], targetMin: 45 }, wed: { focus: ['back'], targetMin: 45 }, fri: { focus: ['legs'], targetMin: 45 } } });
check('set_training_plan', plan.success && plan.plan.days.fri.focus[0] === 'legs', plan);
const plan2 = await call('set_training_plan', { days: { sat: { focus: ['cardio'], targetMin: 30 } } });
check('set_training_plan merges days', plan2.plan.days.mon && plan2.plan.days.sat, plan2);
const ctx = await call('get_training_context', {});
check('get_training_context', ctx.weekStart && ctx.lastTrainedByGroup && Array.isArray(ctx.notTrainedThisWeek) && ctx.plan, ctx);
check('training context has last night sleep', ctx.sleepLastNight?.hours !== undefined, ctx.sleepLastNight);

// ── log_set ──
const s1 = await call('log_set', { date: today, exercise: { name: '杯式深蹲' }, set: { type: 'warmup', weight: 12, reps: 10 } });
check('log_set creates today\'s workout and resolves alias', s1.success && s1.exercise.name === 'Goblet Squat' && s1.exercise.sets.length === 1, s1);
const wid = s1.workoutId;
const created = s1.created;
const s2 = await call('log_set', { date: today, exercise: { name: 'Goblet Squat' }, set: { type: 'working', weight: 16, reps: 10, rpe: 7 } });
check('log_set appends to same workout', s2.workoutId === wid && s2.exercise.sets.length === 2 && s2.exercise.sets[1].setNo === 2, s2);
const s2fix = await call('log_set', { workoutId: wid, exercise: { name: 'Goblet Squat' }, set: { setNo: 2, type: 'working', weight: 18, reps: 8 } });
check('log_set with existing setNo replaces the set', s2fix.replaced && s2fix.exercise.sets.length === 2 && s2fix.exercise.sets[1].weightKg === 18, s2fix);
const bench = await call('log_set', { workoutId: wid, exercise: { name: 'Bench Press', equipment: 'barbell', muscleGroup: 'chest' }, set: { type: 'working', weight: 20, perSide: true, barKg: 20, reps: 8 } });
check('barbell per-side + bar = 60 kg', bench.exercise.sets.at(-1).weightKg === 60, bench);
const lb = await call('log_set', { workoutId: wid, exercise: { name: 'Lateral Raise', equipment: 'dumbbell', muscleGroup: 'shoulders' }, set: { weight: 25, unit: 'lb', reps: 12 } });
check('25 lb converts to 11.34 kg', Math.abs(lb.exercise.sets[0].weightKg - 11.34) < 0.01, lb);
const plate = await call('log_set', { workoutId: wid, exercise: { name: 'Plate-Loaded Leg Press', equipment: 'machine-plate', muscleGroup: 'legs' }, set: { weight: 40, perSide: true, reps: 12 } });
check('plate machine counts plates only (2 × 40)', plate.exercise.sets[0].weightKg === 80, plate);

// ── history ──
const hist = await call('get_exercise_history', { name: '高脚杯深蹲' });
check('get_exercise_history resolves Chinese name', hist.exercise === 'Goblet Squat' && hist.lastSession?.bestWeightKg === 18, hist);
const legacy = await call('get_exercise_history', { name: 'Bench Press', limit: 3 });
check('history reads old-format sets too', legacy.totalSessions > 3 && legacy.personalRecord?.weightKg > 0 && legacy.recent.length === 3, { total: legacy.totalSessions, pr: legacy.personalRecord });

// ── merge_workout_summary ──
const watch = await call('merge_workout_summary', { date: today, type: 'functional', startTime: sgTime(50), durationMin: 48, activeKcal: 260, avgHeartRate: 121, maxHeartRate: 152 });
check('watch summary matches the coach-log workout', watch.status === 'matched' && watch.workoutId === wid, watch);
const after = (await call('get_workouts', { startDate: today, endDate: today })).workouts.find(w => w.id === wid);
check('match keeps sets and adds source', after.exercises.length === 4 && after.activeKcal === 260 && after.sources.includes('coach-log') && after.sources.includes('apple-watch-screenshot'), after);
const stair = await call('merge_workout_summary', { date: today, type: 'stair_stepper', startTime: sgTime(5), durationMin: 20, activeKcal: 180 });
check('no match → created', stair.status === 'created', stair);
await call('log_workout', { date: today, type: 'strength', name: 'Second strength (test)', startTime: sgTime(40), durationMin: 30, activeKcal: 150, source: 'manual' });
const amb = await call('merge_workout_summary', { date: today, type: 'strength', startTime: sgTime(45), durationMin: 40, activeKcal: 200 });
check('two candidates → ambiguous, nothing written', amb.status === 'ambiguous' && amb.candidates.length === 2, amb);
const chosen = await call('merge_workout_summary', { date: today, type: 'strength', workoutId: wid, durationMin: 49, activeKcal: 262 });
check('ambiguous resolved with workoutId', chosen.status === 'matched' && chosen.workoutId === wid, chosen);

// ── duplicates + merge_workouts ──
const y1 = await call('log_set', { date: yesterday, exercise: { name: 'Lat Pulldown', equipment: 'machine-stack', muscleGroup: 'back' }, set: { weight: 45, reps: 12 } });
const y2 = await call('log_workout', { date: yesterday, type: 'strength', name: 'Traditional Strength Training', durationMin: 42, activeKcal: 240, maxHeartRate: 148, source: 'apple_watch' });
const preview = await call('merge_workouts', { primaryId: y1.workoutId, secondaryId: y2.workout.id });
check('merge_workouts dry run previews', preview.dryRun && preview.preview.activeKcal === 240 && preview.preview.exercises.length === 1, preview);
const stillThere = (await call('get_workouts', { startDate: yesterday, endDate: yesterday })).workouts.some(w => w.id === y2.workout.id);
check('dry run writes nothing', stillThere);
const merged = await call('merge_workouts', { primaryId: y1.workoutId, secondaryId: y2.workout.id, dryRun: false });
const yAfter = (await call('get_workouts', { startDate: yesterday, endDate: yesterday })).workouts;
check('merge_workouts applies and removes secondary', merged.success && !yAfter.some(w => w.id === y2.workout.id) && yAfter.find(w => w.id === y1.workoutId)?.activeKcal === 240, merged);
check('merge archives the secondary', !!merged.archiveId, merged);
check('placeholder 0 min duration takes the watch value', merged.workout?.durationMin === 42 && !merged.conflicts.some(c => c.field === 'durationMin'), merged.conflicts);

// ── existing tools unchanged ──
const old = await call('log_workout', { date: yesterday, type: 'walking', name: 'Regression walk', durationMin: 10, activeKcal: 40, source: 'manual' });
check('log_workout still works (no sources added)', old.success && old.workout.sources === undefined, old);
const upd = await call('update_workout', { id: old.workout.id, notes: 'updated' });
check('update_workout still works', upd.success && upd.workout.notes === 'updated', upd);
await call('delete_workout', { id: old.workout.id });
const progress = await call('get_workouts', { includeProgress: true });
check('get_workouts includeProgress still works', progress.exerciseProgress && Object.keys(progress.exerciseProgress).length > 0, Object.keys(progress));
const dm = await call('log_daily_metrics', { date: today, steps: 8000, sleepHours: 5.5 });
check('log_daily_metrics still works', dm.success !== false, dm);
const lowCtx = await call('get_training_context', {});
check('5.5 h sleep flags lowSleep', lowCtx.lowSleep === true, lowCtx.sleepLastNight);

await client.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
