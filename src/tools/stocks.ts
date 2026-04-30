import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById } from '../firestore.js';
import { StockTransaction, StockMarket, StockAction, Currency } from '../types.js';

const COLLECTION = 'stocks';

export function registerStockTools(server: McpServer): void {

  // List stock transactions with optional filters
  server.tool(
    'get_stock_transactions',
    'Get all stock transactions (buy, sell, dividend). Optionally filter by symbol, action, or market.',
    {
      symbol: z.string().optional().describe('Filter by stock ticker symbol (e.g. AAPL)'),
      action: z.enum(['BUY', 'SELL', 'DIVIDEND']).optional().describe('Filter by action type'),
      market: z.enum(['US', 'MY', 'SG']).optional().describe('Filter by stock market'),
    },
    async ({ symbol, action, market }) => {
      const path = collectionPath(COLLECTION);
      let items = (await fetchCollection(path)) as unknown as StockTransaction[];

      if (symbol) items = items.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase());
      if (action) items = items.filter(t => t.action === action);
      if (market) items = items.filter(t => t.market === market);

      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // Add a new stock transaction
  server.tool(
    'add_stock_transaction',
    'Add a new stock transaction (buy, sell, or dividend).',
    {
      symbol: z.string().min(1).describe('Stock ticker symbol (e.g. AAPL, MAYBANK)'),
      market: z.enum(['US', 'MY', 'SG']).describe('Stock market'),
      action: z.enum(['BUY', 'SELL', 'DIVIDEND']).describe('Action type'),
      date: z.string().describe('Transaction date YYYY-MM-DD'),
      quantity: z.number().min(0).describe('Number of shares (0 for dividend)'),
      pricePerShare: z.number().min(0).describe('Price per share (0 for dividend)'),
      currency: z.enum(['MYR', 'SGD', 'USD']).describe('Currency'),
      totalAmount: z.number().describe('Total transaction amount'),
      fees: z.number().optional().describe('Transaction fees or stamp duty'),
      tax: z.number().optional().describe('Dividend withholding tax'),
      costBasis: z.number().optional().describe('Cost basis per share (for sells)'),
      excludeFromHoldings: z.boolean().optional().describe('Exclude from position calculation'),
    },
    async (input) => {
      const id = `stk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const transaction: StockTransaction = {
        id,
        symbol: input.symbol.toUpperCase(),
        market: input.market as StockMarket,
        action: input.action as StockAction,
        date: input.date,
        quantity: input.quantity,
        pricePerShare: input.pricePerShare,
        currency: input.currency as Currency,
        totalAmount: input.totalAmount,
        fees: input.fees,
        tax: input.tax,
        costBasis: input.costBasis,
        excludeFromHoldings: input.excludeFromHoldings,
      };

      await upsertDoc(collectionPath(COLLECTION), id, transaction as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, transaction }, null, 2) }],
      };
    }
  );

  // Update an existing stock transaction
  server.tool(
    'update_stock_transaction',
    'Update an existing stock transaction by its id.',
    {
      id: z.string().describe('Stock transaction id to update'),
      symbol: z.string().optional(),
      market: z.enum(['US', 'MY', 'SG']).optional(),
      action: z.enum(['BUY', 'SELL', 'DIVIDEND']).optional(),
      date: z.string().optional(),
      quantity: z.number().min(0).optional(),
      pricePerShare: z.number().min(0).optional(),
      currency: z.enum(['MYR', 'SGD', 'USD']).optional(),
      totalAmount: z.number().optional(),
      fees: z.number().optional(),
      tax: z.number().optional(),
      costBasis: z.number().optional(),
      excludeFromHoldings: z.boolean().optional(),
    },
    async ({ id, ...updates }) => {
      const path = collectionPath(COLLECTION);
      const all = (await fetchCollection(path)) as unknown as StockTransaction[];
      const existing = all.find(t => t.id === id);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Stock transaction ${id} not found` }) }] };
      }

      const updated: StockTransaction = { ...existing, ...updates } as StockTransaction;
      await upsertDoc(path, id, updated as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, transaction: updated }, null, 2) }],
      };
    }
  );

  // Delete a stock transaction
  server.tool(
    'delete_stock_transaction',
    'Delete a stock transaction by its id.',
    {
      id: z.string().describe('Stock transaction id to delete'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );
}
