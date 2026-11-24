// Sends plain-text messages through the Telegram Bot API. Optional: without a token and chat id nothing is sent.
import { config } from './config.js';

export const telegramConfigured = (): boolean => Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[telegram] send failed: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    // Never log the URL — it carries the bot token
    console.error('[telegram] send failed:', (e as Error).name);
    return false;
  }
}
