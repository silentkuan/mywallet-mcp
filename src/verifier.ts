// Client for the host's Claude checker (mywalletAI/claude-verifier), reached over a bind-mounted Unix socket.
// Optional: without VERIFIER_TOKEN every call reports "unavailable".
import http from 'http';
import { config } from './config.js';
import { ClaudePullbackAnswer } from './investPlan.js';

const WAIT_MS = 200_000;

function post(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      socketPath: config.VERIFIER_SOCKET, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${config.VERIFIER_TOKEN}` },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new Error(json.error || `HTTP ${res.statusCode}`));
          else resolve(json);
        } catch { reject(new Error('bad answer')); }
      });
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new Error(`no answer within ${WAIT_MS / 1000}s`)));
    req.on('error', reject);
    req.end(data);
  });
}

export const verifierConfigured = (): boolean => Boolean(config.VERIFIER_TOKEN);

// Claude's latest close and 52-week closing high per symbol; null when Claude is not reachable or fails
export async function claudePullback(stocks: { symbol: string; market: string }[]): Promise<Map<string, ClaudePullbackAnswer> | null> {
  if (!verifierConfigured() || stocks.length === 0) return null;
  try {
    const data = await post('/pullback', { stocks }) as { results?: (ClaudePullbackAnswer & { symbol: string })[] };
    const found = new Map<string, ClaudePullbackAnswer>();
    for (const r of data.results ?? []) found.set(String(r.symbol).toUpperCase(), r);
    return found;
  } catch (e) {
    console.warn('[claude] pullback check unavailable:', (e as Error).message);
    return null;
  }
}
