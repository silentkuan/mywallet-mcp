// Creates (or resets) a mywallet tester account filled with dummy data.
// Runs inside the mywallet-mcp container, which has firebase-admin, crypto-js and the service account.
// Usage (from the host): docker cp scripts/seed-tester.mjs mywallet-mcp:/app/ && docker exec mywallet-mcp node /app/seed-tester.mjs <email> <password> <privacyKey>
import { db } from '/app/dist/firebase.js';
import { getAuth } from 'firebase-admin/auth';
import CryptoJS from 'crypto-js';

const [email, password, KEY] = process.argv.slice(2);
if (!email || !password || !KEY) { console.error('usage: seed-tester.mjs <email> <password> <privacyKey>'); process.exit(1); }

// ---- account ----
const auth = getAuth();
let user;
try {
  user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { password, displayName: 'Tester' });
} catch (e) {
  if (e.code !== 'auth/user-not-found') throw e;
  user = await auth.createUser({ email, password, displayName: 'Tester', emailVerified: true });
}
const uid = user.uid;
const base = `users/${uid}`;

// ---- helpers ----
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (a, b, d = 0) => Math.round((a + rnd() * (b - a)) * 10 ** d) / 10 ** d;
const fmt = d => d.toISOString().slice(0, 10);
const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date()) + 'T00:00:00Z');
const daysAgo = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return fmt(d); };
const enc = obj => CryptoJS.AES.encrypt(JSON.stringify(obj), KEY).toString();
// Mirrors preparePayload: visible keys stay plain, the rest goes into encryptedData
const payload = (data, visible) => {
  const v = {}, s = {};
  for (const [k, val] of Object.entries(data)) { if (val === undefined) continue; (visible.includes(k) ? v : s)[k] = val; }
  return { ...v, encryptedData: enc(s) };
};

const COLLECTIONS = ['transactions', 'stocks', 'bankAccounts', 'bankRecords', 'bodyScans', 'labReports', 'workouts',
  'dailyMetrics', 'mealRecords', 'waterIntake', 'foodLibrary', 'supplementLogs', 'settings', 'profile', 'healthProfile'];
for (const c of COLLECTIONS) {
  const snap = await db.collection(`${base}/${c}`).get();
  for (const d of snap.docs) await d.ref.delete();
}

const batchWrite = async (collection, docs, visible) => {
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    for (const d of docs.slice(i, i + 400)) b.set(db.collection(`${base}/${collection}`).doc(d.id), payload(d, visible));
    await b.commit();
  }
  return docs.length;
};
const counts = {};

// ---- profile & settings ----
await db.doc(`${base}/profile/main`).set({ gender: 'male', age: 28, height: 172, weight: 76, activityLevel: 1.55 });
await db.doc(`${base}/settings/main`).set(payload({
  id: 'main',
  customExpenseCategories: ['Gym'],
  customIncomeCategories: ['Freelance'],
  transactionShortcuts: [
    { id: 'sc1', name: 'Kopi', type: 'EXPENSE', amount: 2.5, currency: 'MYR', category: 'Food', remark: 'Kopi O', icon: '☕' },
    { id: 'sc2', name: 'Grab', type: 'EXPENSE', currency: 'MYR', category: 'Transport', remark: 'Grab ride', icon: '🚗' },
  ],
}, ['id']));

// ---- finance: ~4 months ----
const tx = [];
let n = 0;
const addTx = (date, type, category, amount, remark, currency = 'MYR', extra = {}) =>
  tx.push({ id: `demo-tx-${++n}`, date, type, category, amount, currency, remark, recurrence: null, ...extra });
