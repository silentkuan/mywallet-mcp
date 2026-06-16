import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById } from '../firestore.js';
import { Transaction, TransactionType, Currency } from '../types.js';

const COLLECTION = 'transactions';

export function registerTransactionTools(server: McpServer): void {

  // List transactions with optional filters
  server.tool(
    'get_transactions',
    'Get all financial transactions. Optionally filter by date range, type, or category.',
    {
      startDate: z.string().optional().describe('Filter from this date inclusive (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('Filter to this date inclusive (YYYY-MM-DD)'),
      type: z.enum(['INCOME', 'EXPENSE']).optional().describe('Filter by transaction type'),
      category: z.string().optional().describe('Filter by category name (exact match)'),
    },
    async ({ startDate, endDate, type, category }) => {
      const path = collectionPath(COLLECTION);
      let items = (await fetchCollection(path)) as unknown as Transaction[];

      if (startDate) items = items.filter(t => t.date >= startDate);
      if (endDate)   items = items.filter(t => t.date <= endDate);
      if (type)      items = items.filter(t => t.type === type);
      if (category)  items = items.filter(t => t.category === category);

      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // Add a new transaction
  server.tool(
    'add_transaction',
    'Add a new financial transaction (income or expense).',
    {
      date: z.string().describe('Date in YYYY-MM-DD format'),
      amount: z.number().min(0).describe('Transaction amount (non-negative number)'),
      currency: z.enum(['MYR', 'SGD', 'USD']).describe('Currency code'),
      type: z.enum(['INCOME', 'EXPENSE']).describe('Income or expense'),
      category: z.string().min(1).describe('Category name'),
      remark: z.string().optional().describe('Optional note or description'),
      calories: z.number().optional().describe('Calories (for food expenses only)'),
      fatG: z.number().optional().describe('脂肪（克）'),
      proteinG: z.number().optional().describe('蛋白质（克）'),
      carbsG: z.number().optional().describe('碳水（克）'),
      sodiumMg: z.number().optional().describe('钠（毫克）'),
      recurrence: z.enum(['MONTHLY', 'WEEKLY', 'YEARLY']).nullable().optional().describe('Repeat frequency'),
      tax: z.number().optional().describe('Tax amount if applicable'),
    },
    async (input) => {
      const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const transaction: Transaction = {
        id,
        date: input.date,
        amount: input.amount,
        currency: input.currency as Currency,
        type: input.type as TransactionType,
        category: input.category,
        remark: input.remark,
        calories: input.calories,
        fatG: input.fatG,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        sodiumMg: input.sodiumMg,
        recurrence: input.recurrence ?? null,
        tax: input.tax,
      };

      await upsertDoc(collectionPath(COLLECTION), id, transaction as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, transaction }, null, 2) }],
      };
    }
  );

  // Update an existing transaction
  server.tool(
    'update_transaction',
    'Update an existing transaction by its id. Only provide fields you want to change.',
    {
      id: z.string().describe('Transaction id to update'),
      date: z.string().optional(),
      amount: z.number().min(0).optional(),
      currency: z.enum(['MYR', 'SGD', 'USD']).optional(),
      type: z.enum(['INCOME', 'EXPENSE']).optional(),
      category: z.string().optional(),
      remark: z.string().optional(),
      calories: z.number().optional(),
      fatG: z.number().optional().describe('脂肪（克）'),
      proteinG: z.number().optional().describe('蛋白质（克）'),
      carbsG: z.number().optional().describe('碳水（克）'),
      sodiumMg: z.number().optional().describe('钠（毫克）'),
      recurrence: z.enum(['MONTHLY', 'WEEKLY', 'YEARLY']).nullable().optional(),
      tax: z.number().optional(),
    },
    async ({ id, ...updates }) => {
      // Fetch existing first to merge
      const path = collectionPath(COLLECTION);
      const all = (await fetchCollection(path)) as unknown as Transaction[];
      const existing = all.find(t => t.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Transaction ${id} not found` }) }] };
      }

      const updated: Transaction = { ...existing, ...updates } as Transaction;
      await upsertDoc(path, id, updated as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, transaction: updated }, null, 2) }],
      };
    }
  );

  // Delete a transaction
  server.tool(
    'delete_transaction',
    'Delete a financial transaction by its id.',
    {
      id: z.string().describe('Transaction id to delete'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );
}
