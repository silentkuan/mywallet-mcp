// End-to-end check of the category tools against a running server (use a tester account!).
//   MCP_URL=http://127.0.0.1:3010/mcp MCP_API_KEY=... node scripts/test-categories.mjs
// It adds and removes test categories and one test transaction, and leaves the tester's other settings as they were.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:3010/mcp';
const client = new Client({ name: 'category-test', version: '1.0.0' });
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

const A = 'ZzTest Pets', B = 'ZzTest Pet Care', INC = 'ZzTest Side Gig';

// ── tool list ──
const { tools } = await client.listTools();
const names = new Set(tools.map(t => t.name));
check('tools registered', ['add_category', 'rename_category', 'delete_category', 'get_settings'].every(n => names.has(n)));

// ── get_settings is decoded ──
const before = await call('get_settings');
check('get_settings returns decoded lists', Array.isArray(before.customExpenseCategories) && !('encryptedData' in before), before);
check('get_settings lists built-ins', before.builtInExpenseCategories?.includes('Food') && before.builtInIncomeCategories?.includes('Salary'), before);
const keepExpense = before.customExpenseCategories.filter(c => !c.startsWith('ZzTest'));
const keepShortcuts = JSON.stringify(before.transactionShortcuts);

// ── add ──
let r = await call('add_category', { name: A, type: 'EXPENSE', icon: '🐶', color: '#22c55e' });
check('add new category', r.success && r.added === true, r);
r = await call('add_category', { name: A.toUpperCase(), type: 'EXPENSE' });
check('same name (other case) is not added again', r.success && r.added === false, r);
r = await call('add_category', { name: 'food', type: 'EXPENSE' });
check('built-in name is not added', r.added === false && /built-in/.test(r.reason), r);
r = await call('add_category', { name: 'Bad Colour', type: 'EXPENSE', color: 'green' });
check('invalid colour rejected', r.isError === true || r.success === false, r);
r = await call('add_category', { name: INC, type: 'INCOME' });
check('add income category', r.added === true, r);

let s = await call('get_settings');
check('new category saved with style', s.customExpenseCategories.includes(A) && s.categoryStyles?.EXPENSE?.[A]?.icon === '🐶', s.categoryStyles);
check('existing custom categories kept', keepExpense.every(c => s.customExpenseCategories.includes(c)), s.customExpenseCategories);
check('shortcuts untouched', JSON.stringify(s.transactionShortcuts) === keepShortcuts);
check('added only once', s.customExpenseCategories.filter(c => c.toLowerCase() === A.toLowerCase()).length === 1, s.customExpenseCategories);

// ── rename moves transactions ──
const tx = await call('add_transaction', { date: '2026-01-02', amount: 12.3, currency: 'MYR', type: 'EXPENSE', category: A, remark: 'category tool test' });
check('test transaction added', tx.success, tx);
r = await call('rename_category', { type: 'EXPENSE', from: A, to: B, dryRun: true });
check('rename dry run counts the transaction', r.dryRun && r.transactions === 1, r);
r = await call('rename_category', { type: 'EXPENSE', from: A, to: 'Food' });
check('rename onto an existing name refused', r.success === false, r);
r = await call('rename_category', { type: 'EXPENSE', from: 'Food', to: 'Meals' });
check('renaming a built-in refused', r.success === false, r);
r = await call('rename_category', { type: 'EXPENSE', from: A, to: B });
check('rename done', r.success && r.transactionsMoved === 1, r);
let txs = await call('get_transactions', { category: B });
check('transaction now uses new name', Array.isArray(txs) && txs.some(t => t.id === tx.id), txs);
s = await call('get_settings');
check('settings renamed, style kept', s.customExpenseCategories.includes(B) && !s.customExpenseCategories.includes(A) && s.categoryStyles?.EXPENSE?.[B]?.color === '#22c55e', s);

// ── delete ──
r = await call('delete_category', { type: 'EXPENSE', name: B });
check('delete refused while in use', r.success === false && r.transactions === 1, r);
r = await call('delete_category', { type: 'EXPENSE', name: B, moveTo: 'Nope Not Here' });
check('delete with unknown moveTo refused', r.success === false, r);
r = await call('delete_category', { type: 'EXPENSE', name: 'Food' });
check('deleting a built-in refused', r.success === false, r);
r = await call('delete_category', { type: 'EXPENSE', name: B, moveTo: 'other' });
check('delete with moveTo', r.success && r.movedTo === 'Other' && r.transactionsMoved === 1, r);
txs = await call('get_transactions', { category: 'Other' });
check('transaction moved to Other', txs.some(t => t.id === tx.id), txs.length);
r = await call('delete_category', { type: 'INCOME', name: INC });
check('unused category deleted', r.success && r.transactionsMoved === 0, r);

s = await call('get_settings');
check('test categories gone, style removed', !s.customExpenseCategories.includes(B) && !s.customIncomeCategories.includes(INC) && !s.categoryStyles?.EXPENSE?.[B], s);
check('other custom categories still there', keepExpense.every(c => s.customExpenseCategories.includes(c)), s.customExpenseCategories);
check('shortcuts still untouched', JSON.stringify(s.transactionShortcuts) === keepShortcuts);

await call('delete_transaction', { id: tx.id });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
await client.close();
process.exit(failed ? 1 : 0);
