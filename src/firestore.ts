import { db } from './firebase.js';
import { encryptionService } from './encryption.js';
import { config } from './config.js';
import { TransactionType, StockAction, Currency } from './types.js';

// Returns the Firestore collection path scoped to the fixed user.
// TARGET_USER_ID is always sourced from env — never accepted from model input.
export function collectionPath(collectionName: string): string {
  return `users/${config.TARGET_USER_ID}/${collectionName}`;
}

// Mirrors firebaseService.ts preparePayload exactly.
// Strips images and _decryptionFailed, then encrypts all fields except alwaysVisibleKeys.
export function preparePayload(data: Record<string, unknown>, alwaysVisibleKeys: string[]): Record<string, unknown> {
  const cleanData = { ...data };

  // Images are never stored in Firestore — strip before saving
  delete cleanData['images'];
  delete cleanData['_decryptionFailed'];

  if (!encryptionService.isConfigured()) return cleanData;

  const visible: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};

  Object.keys(cleanData).forEach(key => {
    if (alwaysVisibleKeys.includes(key)) {
      visible[key] = cleanData[key];
    } else {
      sensitive[key] = cleanData[key];
    }
  });

  const encrypted = encryptionService.encrypt(sensitive);

  // If encryption is configured but fails, abort — never write plaintext when key is set
  if (!encrypted) {
    throw new Error('Encryption failed. Data was not saved to protect privacy. Check MW_PRIVACY_KEY.');
  }

  return { ...visible, encryptedData: encrypted };
}

// Mirrors firebaseService.ts parsePayload exactly.
// Decrypts encryptedData if present; marks _decryptionFailed if key is wrong.
export function parsePayload(docData: Record<string, unknown>): Record<string, unknown> {
  if (docData['encryptedData']) {
    const decrypted = encryptionService.decrypt(docData['encryptedData'] as string) as Record<string, unknown> | null;
    if (decrypted) {
      const { encryptedData, ...visible } = docData;
      return { ...visible, ...decrypted };
    } else {
      // Decryption failed — wrong key or corrupted data
      const { encryptedData, ...visible } = docData;
      return {
        ...visible,
        _decryptionFailed: true,
        remark: '🔒 Encrypted Data',
        category: 'Locked',
        name: 'Locked Item',
        date: visible['date'] || '1970-01-01',
        type: visible['type'] || TransactionType.EXPENSE,
        amount: 0,
        currency: visible['currency'] || Currency.MYR,
        symbol: visible['symbol'] || 'LOCKED',
        action: visible['action'] || StockAction.BUY,
        quantity: 0,
        pricePerShare: 0,
        totalAmount: 0,
        costBasis: 0,
        fees: 0,
        balance: 0,
        tax: 0,
        calories: 0,
      };
    }
  }
  // No encryption — return as-is with safe defaults for optional numeric fields
  return {
    ...docData,
    costBasis: docData['costBasis'] ?? 0,
    fees: docData['fees'] ?? 0,
  };
}

// Fetch all documents from a collection, parse payloads, sort by date desc
export async function fetchCollection(path: string): Promise<Record<string, unknown>[]> {
  const snapshot = await db.collection(path).get();
  const docs = snapshot.docs.map(d => {
    const raw = { id: d.id, ...d.data() } as Record<string, unknown>;
    return parsePayload(raw);
  });
  // Sort by date descending (newest first), fall back to stable order if no date
  return docs.sort((a, b) => {
    const da = String(a['date'] ?? '');
    const db_ = String(b['date'] ?? '');
    return db_.localeCompare(da);
  });
}

// Save (upsert) a document by its id field
// Encrypts all fields except 'id'
export async function upsertDoc(path: string, id: string, data: Record<string, unknown>): Promise<void> {
  const payload = preparePayload(data, ['id']);
  await db.collection(path).doc(id).set(payload);
}

// Save (upsert) a document WITHOUT encryption (visible fields only)
// Use for non-sensitive data like task templates, reminders, etc.
export async function upsertDocPlain(path: string, id: string, data: Record<string, unknown>): Promise<void> {
  const payload = preparePayload(data, Object.keys(data));
  await db.collection(path).doc(id).set(payload);
}

// Delete a document by id
export async function deleteDocById(path: string, id: string): Promise<void> {
  await db.collection(path).doc(id).delete();
}

// Fetch a single named document (used for profile/main and settings/main)
export async function fetchNamedDoc(docPath: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(docPath).get();
  if (!snap.exists) return null;
  return snap.data() as Record<string, unknown>;
}

// Save a named document (overwrites entirely)
export async function saveNamedDoc(docPath: string, data: Record<string, unknown>): Promise<void> {
  await db.doc(docPath).set(data);
}
