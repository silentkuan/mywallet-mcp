import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { encryptionService } from '../encryption.js';
import { collectionPath, preparePayload } from '../firestore.js';
import { CategoryStyle, TransactionShortcut, UserSettings } from '../types.js';

// Built-in categories — keep in sync with EXPENSE_CATEGORIES / INCOME_CATEGORIES in mywalletAI src/constants.ts.
// They live in the web app's code, not in settings, so they cannot be renamed or deleted here.
export const BUILT_IN_CATEGORIES: Record<CategoryType, string[]> = {
  EXPENSE: ['Food', 'Transport', 'Housing', 'Utilities', 'Shopping', 'Entertainment', 'Health', 'Education', 'Other'],
  INCOME: ['Salary', 'Business', 'Investment', 'Dividend', 'Gift', 'Other'],
};

type CategoryType = 'EXPENSE' | 'INCOME';

const LIST_KEY: Record<CategoryType, 'customExpenseCategories' | 'customIncomeCategories'> = {
  EXPENSE: 'customExpenseCategories',
  INCOME: 'customIncomeCategories',
};

const MAX_NAME_LENGTH = 40;
// Firestore batches hold at most 500 writes
const BATCH_SIZE = 400;

const settingsRef = () => db.doc(`users/${config.TARGET_USER_ID}/settings/main`);

// Reads the settings doc the way the web app stores it: { id, encryptedData } (or plain fields in very old docs).
// Every other field in the doc is kept as-is.
export function decodeSettings(raw: Record<string, unknown> | undefined): UserSettings & Record<string, unknown> {
  let data: Record<string, unknown> = {};
  if (raw) {
    const { encryptedData, ...visible } = raw;
    if (typeof encryptedData === 'string') {
      const decrypted = encryptionService.decrypt(encryptedData) as Record<string, unknown> | null;
      // Writing back without the real contents would wipe the user's categories and shortcuts
      if (!decrypted) throw new Error('Cannot decrypt settings with MW_PRIVACY_KEY. Nothing was changed.');
      data = { ...visible, ...decrypted };
    } else {
      data = { ...visible };
    }
  }
  delete data['id'];
  return {
    ...data,
    customExpenseCategories: Array.isArray(data['customExpenseCategories']) ? data['customExpenseCategories'] as string[] : [],
    customIncomeCategories: Array.isArray(data['customIncomeCategories']) ? data['customIncomeCategories'] as string[] : [],
    transactionShortcuts: Array.isArray(data['transactionShortcuts']) ? data['transactionShortcuts'] as TransactionShortcut[] : [],
  };
}

// Same layout the web app writes: only `id` visible, everything else encrypted
const encodeSettings = (settings: Record<string, unknown>) => preparePayload({ ...settings, id: 'main' }, ['id']);

// Read-modify-write in a Firestore transaction, so a save from the web app at the same moment cannot be lost
async function updateSettings<T>(change: (settings: UserSettings & Record<string, unknown>) => T): Promise<T> {
  return db.runTransaction(async tx => {
    const ref = settingsRef();
    const snap = await tx.get(ref);
    const settings = decodeSettings(snap.exists ? snap.data() : undefined);
    const result = change(settings);
    tx.set(ref, encodeSettings(settings));
    return result;
  });
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function allCategories(settings: UserSettings, type: CategoryType): string[] {
  return [...BUILT_IN_CATEGORIES[type], ...settings[LIST_KEY[type]]];
}

// Exact match first, then case-insensitive
function findCustom(settings: UserSettings, type: CategoryType, name: string): string | undefined {
  const list = settings[LIST_KEY[type]];
  return list.find(c => c === name) ?? list.find(c => sameName(c, name));
}

function setStyle(settings: UserSettings, type: CategoryType, name: string, style: CategoryStyle | undefined): void {
  const styles = { ...(settings.categoryStyles ?? {}) };
  const forType = { ...(styles[type] ?? {}) };
  if (style && (style.icon || style.color)) forType[name] = style;
  else delete forType[name];
  styles[type] = forType;
  settings.categoryStyles = styles;
}

interface RawTx {
  ref: FirebaseFirestore.DocumentReference;
  raw: Record<string, unknown>;
  data: Record<string, unknown> | null; // null = could not decrypt
}

async function loadTransactions(): Promise<RawTx[]> {
  const snap = await db.collection(collectionPath('transactions')).get();
  return snap.docs.map(d => {
    const raw = d.data() as Record<string, unknown>;
    if (typeof raw['encryptedData'] !== 'string') return { ref: d.ref, raw, data: raw };
    const decrypted = encryptionService.decrypt(raw['encryptedData']) as Record<string, unknown> | null;
    return { ref: d.ref, raw, data: decrypted };
  });
}

// Changes only `category` and writes the doc back in its original layout
async function moveTransactions(txs: RawTx[], to: string): Promise<void> {
  for (let i = 0; i < txs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, raw, data } of txs.slice(i, i + BATCH_SIZE)) {
      if (!data) continue;
      if (typeof raw['encryptedData'] === 'string') {
        const encrypted = encryptionService.encrypt({ ...data, category: to });
        if (!encrypted) throw new Error('Encryption failed. Check MW_PRIVACY_KEY.');
        batch.set(ref, { ...raw, encryptedData: encrypted });
      } else {
        batch.update(ref, { category: to });
      }
    }
    await batch.commit();
  }
}

