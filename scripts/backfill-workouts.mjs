// Backfill for the gym-coach release. Safe to re-run.
//   1. Saves every raw (still encrypted) workouts document to a JSON backup first.
//   2. Adds sources[] to workouts that don't have it, inferred from the old `source` field
//      (apple_watch → apple-watch-screenshot, anything else → manual). No other field changes.
//   3. Reports likely duplicates (same day: one has exercises but no calories, the other
//      calories but no exercises). It never merges — use the merge_workouts tool for that.
// Runs inside the mywallet-mcp container against its TARGET_USER_ID:
//   docker cp scripts/backfill-workouts.mjs <container>:/app/ && docker exec <container> node /app/backfill-workouts.mjs [--apply]
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '/app/dist/firebase.js';
import { collectionPath } from '/app/dist/firestore.js';
import { listHealthDocs, saveHealthDoc } from '/app/dist/tools/healthCommon.js';
import { workoutSources } from '/app/dist/tools/workouts.js';
import { findDuplicatePairs } from '/app/dist/tools/training.js';

const apply = process.argv.includes('--apply');

// Key-order independent JSON, for comparing documents before and after
const canonical = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const path = collectionPath('workouts');

// 1. Raw backup — written before anything else, and the run stops if it fails
const raw = (await db.collection(path).get()).docs.map(d => ({ id: d.id, data: d.data() }));
const backupDir = '/app/backups';
mkdirSync(backupDir, { recursive: true });
const backupFile = `${backupDir}/workouts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(backupFile, JSON.stringify({ path, count: raw.length, docs: raw }, null, 2));

// 2. sources[]
const workouts = await listHealthDocs('workouts');
const unreadable = workouts.filter(w => w._decryptionFailed).map(w => w.id);
const readable = workouts.filter(w => !w._decryptionFailed);
const missing = readable.filter(w => !(w.sources?.length));
const changes = missing.map(w => ({ id: w.id, date: w.date, name: w.name, source: w.source ?? null, sources: workoutSources(w) }));

if (apply) {
  for (const w of missing) {
    const { _decryptionFailed, ...doc } = w;
    await saveHealthDoc('workouts', w.id, { ...doc, sources: workoutSources(w) });
  }
  // Verify: same documents, and nothing but sources changed
  const after = new Map((await listHealthDocs('workouts')).map(w => [w.id, w]));
  const problems = [];
  for (const w of readable) {
    const now = after.get(w.id);
    if (!now) { problems.push(`${w.id} missing after backfill`); continue; }
    const { sources: _a, ...before } = w;
    const { sources: _b, ...afterDoc } = now;
    if (canonical(before) !== canonical(afterDoc)) problems.push(`${w.id} changed beyond sources`);
  }
  if (after.size !== workouts.length) problems.push(`count ${workouts.length} → ${after.size}`);
  if (problems.length) { console.error(JSON.stringify({ problems, backupFile }, null, 2)); process.exit(1); }
}

// 3. Duplicate report
const duplicates = findDuplicatePairs(readable).map(p => ({
  date: p.date,
  withExercises: { id: p.withExercises.id, name: p.withExercises.name, exercises: p.withExercises.exercises?.length ?? 0 },
  withCalories: { id: p.withCalories.id, name: p.withCalories.name, activeKcal: p.withCalories.activeKcal },
  suggestion: `merge_workouts(primaryId="${p.withExercises.id}", secondaryId="${p.withCalories.id}")`,
}));

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry-run (pass --apply to write)',
  backupFile,
  totalWorkouts: workouts.length,
  unreadable,
  sourcesAdded: changes.length,
  bySource: changes.reduce((m, c) => ({ ...m, [c.sources.join('+')]: (m[c.sources.join('+')] ?? 0) + 1 }), {}),
  changes,
  duplicates,
}, null, 2));
process.exit(0);