const foods = ['Nasi lemak', 'Chicken rice', 'Economy rice', 'Wantan mee', 'Roti canai + teh tarik', 'Mixed rice', 'Laksa', 'Sushi set', 'Salad bowl', 'Pan mee'];
for (let i = 120; i >= 0; i--) {
  const date = daysAgo(i);
  const dom = Number(date.slice(8));
  for (let m = 0; m < 2 + Math.floor(rnd() * 2); m++) addTx(date, 'EXPENSE', 'Food', between(6, 28, 2), pick(foods));
  if (rnd() < 0.5) addTx(date, 'EXPENSE', 'Transport', between(5, 25, 2), pick(['Grab ride', 'LRT', 'Petrol', 'Parking']));
  if (rnd() < 0.12) addTx(date, 'EXPENSE', 'Shopping', between(30, 280, 2), pick(['Shopee order', 'Uniqlo', 'Groceries', 'Watsons']));
  if (rnd() < 0.08) addTx(date, 'EXPENSE', 'Entertainment', between(20, 90, 2), pick(['Movie', 'Netflix', 'Karaoke', 'Concert ticket']));
  if (dom === 1) { addTx(date, 'EXPENSE', 'Housing', 1500, 'Rent'); addTx(date, 'EXPENSE', 'Gym', 150, 'Gym membership'); }
  if (dom === 5) { addTx(date, 'EXPENSE', 'Utilities', between(120, 190, 2), 'Electricity + water'); addTx(date, 'EXPENSE', 'Utilities', 99, 'Fibre internet'); }
  if (dom === 25) addTx(date, 'INCOME', 'Salary', 6800, 'Monthly salary');
  if (dom === 15 && rnd() < 0.6) addTx(date, 'INCOME', 'Freelance', between(500, 1500, 0), 'Freelance project', 'SGD');
  if (rnd() < 0.03) addTx(date, 'EXPENSE', 'Health', between(30, 120, 2), pick(['Clinic visit', 'Pharmacy', 'Physio']));
}
counts.transactions = await batchWrite('transactions', tx, ['id']);

// ---- stocks ----
const stocks = [
  { symbol: 'AAPL', market: 'US', action: 'BUY', date: daysAgo(110), quantity: 10, pricePerShare: 212.5, currency: 'USD', fees: 1 },
  { symbol: 'MSFT', market: 'US', action: 'BUY', date: daysAgo(100), quantity: 5, pricePerShare: 430.2, currency: 'USD', fees: 1 },
  { symbol: 'JEPQ', market: 'US', action: 'BUY', date: daysAgo(90), quantity: 40, pricePerShare: 55.1, currency: 'USD', fees: 1 },
  { symbol: '1155.KL', market: 'MY', action: 'BUY', date: daysAgo(80), quantity: 1000, pricePerShare: 10.2, currency: 'MYR', fees: 12 },
  { symbol: '5347.KL', market: 'MY', action: 'BUY', date: daysAgo(60), quantity: 500, pricePerShare: 13.8, currency: 'MYR', fees: 9 },
  { symbol: 'AAPL', market: 'US', action: 'SELL', date: daysAgo(30), quantity: 3, pricePerShare: 228.4, costBasis: 212.5, currency: 'USD', fees: 1 },
  { symbol: 'JEPQ', market: 'US', action: 'DIVIDEND', date: daysAgo(50), quantity: 0, pricePerShare: 0, currency: 'USD', totalAmount: 21.6, tax: 6.48 },
  { symbol: 'JEPQ', market: 'US', action: 'DIVIDEND', date: daysAgo(20), quantity: 0, pricePerShare: 0, currency: 'USD', totalAmount: 22.4, tax: 6.72 },
  { symbol: '1155.KL', market: 'MY', action: 'DIVIDEND', date: daysAgo(40), quantity: 0, pricePerShare: 0, currency: 'MYR', totalAmount: 280 },
].map((s, i) => ({ id: `demo-stock-${i + 1}`, costBasis: 0, fees: 0, tax: 0, ...s, totalAmount: s.totalAmount ?? Math.round(s.quantity * s.pricePerShare * 100) / 100 }));
counts.stocks = await batchWrite('stocks', stocks, ['id']);

