import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';

// Initialize Firebase Admin SDK once.
// Admin SDK bypasses App Check and Firestore security rules entirely —
// access control is enforced here by pinning to TARGET_USER_ID from env.
if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.FIREBASE_CLIENT_EMAIL,
      privateKey: config.FIREBASE_PRIVATE_KEY,
    }),
  });
}

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
export { db };
