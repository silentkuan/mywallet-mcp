import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectionPath, fetchCollection, upsertDoc, deleteDocById } from '../firestore.js';
import { BankAccount, Currency } from '../types.js';

const COLLECTION = 'bankAccounts';

export function registerBankAccountTools(server: McpServer): void {

  // List all bank accounts
  server.tool(
    'get_bank_accounts',
    'Get all bank accounts and e-wallet accounts.',
    {},
    async () => {
      const path = collectionPath(COLLECTION);
      const items = await fetchCollection(path);
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  // Add a new bank account
  server.tool(
    'add_bank_account',
    'Add a new bank account or e-wallet.',
    {
      name: z.string().min(1).describe('Account name (e.g. Maybank, Touch n Go)'),
      type: z.string().min(1).describe('Account type (e.g. Savings, Current, E-Wallet, Cash)'),
      currency: z.enum(['MYR', 'SGD', 'USD']).describe('Default currency for this account'),
      order: z.number().optional().describe('Display sort order'),
    },
    async (input) => {
      const id = `bank-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const account: BankAccount = {
        id,
        name: input.name,
        type: input.type,
        currency: input.currency as Currency,
        order: input.order,
      };

      await upsertDoc(collectionPath(COLLECTION), id, account as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, account }, null, 2) }],
      };
    }
  );

  // Delete a bank account
  server.tool(
    'delete_bank_account',
    'Delete a bank account by its id.',
    {
      id: z.string().describe('Bank account id to delete'),
    },
    async ({ id }) => {
      await deleteDocById(collectionPath(COLLECTION), id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: id }) }],
      };
    }
  );
}
