import 'dotenv/config';
import { z } from 'zod';

// Validate all required environment variables at startup.
// Fail fast with a clear error message if anything is missing.
const envSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  // The private key comes in with literal \n — replace them with real newlines
  FIREBASE_PRIVATE_KEY: z.string().min(1).transform(k => k.replace(/\\n/g, '\n')),
  // TARGET_USER_ID is fixed from env — never accept from model input (security)
  TARGET_USER_ID: z.string().min(1),
  // AES key matching the frontend localStorage MW_PRIVACY_KEY
  MW_PRIVACY_KEY: z.string().min(1),
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Missing or invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