// ---- banks ----
const banks = [
  { id: 'demo-bank-1', name: 'Maybank Savings', type: 'Savings', currency: 'MYR', order: 0 },
  { id: 'demo-bank-2', name: 'DBS Multiplier', type: 'Savings', currency: 'SGD', order: 1 },
  { id: 'demo-bank-3', name: "Touch 'n Go", type: 'E-Wallet', currency: 'MYR', order: 2 },
];
counts.bankAccounts = await batchWrite('bankAccounts', banks, ['id']);
const records = [];
for (let m = 4; m >= 0; m--) {
  const d = new Date(today); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m);
  const month = fmt(d).slice(0, 7);
  records.push({ id: `demo-bank-1-${month}`, bankId: 'demo-bank-1', month, balance: 18000 + (4 - m) * 1450 + between(-300, 300, 2) });
  records.push({ id: `demo-bank-2-${month}`, bankId: 'demo-bank-2', month, balance: 6200 + (4 - m) * 600 });
  records.push({ id: `demo-bank-3-${month}`, bankId: 'demo-bank-3', month, balance: between(80, 400, 2) });
}
counts.bankRecords = await batchWrite('bankRecords', records, ['id']);

// ---- health ----
const H = ['id', 'date'];
await db.doc(`${base}/healthProfile/main`).set(payload({
  sex: 'male', age: 28, heightCm: 172, activityLevel: 'active',
  goals: ['fat_loss', 'muscle_gain', 'lower_cholesterol'],
  goalNotes: 'Demo 账号：减脂同时增肌，降低 LDL。',
  targetBodyFatPct: 18, targetWaistCm: 85, targetSkeletalMuscleKg: 34, targetLdl: 3.0,
  nutritionTargets: { calories: { min: 1900, max: 2050 }, proteinG: { min: 140, max: 155 }, carbsG: { min: 180, max: 210 }, fatG: { min: 55, max: 68 } },
  updatedAt: new Date().toISOString(),
}, []));

// 4 scans, every ~4 weeks, steadily improving
const scanBase = [
  { w: 79.6, bf: 25.8, smm: 32.6, waist: 92.5, vfa: 98, vfl: 10 },
  { w: 78.4, bf: 24.6, smm: 32.9, waist: 91.0, vfa: 93, vfl: 10 },
  { w: 77.5, bf: 23.5, smm: 33.1, waist: 89.6, vfa: 88, vfl: 9 },
  { w: 76.3, bf: 22.1, smm: 33.4, waist: 88.2, vfa: 82, vfl: 9 },
];
const scans = scanBase.map((s, i) => {
  const fat = Math.round(s.w * s.bf) / 100;
  const lean = Math.round((s.w - fat) * 10) / 10;
  return {
    id: `demo-scan-${i + 1}`, date: daysAgo(84 - i * 28), time: '08:30', device: 'Evolt 360', location: 'Demo Gym', conditions: '早上空腹，运动前',
    weightKg: s.w, bodyFatPct: s.bf, bodyFatMassKg: fat, leanBodyMassKg: lean, skeletalMuscleMassKg: s.smm,
    proteinKg: Math.round(lean * 0.2 * 10) / 10, mineralKg: 3.9, totalBodyWaterKg: Math.round(lean * 0.72 * 10) / 10,
    subcutaneousFatKg: Math.round(fat * 0.86 * 10) / 10, visceralFatMassKg: Math.round(fat * 0.14 * 10) / 10,
    visceralFatAreaCm2: s.vfa, visceralFatLevel: s.vfl, intracellularWaterPct: 64 + i * 0.5, extracellularWaterPct: 36 - i * 0.5,
    bmrKcal: Math.round(370 + 21.6 * lean), teeKcal: Math.round((370 + 21.6 * lean) * 1.55), bioAge: 31 - i, bwiScore: 6.8 + i * 0.3,
    waistCm: s.waist, waistToHipRatio: Math.round((0.9 - i * 0.012) * 100) / 100,
    ranges: { bodyFatPct: [15, 20], bodyFatMassKg: [9.1, 13.7], skeletalMuscleMassKg: [27.2, 33.2], leanBodyMassKg: [48.6, 59.4], visceralFatAreaCm2: [50, 100], waistToHipRatio: [0.75, 0.9], waistCm: [0, 102] },
    segments: {
      leftArm: { leanKg: 3.1 + i * 0.03, fatKg: 1.3 - i * 0.05, leanRange: [2.7, 3.3], fatRange: [0.6, 0.9] },
      rightArm: { leanKg: 3.2 + i * 0.03, fatKg: 1.25 - i * 0.05, leanRange: [2.7, 3.3], fatRange: [0.6, 0.9] },
      torso: { leanKg: 25.1 + i * 0.1, fatKg: 11.2 - i * 0.45, leanRange: [20.2, 24.6], fatRange: [5.3, 8.0] },
      leftLeg: { leanKg: 8.6 + i * 0.05, fatKg: 3.0 - i * 0.1, leanRange: [7.4, 9.0], fatRange: [1.7, 2.5] },
      rightLeg: { leanKg: 8.7 + i * 0.05, fatKg: 2.95 - i * 0.1, leanRange: [7.4, 9.0], fatRange: [1.7, 2.5] },
    },
    upperLowerBalance: 'balanced', leftRightBalance: 'balanced',
    recommendation: { caloriesMin: 1900, caloriesMax: 2050, proteinMinG: 140, proteinMaxG: 155, carbsMinG: 180, carbsMaxG: 210, fatMinG: 55, fatMaxG: 68 },
    createdAt: new Date().toISOString(),
  };
});
counts.bodyScans = await batchWrite('bodyScans', scans, H);

