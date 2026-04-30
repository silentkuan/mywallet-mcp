// Copied and adapted from mywalletAI src/types.ts
// Changes: removed browser-only fields (images), kept all enums and interfaces

export enum Language {
  EN = 'EN',
  ZH = 'ZH',
}

export enum Currency {
  MYR = 'MYR',
  SGD = 'SGD',
  USD = 'USD',
}

export enum TransactionType {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

export enum StockMarket {
  US = 'US',
  MY = 'MY',
  SG = 'SG',
}

export enum StockAction {
  BUY = 'BUY',
  SELL = 'SELL',
  DIVIDEND = 'DIVIDEND',
}

export interface UserProfile {
  gender: 'male' | 'female';
  age: number;
  height: number;
  weight: number;
  activityLevel?: number;
}

export interface TransactionShortcut {
  id: string;
  name: string;
  type: TransactionType;
  amount?: number;
  currency: Currency;
  category: string;
  remark?: string;
  calories?: number;
  icon?: string;
}

export interface UserSettings {
  customExpenseCategories: string[];
  customIncomeCategories: string[];
  transactionShortcuts: TransactionShortcut[];
}

export interface Transaction {
  id: string;
  date: string;               // YYYY-MM-DD
  amount: number;
  currency: Currency;
  type: TransactionType;
  category: string;
  remark?: string;
  calories?: number;
  // images intentionally omitted — base64 blobs, never stored in Firestore
  encryptedData?: string;
  _decryptionFailed?: boolean;
  recurrence?: 'MONTHLY' | 'WEEKLY' | 'YEARLY' | null;
  recurrenceId?: string;
  recurrenceCount?: number;
  tax?: number;
}

export interface StockTransaction {
  id: string;
  symbol: string;
  market: StockMarket;
  action: StockAction;
  date: string;               // YYYY-MM-DD
  quantity: number;
  pricePerShare: number;
  costBasis?: number;
  currency: Currency;
  totalAmount: number;
  fees?: number;
  tax?: number;
  excludeFromHoldings?: boolean;
  encryptedData?: string;
  _decryptionFailed?: boolean;
}

export interface BankAccount {
  id: string;
  name: string;
  type: string;
  currency: Currency;
  encryptedData?: string;
  order?: number;
}

export interface BankBalanceRecord {
  id: string;                 // Composite: bankId + month
  bankId: string;
  month: string;              // YYYY-MM
  balance: number;
  encryptedData?: string;
}
