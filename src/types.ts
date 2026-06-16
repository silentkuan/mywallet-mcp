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
  fatG?: number;              // 脂肪（克）
  proteinG?: number;          // 蛋白质（克）
  carbsG?: number;            // 碳水（克）
  sodiumMg?: number;          // 钠（毫克）
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

// =====================
// Life Task Management Types
// =====================

// 任务分类
export interface TaskCategory {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
  isActive?: boolean;
}

// 任务模板（习惯定义）
export interface TaskTemplate {
  id: string;
  categoryId: string;
  title: string;
  description?: string;
  recurrenceType: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'custom_days' | 'interval' | 'one_time';
  recurrenceConfig: Record<string, any>;
  priority: number;
  estimatedMinutes?: number;
  isActive: boolean;
  isAutoPausable: boolean;
  dueTime?: string;
  note?: string;
}

// 任务实例（某天的具体任务）
export interface TaskInstance {
  id: string;
  templateId: string;
  title: string;
  description?: string;
  categoryId: string;
  dueDate: string;
  dueTime?: string;
  status: 'pending' | 'completed' | 'skipped' | 'overdue';
  completedAt?: string;
  priority: number;
  note?: string;
}

// 完成记录
export interface TaskCompletion {
  id: string;
  instanceId: string;
  templateId?: string;
  completedDate: string;
  completedAt: string;
  method: 'manual' | 'auto' | 'voice' | 'batch';
  note?: string;
}

// 提醒规则
export interface ReminderRule {
  id: string;
  title: string;
  templateId?: string;
  categoryId?: string;
  channel: 'telegram' | 'push' | 'system';
  messageTemplate?: string;
  scheduleConfig: Record<string, any>;
  isActive: boolean;
  suspendStartDate?: string;
  suspendEndDate?: string;
}

// 提醒日志
export interface ReminderLog {
  id: string;
  ruleId: string;
  instanceId?: string;
  scheduledTime: string;
  sentAt?: string;
  channel: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'skipped';
  errorMessage?: string;
  deliveredAt?: string;
}

// 每日营养
export interface DailyNutrition {
  date: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  sodiumMg: number;
  waterMl: number;
  caloriesGoal: number;
  proteinGoalG: number;
  fatMinGoalG: number;
  fatMaxGoalG: number;
  sodiumGoalMg: number;
  waterGoalMl: number;
  note?: string;
}

// 餐食记录
export interface MealRecord {
  id: string;
  date: string;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'drink';
  description: string;
  imageUrl?: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  sodiumMg: number;
  recordedAt: string;
}

// 喝水记录
export interface WaterIntakeRecord {
  id: string;
  date: string;
  amountMl: number;
  recordedAt: string;
  source: 'manual' | 'reminder_auto' | 'quick_button';
}

// 出行计划
export interface TravelPlan {
  id: string;
  title: string;
  destination?: string;
  startDate: string;
  endDate: string;
  pauseWorkdayReminders: boolean;
  pauseWeekendReminders: boolean;
  pauseCategoryIds: string[];
  isActive: boolean;
  isCompleted: boolean;
  note?: string;
}

// 每日时间线
export interface DailySchedule {
  id: string;
  timeOfDay: string;
  title: string;
  description?: string;
  actionType: 'greeting' | 'news' | 'study' | 'walk_study' | 'evening_reminder' | 'exercise_check' | 'chores_reminder' | 'expense_check' | 'daily_summary' | 'custom';
  messageTemplate?: string;
  daysOfWeek: number[];
  isActive: boolean;
  sortOrder: number;
}

// 公共假期
export interface PublicHoliday {
  date: string;
  name: string;
  isReplacement: boolean;
}

// =====================
// Content Template Types
// =====================

// 内容模板（提醒生成格式模板）
export interface ContentTemplate {
  id: string;
  reminderRuleId?: string;   // optional: 关联到某条提醒
  title: string;
  format: string;            // 生成格式模板
  prompt: string;            // AI prompt 提示
  isActive: boolean;
}
