import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { fetchNamedDoc, saveNamedDoc } from '../firestore.js';
import { decodeSettings, BUILT_IN_CATEGORIES } from './categories.js';
import { UserProfile } from '../types.js';

export function registerProfileTools(server: McpServer): void {

  // Get user profile
  server.tool(
    'get_profile',
    'Get the user personal profile (gender, age, height, weight, activity level).',
    {},
    async () => {
      const docPath = `users/${config.TARGET_USER_ID}/profile/main`;
      const profile = await fetchNamedDoc(docPath);
      if (!profile) {
        return { content: [{ type: 'text', text: JSON.stringify({ found: false, profile: null }) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }],
      };
    }
  );

  // Get user settings (custom categories + shortcuts)
  server.tool(
    'get_settings',
    'Get the user settings: custom expense/income categories (plus their optional icon/colour), the built-in categories, and transaction shortcuts.',
    {},
    async () => {
      // The web app stores settings encrypted; decode them the same way it does
      const settings = decodeSettings(await fetchNamedDoc(`users/${config.TARGET_USER_ID}/settings/main`) ?? undefined);
      const body = { ...settings, builtInExpenseCategories: BUILT_IN_CATEGORIES.EXPENSE, builtInIncomeCategories: BUILT_IN_CATEGORIES.INCOME };
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      };
    }
  );

  // Update user profile
  server.tool(
    'update_profile',
    'Update the user personal profile.',
    {
      gender: z.enum(['male', 'female']).optional(),
      age: z.number().int().positive().optional(),
      height: z.number().positive().optional().describe('Height in cm'),
      weight: z.number().positive().optional().describe('Weight in kg'),
      activityLevel: z.number().optional().describe('Activity level multiplier for calorie calculation'),
    },
    async (updates) => {
      const docPath = `users/${config.TARGET_USER_ID}/profile/main`;
      const existing = (await fetchNamedDoc(docPath) ?? {}) as Partial<UserProfile>;
      const updated: UserProfile = { ...existing, ...updates } as UserProfile;
      await saveNamedDoc(docPath, updated as unknown as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, profile: updated }, null, 2) }],
      };
    }
  );
}