const lab = (id, date, vals) => ({
  id, date, provider: 'Demo Lab', fasting: true, createdAt: new Date().toISOString(),
  items: [
    { code: 'TC', name: 'Total cholesterol', category: 'lipid', value: vals[0], unit: 'mmol/L', refHigh: 5.2 },
    { code: 'LDL', name: 'LDL cholesterol', category: 'lipid', value: vals[1], unit: 'mmol/L', refHigh: 3.4 },
    { code: 'HDL', name: 'HDL cholesterol', category: 'lipid', value: vals[2], unit: 'mmol/L', refLow: 1.0 },
    { code: 'TG', name: 'Triglycerides', category: 'lipid', value: vals[3], unit: 'mmol/L', refHigh: 1.7 },
    { code: 'FBG', name: 'Fasting glucose', category: 'glucose', value: vals[4], unit: 'mmol/L', refLow: 3.9, refHigh: 6.0 },
    { code: 'HBA1C', name: 'HbA1c', category: 'glucose', value: vals[5], unit: '%', refHigh: 5.7 },
    { code: 'ALT', name: 'ALT', category: 'liver', value: vals[6], unit: 'U/L', refHigh: 40 },
    { code: 'CREAT', name: 'Creatinine', category: 'kidney', value: vals[7], unit: 'µmol/L', refLow: 60, refHigh: 110 },
  ].map(it => ({ ...it, flag: it.refHigh !== undefined && it.value > it.refHigh ? 'high' : it.refLow !== undefined && it.value < it.refLow ? 'low' : 'normal' })),
});
const labs = [
  lab('demo-lab-1', daysAgo(180), [6.2, 4.1, 1.0, 2.0, 5.4, 5.6, 46, 88]),
  lab('demo-lab-2', daysAgo(90), [5.9, 3.8, 1.1, 1.8, 5.3, 5.5, 41, 86]),
  { ...lab('demo-lab-3', daysAgo(10), [5.4, 3.3, 1.2, 1.5, 5.1, 5.4, 35, 87]), doctorComments: 'LDL 改善中，继续饮食控制和运动，3 个月后复查。' },
];
counts.labReports = await batchWrite('labReports', labs, H);

