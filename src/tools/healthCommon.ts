import { z } from 'zod';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { collectionPath, fetchCollection, preparePayload, parsePayload } from '../firestore.js';

// Health collections. All health data is encrypted with MW_PRIVACY_KEY;
// only id and date stay visible so documents can be sorted without decrypting.
export const HEALTH_COLLECTIONS = {
  bodyScans: 'bodyScans',
  labReports: 'labReports',
  workouts: 'workouts',
  dailyMetrics: 'dailyMetrics',
  meals: 'mealRecords',
  water: 'waterIntake',
  foods: 'foodLibrary',
  supplements: 'supplementLogs',
} as const;

export const HEALTH_PROFILE_DOC = () => `users/${config.TARGET_USER_ID}/healthProfile/main`;

const VISIBLE_KEYS = ['id', 'date'];

// The user lives in UTC+8 (Singapore / Malaysia); the container runs in UTC.
// HEALTH_TIMEZONE can override this.
const TIME_ZONE = process.env.HEALTH_TIMEZONE || 'Asia/Singapore';

export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format: YYYY-MM-DD');

export async function saveHealthDoc(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  const payload = preparePayload(stripUndefined({ ...data, id }), VISIBLE_KEYS);
  await db.collection(collectionPath(collection)).doc(id).set(payload);
}

export async function listHealthDocs<T>(collection: string, startDate?: string, endDate?: string): Promise<T[]> {
  const docs = await fetchCollection(collectionPath(collection));
  return docs.filter(d => {
    const date = String(d['date'] ?? '');
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  }) as unknown as T[];
}

export async function getHealthDoc<T>(collection: string, id: string): Promise<T | null> {
  const snap = await db.collection(collectionPath(collection)).doc(id).get();
  if (!snap.exists) return null;
  return parsePayload({ id: snap.id, ...snap.data() }) as unknown as T;
}

export async function deleteHealthDoc(collection: string, id: string): Promise<boolean> {
  const ref = db.collection(collectionPath(collection)).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

// Named single documents (health profile) are encrypted the same way.
export async function getHealthNamedDoc<T>(docPath: string): Promise<T | null> {
  const snap = await db.doc(docPath).get();
  if (!snap.exists) return null;
  return parsePayload(snap.data() as Record<string, unknown>) as unknown as T;
}

export async function saveHealthNamedDoc(docPath: string, data: Record<string, unknown>): Promise<void> {
  await db.doc(docPath).set(preparePayload(stripUndefined(data), []));
}

// Firestore rejects undefined values; drop them recursively.
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => stripUndefined(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

// Removes fields whose value is null, so callers can clear an optional field by passing null.
export function mergePatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// --- Nutrients ---------------------------------------------------------------

// Every nutrient a meal can carry. calories/protein/fat/carbs/sodium are required on log_meal
// (they were before this change); the rest are optional but should be estimated when possible.
export const NUTRIENTS = {
  calories: { label: 'Calories', unit: 'kcal' },
  proteinG: { label: 'Protein', unit: 'g' },
  carbsG: { label: 'Carbs', unit: 'g' },
  fatG: { label: 'Fat', unit: 'g' },
  saturatedFatG: { label: 'Saturated fat', unit: 'g' },
  transFatG: { label: 'Trans fat', unit: 'g' },
  fiberG: { label: 'Fiber', unit: 'g' },
  sugarG: { label: 'Sugar', unit: 'g' },
  cholesterolMg: { label: 'Cholesterol', unit: 'mg' },
  sodiumMg: { label: 'Sodium', unit: 'mg' },
  potassiumMg: { label: 'Potassium', unit: 'mg' },
  calciumMg: { label: 'Calcium', unit: 'mg' },
  ironMg: { label: 'Iron', unit: 'mg' },
} as const;

export type NutrientKey = keyof typeof NUTRIENTS;
export const NUTRIENT_KEYS = Object.keys(NUTRIENTS) as NutrientKey[];
export type NutrientTotals = Record<NutrientKey, number>;

export function emptyTotals(): NutrientTotals {
  return Object.fromEntries(NUTRIENT_KEYS.map(k => [k, 0])) as NutrientTotals;
}

export const optionalNutrientShape = {
  saturatedFatG: z.number().min(0).optional().describe('饱和脂肪（克）— 降胆固醇关键指标'),
  transFatG: z.number().min(0).optional().describe('反式脂肪（克）'),
  fiberG: z.number().min(0).optional().describe('膳食纤维（克）— 降胆固醇关键指标'),
  sugarG: z.number().min(0).optional().describe('糖（克）'),
  cholesterolMg: z.number().min(0).optional().describe('胆固醇（毫克）'),
  potassiumMg: z.number().min(0).optional().describe('钾（毫克）'),
  calciumMg: z.number().min(0).optional().describe('钙（毫克）'),
  ironMg: z.number().min(0).optional().describe('铁（毫克）'),
};

// A target is a range; either bound may be absent. "max" nutrients are limits (sodium, sat fat),
// "min" nutrients are minimums (protein, fiber).
export const targetRangeSchema = z.object({
  min: z.number().min(0).optional(),
  max: z.number().min(0).optional(),
});
export type TargetRange = z.infer<typeof targetRangeSchema>;
export type NutritionTargets = Partial<Record<NutrientKey | 'waterMl', TargetRange>>;

// Defaults tuned for the stated goals (fat loss, muscle gain, lower cholesterol).
// The latest body scan's recommendation overrides calories and macros when the profile has none.
export const DEFAULT_NUTRITION_TARGETS: NutritionTargets = {
  calories: { min: 1750, max: 1850 },
  proteinG: { min: 130, max: 140 },
  carbsG: { min: 150, max: 165 },
  fatG: { min: 60, max: 72 },
  saturatedFatG: { max: 20 },
  transFatG: { max: 2 },
  fiberG: { min: 30 },
  sugarG: { max: 45 },
  cholesterolMg: { max: 300 },
  sodiumMg: { max: 2000 },
  potassiumMg: { min: 3500 },
  calciumMg: { min: 1000 },
  ironMg: { min: 8 },
  waterMl: { min: 2500 },
};

export type TargetStatus = 'low' | 'ok' | 'high' | 'no_target' | 'no_data';

export function evaluate(value: number, range?: TargetRange): TargetStatus {
  if (!range || (range.min === undefined && range.max === undefined)) return 'no_target';
  if (range.min !== undefined && value < range.min) return 'low';
  if (range.max !== undefined && value > range.max) return 'high';
  return 'ok';
}
