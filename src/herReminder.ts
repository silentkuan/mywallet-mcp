// Evening Telegram reminder for her period: every day from PREP_DAYS before the predicted start
// until she starts (or a week late). Runs once a day after HER_REMIND_HOUR, Singapore time.
import { forecastPeriod, shouldRemindPeriod, periodMessage } from './herLogic.js';
import { listPeriods, getHerState, saveHerState } from './tools/her.js';
import { sgToday } from './investPlan.js';
import { sendTelegram, telegramConfigured } from './telegram.js';
import { config } from './config.js';

export async function runHerReminder(): Promise<{ sent: boolean; reason: string }> {
  const today = sgToday();
  const state = await getHerState();
  if (state.lastPeriodNotice === today) return { sent: false, reason: 'already checked today' };
  const forecast = forecastPeriod(await listPeriods(), today);
  let sent = false;
  if (shouldRemindPeriod(forecast) && telegramConfigured()) sent = await sendTelegram(periodMessage(forecast));
  await saveHerState({ ...state, lastPeriodNotice: today });
  return { sent, reason: shouldRemindPeriod(forecast) ? (sent ? 'reminded' : 'telegram failed or not set') : `no reminder (${forecast.phase})` };
}

export function startHerScheduler(): void {
  if (config.INVEST_CHECKER !== 'on') return;
  let running = false;
  const tick = async () => {
    const sgHour = (new Date().getUTCHours() + 8) % 24;
    if (running || sgHour < config.HER_REMIND_HOUR) return;
    running = true;
    try {
      const r = await runHerReminder();
      if (r.reason !== 'already checked today') console.log(`[her] ${r.reason}`);
    } catch (e) {
      console.error('[her] reminder failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 10 * 60_000);
  setTimeout(tick, 45_000);
  console.log(`[her] reminder on — daily after ${config.HER_REMIND_HOUR}:00 Singapore time`);
}