// workouts: 4 sessions a week for 10 weeks, push/pull/legs + cardio, weights progressing
const workouts = [];
const plans = {
  push: [['Bench Press', 60, 0.5], ['Overhead Press', 35, 0.25], ['Incline Dumbbell Press', 22, 0.2]],
  pull: [['Deadlift', 100, 1], ['Lat Pulldown', 55, 0.5], ['Seated Row', 50, 0.5]],
  legs: [['Squat', 80, 0.75], ['Romanian Deadlift', 70, 0.5], ['Leg Press', 140, 1.5]],
};
let w = 0;
for (let i = 69; i >= 0; i--) {
  const date = daysAgo(i);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const week = Math.floor((69 - i) / 7);
  const day = { 1: 'push', 3: 'pull', 5: 'legs' }[dow];
  if (day) {
    workouts.push({
      id: `demo-workout-${++w}`, date, startTime: '19:00', endTime: '20:05', type: 'strength', name: `${day[0].toUpperCase()}${day.slice(1)} Day`,
      durationMin: between(55, 70), activeKcal: between(280, 380), avgHeartRate: between(115, 132), minHeartRate: between(88, 100), maxHeartRate: between(150, 165),
      source: 'apple_watch',
      exercises: plans[day].map(([name, start, inc]) => {
        const top = Math.round((start + inc * week * 2) * 2) / 2;
        return { name, sets: [{ weightKg: top - 5, reps: 10 }, { weightKg: top, reps: 8 }, { weightKg: top, reps: 7 }] };
      }),
      createdAt: new Date().toISOString(),
    });
  }
  if (dow === 6 || (dow === 2 && rnd() < 0.6)) {
    const t = pick(['stair_stepper', 'running', 'indoor_cycling']);
    workouts.push({
      id: `demo-workout-${++w}`, date, startTime: '08:00', type: t, name: { stair_stepper: 'Stair Stepper', running: 'Outdoor Run', indoor_cycling: 'Indoor Cycle' }[t],
      durationMin: between(30, 45), activeKcal: between(300, 450), avgHeartRate: between(135, 150), maxHeartRate: between(160, 175),
      distanceKm: t === 'running' ? between(5, 8, 1) : undefined, source: 'apple_watch', createdAt: new Date().toISOString(),
    });
  }
}
counts.workouts = await batchWrite('workouts', workouts, H);

const metrics = [];
for (let i = 59; i >= 0; i--) {
  metrics.push({
    id: daysAgo(i), date: daysAgo(i),
    weightKg: Math.round((78.6 - (59 - i) * 0.04 + between(-0.4, 0.4, 1)) * 10) / 10,
    steps: Math.round(between(5500, 12500)), activeKcal: Math.round(between(420, 780)), exerciseMin: Math.round(between(15, 75)),
    standHours: Math.round(between(8, 13)), restingHeartRate: Math.round(between(58, 64) - (59 - i) * 0.03),
    hrvMs: Math.round(between(38, 58)), sleepHours: between(5.8, 8.2, 1), updatedAt: new Date().toISOString(),
  });
}
counts.dailyMetrics = await batchWrite('dailyMetrics', metrics, H);

