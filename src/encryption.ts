// @ts-ignore — crypto-js lacks complete ESM types but works fine at runtime
import CryptoJS from 'crypto-js';
import { config } from './config.js';

// Mirrors encryptionService.ts from the frontend exactly.
// Key difference: reads MW_PRIVACY_KEY from process.env instead of localStorage.

export const encryptionService = {
  getKey(): string {
    return config.MW_PRIVACY_KEY;
  },

  // Encrypt any object to an AES ciphertext string
  encrypt(data: unknown): string | null {
    const key = this.getKey();
    if (!key) return null;
    try {
      const json = JSON.stringify(data);
      return CryptoJS.AES.encrypt(json, key).toString();
    } catch (e) {
      console.error('Encryption failed', e);
      return null;
    }
  },

  // Decrypt an AES ciphertext string back to the original object
  decrypt(ciphertext: string): unknown {
    const key = this.getKey();
    if (!key) return null;
    try {
      const bytes = CryptoJS.AES.decrypt(ciphertext, key);
      const decryptedData = bytes.toString(CryptoJS.enc.Utf8);
      if (!decryptedData) return null;
      return JSON.parse(decryptedData);
    } catch (e) {
      console.error('Decryption failed', e);
      return null;
    }
  },

  isConfigured(): boolean {
    return !!this.getKey();
  },
};
