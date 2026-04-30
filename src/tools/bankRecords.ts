import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc } from '../firestore.js';
import { BankBalanceRecord } from '../types.js';

const COLLECTION = 'bankRecords';

export function registerBankRecordTools(server: McpServer): void {

  // List bank balance records with optional filters
  server.tool(
    'get_bank_records',
    'Get monthly bank balance records. Optionally filter by bank account id or month.',
    {
      bankId: z.string().optional().describe('Filter by bank account id'),
      month: z.string().optional().describe('Filter by month in YYYY-MM format'),
    },
    async ({ bankId, month }) => {
      const path = collectionPath(COLLECTION);
      let items = (await fetchCollection(path)) as unknown as BankBalanceRecord[];

      if (bankId) items = items.filter(r => r.bankId === bankId);
      if (month)  items = items.filter(r => r.month === month);

      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // Upsert a monthly balance record
  server.tool(
    'update_bank_record',
    'Set or update the end-of-month balance for a bank account. Creates the record if it does not exist.',
    {
      bankId: z.string().describe('Bank account id'),
      month: z.string().describe('Month in YYYY-MM format'),
      balance: z.number().describe('End-of-month balance amount'),
    },
    async ({ bankId, month, balance }) => {
      // Composite id matches the frontend convention
      const id = `${bankId}-${month}`;
      const record: BankBalanceRecord = { id, bankId, month, balance };

      await upsertDoc(collectionPath(COLLECTION), id, record as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, record }, null, 2) }],
      };
    }
  );
}