// meals: last 30 days, full nutrients; some days miss protein or overshoot sodium so the analysis has something to say
const mealDefs = {
  breakfast: [
    ['Oats + whey + banana', 420, 35, 62, 8, 2.0, 8, 18, 30, 180, 650, 220, 3],
    ['Kaya toast + 2 soft-boiled eggs + kopi', 480, 18, 52, 22, 7.5, 2, 20, 380, 620, 260, 90, 2.5],
    ['Greek yogurt + granola + berries', 380, 26, 48, 9, 3.5, 6, 22, 15, 120, 420, 280, 1.5],
  ],
  lunch: [
    ['Chicken rice (steamed)', 620, 32, 75, 20, 6.0, 2, 3, 95, 1350, 400, 40, 2],
    ['Economy rice: fish + 2 veg', 560, 30, 70, 17, 4.0, 6, 5, 70, 1100, 700, 90, 3],
    ['Grilled chicken salad bowl', 520, 42, 40, 20, 4.0, 9, 8, 110, 850, 900, 120, 3.5],
    ['Nasi lemak with egg', 740, 20, 85, 34, 15.0, 4, 6, 210, 1250, 380, 70, 2.5],
  ],
  dinner: [
    ['Salmon + brown rice + broccoli', 640, 42, 60, 22, 4.5, 7, 4, 85, 520, 1100, 80, 2],
    ['Chicken breast + sweet potato + veg', 560, 48, 55, 12, 2.5, 8, 10, 115, 480, 1200, 70, 2.5],
    ['Beef pho', 580, 34, 70, 14, 5.5, 3, 6, 70, 1900, 700, 60, 4],
    ['Tofu & mixed veg stir-fry + rice', 520, 24, 68, 16, 2.5, 8, 7, 0, 980, 750, 300, 4.5],
  ],
  snack: [
    ['Whey protein shake', 130, 25, 3, 2, 1.0, 0, 2, 50, 120, 180, 150, 0.5],
    ['Apple + almonds (20g)', 210, 5, 25, 11, 0.9, 6, 19, 0, 2, 380, 60, 1],
    ['Kopi C + kaya puff', 260, 4, 32, 13, 6.5, 1, 16, 15, 180, 120, 20, 1],
  ],
};
const meals = [];
const water = [];
let mi = 0;
for (let i = 29; i >= 0; i--) {
  const date = daysAgo(i);
  if (rnd() < 0.1) continue; // a few unlogged days
  const types = ['breakfast', 'lunch', 'dinner', ...(rnd() < 0.7 ? ['snack'] : []), ...(rnd() < 0.3 ? ['snack'] : [])];
  for (const t of types) {
    const [desc, cal, p, c, f, sf, fib, sug, chol, na, k, ca, fe] = pick(mealDefs[t]);
    const s = between(0.9, 1.15, 2);
    const r = (x, d = 0) => Math.round(x * s * 10 ** d) / 10 ** d;
    meals.push({
      id: `demo-meal-${++mi}`, date, mealType: t, description: desc,
      time: { breakfast: '08:15', lunch: '12:40', dinner: '19:45', snack: '16:00' }[t], estimated: true,
      calories: r(cal), proteinG: r(p), carbsG: r(c), fatG: r(f), saturatedFatG: r(sf, 1), fiberG: r(fib), sugarG: r(sug),
      cholesterolMg: r(chol), sodiumMg: r(na), potassiumMg: r(k), calciumMg: r(ca), ironMg: r(fe, 1),
      recordedAt: `${date}T12:00:00.000Z`,
    });
  }
  for (let g = 0; g < 4 + Math.floor(rnd() * 4); g++) water.push({ id: `demo-water-${date}-${g}`, date, amountMl: 400, source: 'manual', recordedAt: `${date}T10:00:00.000Z` });
}
counts.mealRecords = await batchWrite('mealRecords', meals, H);
counts.waterIntake = await batchWrite('waterIntake', water, H);

const foodLib = [
  ['Whey protein shake', '1 scoop (30 g)', 130, 25, 3, 2, 1.0, 0, 2, 50, 120, 180, 150, 0.5, ['protein shake', '蛋白粉']],
  ['Chicken rice (steamed)', '1 plate', 620, 32, 75, 20, 6.0, 2, 3, 95, 1350, 400, 40, 2, ['鸡饭', '海南鸡饭']],
  ['Oats + whey + banana', '1 bowl', 420, 35, 62, 8, 2.0, 8, 18, 30, 180, 650, 220, 3, ['燕麦']],
].map(([name, serving, calories, proteinG, carbsG, fatG, saturatedFatG, fiberG, sugarG, cholesterolMg, sodiumMg, potassiumMg, calciumMg, ironMg, aliases], i) =>
  ({ id: `demo-food-${i + 1}`, name, serving, aliases, calories, proteinG, carbsG, fatG, saturatedFatG, fiberG, sugarG, cholesterolMg, sodiumMg, potassiumMg, calciumMg, ironMg, createdAt: new Date().toISOString() }));
counts.foodLibrary = await batchWrite('foodLibrary', foodLib, ['id']);

const supps = [];
for (let i = 13; i >= 0; i--) {
  supps.push({ id: `demo-supp-${i}-a`, date: daysAgo(i), name: 'Fish oil', dose: '2 caps (1000 mg EPA+DHA)', createdAt: new Date().toISOString() });
  if (i % 2 === 0) supps.push({ id: `demo-supp-${i}-b`, date: daysAgo(i), name: 'Creatine', dose: '5 g', createdAt: new Date().toISOString() });
}
counts.supplementLogs = await batchWrite('supplementLogs', supps, H);

console.log(JSON.stringify({ uid, email, counts }));
process.exit(0);
