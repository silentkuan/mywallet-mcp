import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HEALTH_PROFILE_DOC, NUTRIENT_KEYS, DEFAULT_NUTRITION_TARGETS, NutritionTargets, TargetRange,
  targetRangeSchema, getHealthNamedDoc, saveHealthNamedDoc, mergePatch, jsonResult, nowISO,
} from './healthCommon.js';

export const HEALTH_GOALS = ['fat_loss', 'muscle_gain', 'lower_cholesterol', 'lower_blood_sugar', 'lower_blood_pressure', 'endurance', 'maintain'] as const;

export interface HealthProfile {
  sex?: 'male' | 'female';
  birthDate?: string;
  age?: number;
  heightCm?: number;
  activityLevel?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goals?: (typeof HEALTH_GOALS)[number][];
  goalNotes?: string;
  // Concrete targets the dashboard tracks progress against
  targetWeightKg?: number;
  targetBodyFatPct?: number;
  targetWaistCm?: number;
  targetSkeletalMuscleKg?: number;
  targetLdl?: number;          // same unit as the lab reports (usually mmol/L)
  targetTotalCholesterol?: number;
  targetDate?: string;
  dietPreferences?: string;
  allergies?: string[];
  medicalConditions?: string[];
  medications?: string[];
  nutritionTargets?: NutritionTargets;
  updatedAt?: string;
}

export async function loadHealthProfile(): Promise<HealthProfile> {
  return (await getHealthNamedDoc<HealthProfile>(HEALTH_PROFILE_DOC())) ?? {};
}

// Profile targets win; anything missing falls back to the defaults.
export function effectiveTargets(profile: HealthProfile): NutritionTargets {
  return { ...DEFAULT_NUTRITION_TARGETS, ...(profile.nutritionTargets ?? {}) };
}

const nutritionTargetsShape = Object.fromEntries(
  [...NUTRIENT_KEYS, 'waterMl'].map(k => [k, targetRangeSchema.nullable().optional()])
) as Record<string, z.ZodOptional<z.ZodNullable<typeof targetRangeSchema>>>;

export function registerHealthProfileTools(server: McpServer): void {

  server.tool(
    'get_health_profile',
    '获取健康档案：性别、年龄、身高、健康目标（减脂/增肌/降胆固醇等）、具体目标值、饮食偏好、过敏、病史、用药，以及当前生效的每日营养目标。做任何健康建议之前先读这个。',
    {},
    async () => {
      const profile = await loadHealthProfile();
      return jsonResult({ profile, effectiveNutritionTargets: effectiveTargets(profile) });
    }
  );

  server.tool(
    'update_health_profile',
    '更新健康档案。只传需要修改的字段；传 null 可清除某个字段。数组字段（goals/allergies 等）会整体替换。',
    {
      sex: z.enum(['male', 'female']).nullable().optional(),
      birthDate: z.string().nullable().optional().describe('YYYY-MM-DD'),
      age: z.number().int().positive().nullable().optional().describe('不知道生日时可只填年龄'),
      heightCm: z.number().positive().nullable().optional(),
      activityLevel: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']).nullable().optional(),
      goals: z.array(z.enum(HEALTH_GOALS)).nullable().optional(),
      goalNotes: z.string().nullable().optional(),
      targetWeightKg: z.number().positive().nullable().optional(),
      targetBodyFatPct: z.number().positive().nullable().optional(),
      targetWaistCm: z.number().positive().nullable().optional(),
      targetSkeletalMuscleKg: z.number().positive().nullable().optional(),
      targetLdl: z.number().positive().nullable().optional().describe('LDL 目标，单位与验血报告相同（通常 mmol/L）'),
      targetTotalCholesterol: z.number().positive().nullable().optional().describe('总胆固醇目标，单位与验血报告相同'),
      targetDate: z.string().nullable().optional().describe('YYYY-MM-DD'),
      dietPreferences: z.string().nullable().optional(),
      allergies: z.array(z.string()).nullable().optional(),
      medicalConditions: z.array(z.string()).nullable().optional(),
      medications: z.array(z.string()).nullable().optional(),
    },
    async (patch) => {
      const current = await loadHealthProfile();
      const updated = mergePatch(current as Record<string, unknown>, patch) as HealthProfile;
      updated.updatedAt = nowISO();
      await saveHealthNamedDoc(HEALTH_PROFILE_DOC(), updated as Record<string, unknown>);
      return jsonResult({ success: true, profile: updated });
    }
  );

  server.tool(
    'set_nutrition_goals',
    '设置每日营养目标（区间）。每项是 {min?, max?}：蛋白质/纤维/钾/钙用 min，钠/饱和脂肪/糖/胆固醇用 max，热量/碳水/脂肪用 min+max。传 null 恢复该项默认值。未设置的项使用默认值（针对减脂、增肌、降胆固醇）。',
    nutritionTargetsShape,
    async (patch) => {
      const profile = await loadHealthProfile();
      const targets: Record<string, TargetRange> = { ...(profile.nutritionTargets ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete targets[k];
        else targets[k] = v as TargetRange;
      }
      profile.nutritionTargets = targets;
      profile.updatedAt = nowISO();
      await saveHealthNamedDoc(HEALTH_PROFILE_DOC(), profile as Record<string, unknown>);
      return jsonResult({ success: true, effectiveNutritionTargets: effectiveTargets(profile) });
    }
  );
}