const usingCategory = (txs: RawTx[], type: CategoryType, name: string) =>
  txs.filter(t => t.data && t.data['type'] === type && t.data['category'] === name);

const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] });

const typeSchema = z.enum(['EXPENSE', 'INCOME']).describe('EXPENSE or INCOME');
const nameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const iconSchema = z.string().trim().min(1).max(8).optional().describe('Optional emoji shown next to the category, e.g. "🐶"');
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b82f6').optional().describe('Optional colour as #RRGGBB');

export function registerCategoryTools(server: McpServer): void {

  server.tool(
    'add_category',
    'Add a custom transaction category to the user settings. If a category with the same name (case-insensitive, built-ins included) already exists nothing is added; when icon/color are given for an existing custom category they are updated.',
    {
      name: nameSchema.describe('Category name as it should appear in the app'),
      type: typeSchema,
      icon: iconSchema,
      color: colorSchema,
    },
    async ({ name, type, icon, color }) => {
      const result = await updateSettings(settings => {
        const existing = allCategories(settings, type).find(c => sameName(c, name));
        const isBuiltIn = BUILT_IN_CATEGORIES[type].some(c => sameName(c, name));
        if (existing) {
          if ((icon || color) && !isBuiltIn) {
            const before = settings.categoryStyles?.[type]?.[existing] ?? {};
            setStyle(settings, type, existing, { ...before, ...(icon && { icon }), ...(color && { color }) });
            return { added: false, reason: 'already exists', category: existing, styleUpdated: true };
          }
          return { added: false, reason: isBuiltIn ? 'already exists (built-in)' : 'already exists', category: existing };
        }
        settings[LIST_KEY[type]] = [...settings[LIST_KEY[type]], name];
        if (icon || color) setStyle(settings, type, name, { ...(icon && { icon }), ...(color && { color }) });
        return { added: true, category: name };
      });
      return reply({ success: true, type, ...result });
    }
  );

  server.tool(
    'rename_category',
    'Rename a custom category. Transactions and shortcuts that use the old name are moved to the new name. Built-in categories cannot be renamed.',
    {
      type: typeSchema,
      from: nameSchema.describe('Current name of the custom category'),
      to: nameSchema.describe('New name'),
      dryRun: z.boolean().optional().describe('Only report what would change'),
    },
    async ({ type, from, to, dryRun }) => {
      const before = decodeSettings((await settingsRef().get()).data());
      const current = findCustom(before, type, from);
      if (!current) {
        const builtIn = BUILT_IN_CATEGORIES[type].some(c => sameName(c, from));
        return reply({ success: false, error: builtIn ? `"${from}" is a built-in category and cannot be renamed.` : `No custom ${type} category "${from}".` });
      }
      const clash = allCategories(before, type).find(c => sameName(c, to) && c !== current);
      if (clash) return reply({ success: false, error: `"${clash}" already exists. Use delete_category with moveTo to merge them.` });

      const txs = await loadTransactions();
      const locked = txs.filter(t => !t.data).length;
      if (locked > 0) return reply({ success: false, error: `${locked} transaction(s) cannot be decrypted, so it is unknown whether they use "${current}". Nothing was changed.` });
      const affected = usingCategory(txs, type, current);
      const shortcuts = before.transactionShortcuts.filter(s => s.type === type && s.category === current).length;
      if (dryRun) return reply({ success: true, dryRun: true, from: current, to, transactions: affected.length, shortcuts });

      await updateSettings(settings => {
        const name = findCustom(settings, type, current);
        if (!name) throw new Error(`"${current}" was removed while renaming. Nothing was changed.`);
        settings[LIST_KEY[type]] = settings[LIST_KEY[type]].map(c => (c === name ? to : c));
        const style = settings.categoryStyles?.[type]?.[name];
        setStyle(settings, type, name, undefined);
        if (style) setStyle(settings, type, to, style);
        settings.transactionShortcuts = settings.transactionShortcuts.map(s =>
          s.type === type && s.category === name ? { ...s, category: to } : s);
      });
      await moveTransactions(affected, to);
      return reply({ success: true, type, from: current, to, transactionsMoved: affected.length, shortcutsMoved: shortcuts });
    }
  );

  server.tool(
    'delete_category',
    'Delete a custom category. Refused while transactions or shortcuts still use it, unless moveTo names another category of the same type to move them to. Built-in categories cannot be deleted.',
    {
      type: typeSchema,
      name: nameSchema.describe('Custom category to delete'),
      moveTo: nameSchema.optional().describe('Existing category (same type) that takes over its transactions and shortcuts'),
      dryRun: z.boolean().optional().describe('Only report what would change'),
    },
    async ({ type, name, moveTo, dryRun }) => {
      const before = decodeSettings((await settingsRef().get()).data());
      const current = findCustom(before, type, name);
      if (!current) {
        const builtIn = BUILT_IN_CATEGORIES[type].some(c => sameName(c, name));
        return reply({ success: false, error: builtIn ? `"${name}" is a built-in category and cannot be deleted.` : `No custom ${type} category "${name}".` });
      }
      let target: string | undefined;
      if (moveTo) {
        target = allCategories(before, type).find(c => sameName(c, moveTo));
        if (!target) return reply({ success: false, error: `moveTo "${moveTo}" is not an existing ${type} category. Add it first with add_category.` });
        if (target === current) return reply({ success: false, error: 'moveTo must be a different category.' });
      }

      const txs = await loadTransactions();
      const locked = txs.filter(t => !t.data).length;
      if (locked > 0) return reply({ success: false, error: `${locked} transaction(s) cannot be decrypted, so it is unknown whether they use "${current}". Nothing was changed.` });
      const affected = usingCategory(txs, type, current);
      const shortcuts = before.transactionShortcuts.filter(s => s.type === type && s.category === current).length;

      if ((affected.length > 0 || shortcuts > 0) && !target) {
        return reply({
          success: false,
          error: `"${current}" is still used by ${affected.length} transaction(s) and ${shortcuts} shortcut(s). Pass moveTo to move them to another category.`,
          transactions: affected.length,
          shortcuts,
        });
      }
      if (dryRun) return reply({ success: true, dryRun: true, category: current, moveTo: target ?? null, transactions: affected.length, shortcuts });

      // Move first: if that fails part-way the category still exists and nothing is orphaned
      if (target && affected.length > 0) await moveTransactions(affected, target);
      await updateSettings(settings => {
        settings[LIST_KEY[type]] = settings[LIST_KEY[type]].filter(c => c !== current);
        setStyle(settings, type, current, undefined);
        if (target) {
          settings.transactionShortcuts = settings.transactionShortcuts.map(s =>
            s.type === type && s.category === current ? { ...s, category: target as string } : s);
        }
      });
      return reply({ success: true, type, deleted: current, movedTo: target ?? null, transactionsMoved: affected.length, shortcutsMoved: target ? shortcuts : 0 });
    }
  );
}
