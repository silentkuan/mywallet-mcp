// Daily closing prices for the pullback check. Yahoo's chart API first, Nasdaq's historical API as backup (US only).

export interface DailyClose {
  date: string;   // YYYY-MM-DD (exchange date)
  close: number;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function yahooSymbol(symbol: string, market: string): string {
  if (market === 'SG') return symbol.toUpperCase() === 'DBS' ? 'D05.SI' : `${symbol}.SI`;
  if (market === 'MY') return `${symbol}.KL`;
  return symbol;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fromYahoo(symbol: string, market: string): Promise<DailyClose[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol, market))}?range=1y&interval=1d`;
  // Yahoo answers 429 to a full browser user agent from this server, but not to a bare one
  const data = await getJson(url, { 'User-Agent': 'Mozilla/5.0' }) as {
    chart?: { result?: { meta?: { gmtoffset?: number }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const result = data.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const offset = (result?.meta?.gmtoffset ?? 0) * 1000;
  const out: DailyClose[] = [];
  stamps.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === 'number' && c > 0) out.push({ date: new Date(t * 1000 + offset).toISOString().slice(0, 10), close: Math.round(c * 10000) / 10000 });
  });
  return out;
}

async function fromNasdaq(symbol: string): Promise<DailyClose[]> {
  const today = new Date();
  const from = new Date(today.getTime() - 370 * 86400_000).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  for (const assetclass of ['etf', 'stocks']) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${from}&todate=${to}&limit=400`;
    const data = await getJson(url, { 'User-Agent': UA, Accept: 'application/json' }) as { data?: { tradesTable?: { rows?: { date: string; close: string }[] } } | null };
    const rows = data.data?.tradesTable?.rows ?? [];
    if (rows.length === 0) continue;
    return rows
      .map(r => {
        const [m, d, y] = r.date.split('/');
        return { date: `${y}-${m}-${d}`, close: parseFloat(r.close.replace(/[$,]/g, '')) };
      })
      .filter(r => r.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return [];
}

export async function fetchDailyCloses(symbol: string, market: string): Promise<{ closes: DailyClose[]; source: string }> {
  try {
    const closes = await fromYahoo(symbol, market);
    if (closes.length > 20) return { closes, source: 'yahoo' };
  } catch (e) {
    console.warn(`[prices] yahoo ${symbol}: ${(e as Error).message}`);
  }
  if (market === 'US') {
    const closes = await fromNasdaq(symbol);
    if (closes.length > 20) return { closes, source: 'nasdaq' };
  }
  throw new Error(`No price history for ${symbol}`);
}
