// Firestore access for the monthly investment plan (all documents encrypted except id)
import { db } from './firebase.js';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById, parsePayload, preparePayload } from './firestore.js';
import { InvestmentPlan, InvestmentState, InvestEvent, InvestAlert } from './investPlan.js';

const PLAN_COLLECTION = 'investmentPlan';
export const EVENTS_COLLECTION = 'investmentEvents';
export const ALERTS_COLLECTION = 'investmentAlerts';

async function readNamed<T>(id: 'main' | 'state'): Promise<T | null> {
  const snap = await db.collection(collectionPath(PLAN_COLLECTION)).doc(id).get();
  if (!snap.exists) return null;
  const data = parsePayload({ id: snap.id, ...snap.data() });
  if (data['_decryptionFailed']) throw new Error(`investmentPlan/${id} could not be decrypted — check MW_PRIVACY_KEY`);
  return data as unknown as T;
}

async function writeNamed(id: 'main' | 'state', data: object): Promise<void> {
  const payload = preparePayload({ ...data, id } as Record<string, unknown>, ['id']);
  await db.collection(collectionPath(PLAN_COLLECTION)).doc(id).set(payload);
}

export const getPlan = () => readNamed<InvestmentPlan>('main');
export const savePlan = (plan: InvestmentPlan) => writeNamed('main', plan);

export async function getState(): Promise<InvestmentState> {
  const state = await readNamed<InvestmentState>('state');
  return { id: 'state', watch: {}, release: null, ...(state ?? {}) };
}
export const saveState = (state: InvestmentState) => writeNamed('state', state);

export async function getEvents(): Promise<InvestEvent[]> {
  const items = await fetchCollection(collectionPath(EVENTS_COLLECTION));
  return items.filter(e => !e['_decryptionFailed']) as unknown as InvestEvent[];
}

export async function getAlerts(): Promise<InvestAlert[]> {
  const items = await fetchCollection(collectionPath(ALERTS_COLLECTION));
  return items.filter(e => !e['_decryptionFailed']) as unknown as InvestAlert[];
}

export const saveEvent = (e: InvestEvent) => upsertDoc(collectionPath(EVENTS_COLLECTION), e.id, e as unknown as Record<string, unknown>);
export const deleteEvent = (id: string) => deleteDocById(collectionPath(EVENTS_COLLECTION), id);
export const saveAlert = (a: InvestAlert) => upsertDoc(collectionPath(ALERTS_COLLECTION), a.id, a as unknown as Record<string, unknown>);
