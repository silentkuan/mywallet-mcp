import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dateSchema, todayStr, addDays, daysBetween, round, jsonResult } from './healthCommon.js';
import { loadHealthProfile, HealthProfile } from './healthProfile.js';
import { listScans, scanDelta, BodyScan } from './bodyScans.js';
import { listLabReports, latestLabValues } from './labReports.js';
import { listWorkouts, summarizeWorkouts } from './workouts.js';
import { listDailyMetrics } from './dailyMetrics.js';
import { nutritionSummary } from './nutrition.js';
import { energyBalanceForOverview } from './energy.js';

function goalProgress(profile: HealthProfile, latest?: BodyScan, first?: BodyScan, labs?: ReturnType<typeof latestLabValues>) {
  const rows: { metric: string; start?: number; current?: number; target: number; remaining?: number }[] = [];
  const add = (metric: string, target: number | undefined, current?: number, start?: number) => {
    if (target === undefined) return;
    rows.push({ metric, start, current, target, remaining: current === undefined ? undefined : round(current - target, 2) });
  };
  add('weightKg', profile.targetWeightKg, latest?.weightKg, first?.weightKg);
  add('bodyFatPct', profile.targetBodyFatPct, latest?.bodyFatPct, first?.bodyFatPct);
  add('waistCm', profile.targetWaistCm, latest?.waistCm, first?.waistCm);
  add('skeletalMuscleMassKg', profile.targetSkeletalMuscleKg, latest?.skeletalMuscleMassKg, first?.skeletalMuscleMassKg);
  add('LDL', profile.targetLdl, labs?.find(l => l.code === 'LDL')?.latest.value);
  add('TC', profile.targetTotalCholesterol, labs?.find(l => l.code === 'TC')?.latest.value);
  return rows;
}

export function registerHealthOverviewTools(server: McpServer): void {

  server.tool(
    'get_health_overview',
    '一次拿到健康全貌：健康档案和目标、最新身体检测及变化、目标进度、最新验血结果、最近 7 天饮食 vs 目标（不足 / 超标）、热量收支（更长期间用 get_energy_balance）、最近 7 天和 28 天运动统计、近期体重和日常数据，以及数据缺口提醒。每次健康相关对话先调用这个。',
    { date: dateSchema.optional().describe('以哪天为「今天」，默认今天') },
    async ({ date }) => {
      const today = date ?? todayStr();
      const weekStart = addDays(today, -6);
      const monthStart = addDays(today, -27);

      const [profile, scans, labs, workouts28, metrics, nutrition] = await Promise.all([
        loadHealthProfile(),
        listScans(),
        listLabReports(),
        listWorkouts(monthStart, today),
        listDailyMetrics(addDays(today, -29), today),
        nutritionSummary(weekStart, today),
      ]);

      const latest = scans[0], previous = scans[1], first = scans[scans.length - 1];
      const labValues = latestLabValues(labs);
      const workouts7 = workouts28.filter(w => w.date >= weekStart);
      const weights = metrics.filter(m => m.weightKg !== undefined).map(m => ({ date: m.date, weightKg: m.weightKg! }));

      const dataGaps: string[] = [];
      if (!latest) dataGaps.push('还没有身体检测记录');
      else if (daysBetween(latest.date, today) > 42) dataGaps.push(`上次身体检测是 ${daysBetween(latest.date, today)} 天前，建议每 4–6 周复测`);
      if (!labs.length) dataGaps.push('还没有验血报告（降胆固醇需要血脂数据）');
      else if (daysBetween(labs[0].date, today) > 120) dataGaps.push(`上次验血是 ${daysBetween(labs[0].date, today)} 天前`);
      if (nutrition.loggedDays < 5) dataGaps.push(`最近 7 天只有 ${nutrition.loggedDays} 天有饮食记录`);
      const lowCoverage = Object.entries(nutrition.nutrientCoverage).filter(([k, v]) => ['saturatedFatG', 'fiberG', 'cholesterolMg'].includes(k) && v < 0.7).map(([k]) => k);
      if (nutrition.loggedDays && lowCoverage.length) dataGaps.push(`饮食记录缺少 ${lowCoverage.join(', ')} 的估算（降胆固醇的关键指标）`);
      if (!profile.goals?.length) dataGaps.push('健康档案还没设定目标');

      return jsonResult({
        today,
        profile,
        bodyComposition: latest ? {
          latest,
          changeSincePrevious: previous ? scanDelta(latest, previous) : null,
          changeSinceFirst: first && first.id !== latest.id ? scanDelta(latest, first) : null,
          scanCount: scans.length,
        } : null,
        goalProgress: goalProgress(profile, latest, first, labValues),
        labs: labs.length ? { latestReportDate: labs[0].date, latestValues: labValues } : null,
        nutritionLast7Days: { ...nutrition, daily: undefined },
        energyBalanceLast7Days: energyBalanceForOverview(nutrition.daily, scans, profile, workouts7, metrics, today),
        workouts: {
          last7Days: summarizeWorkouts(workouts7, weekStart, today),
          last28Days: summarizeWorkouts(workouts28, monthStart, today),
          recent: workouts7.slice(0, 5),
        },
        dailyMetricsLast30Days: { count: metrics.length, weights, latest: metrics[0] ?? null },
        dataGaps,
      });
    }
  );
}

export const HEALTH_INSTRUCTIONS = `
mywallet-mcp 同时是用户的个人理财和健康管理数据库。

健康管理助理守则：
1. 健康相关对话开始时先调用 get_health_overview，了解目标（减脂、增肌、降胆固醇）、最新身体数据和近期饮食运动。
2. 用户上传身体检测报告、验血报告、Apple Watch 截图或食物照片时：读出所有能看到的数字 → 先列给用户确认 → 再写入（add_body_scan / add_lab_report / log_workout / log_meal）。看不清的数字要问，不要猜。
3. 记录饮食：先 search_foods 看食物库有没有；没有就估算营养，并尽量填饱和脂肪、纤维、糖、胆固醇、钾（降胆固醇的关键），设 estimated=true。同一种食物第二次出现或用户给了营养标签时，用 save_food 存进食物库。
4. 运动：只记录单次运动（类型、时长、活动卡路里、心率）。Apple Watch 的「7 天平均」「4 周运动天数」等汇总不是单次运动，不要写入。重训尽量问清楚动作、组数、次数和重量。
5. 体重、步数、睡眠、静息心率等每日数据用 log_daily_metrics。
6. 消费记录（add_transaction）只记花了多少钱和吃了什么，不记卡路里；饮食营养一律用 log_meal。
7. 问到热量缺口、为什么没瘦、该吃多少时，用 get_energy_balance（可指定期间），它会用身体检测的实际变化校对估算。
8. 分析时用数据说话：引用具体数字和趋势，和目标比较，指出不足和超标，给可执行的建议。BIA 体脂仪受喝水、进食和测量时间影响，比较时注意测量条件。
9. 不做医疗诊断；验血结果明显异常时建议看医生。
`.trim();
