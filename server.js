import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

// ── Fetchers (copied from your React app) ────────────────────────────────────

async function fetchNews() {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return (d || []).slice(0, 15).map(n => ({ headline: n.headline, source: n.source, url: n.url }));
  } catch { return []; }
}

async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1&format=json');
    const d = await r.json();
    const v = d?.data?.[0];
    return v ? { value: v.value, label: v.value_classification } : null;
  } catch { return null; }
}

async function fetchAnalysts() {
  const tickers = ['NVDA','TSLA','META','AMD','AAPL','MSFT','AMZN','GOOGL','COIN'];
  const res = await Promise.allSettled(tickers.map(t =>
    fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${t}&token=${FINNHUB_KEY}`)
      .then(r => r.json())
      .then(d => { const l = (d || [])[0]; return l ? { symbol: t, buy: l.buy, hold: l.hold, sell: l.sell, strongBuy: l.strongBuy } : null; })
  ));
  return res.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

async function fetchEarnings() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return (d?.earningsCalendar || []).slice(0, 8).map(e => e.symbol);
  } catch { return []; }
}

async function fetchQuotes() {
  const tickers = ['NVDA','TSLA','META','AMD','AAPL','MSFT','AMZN','COIN','MSTR'];
  const res = await Promise.allSettled(tickers.map(t =>
    fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${FINNHUB_KEY}`)
      .then(r => r.json())
      .then(q => ({ symbol: t, price: q.c, change: q.dp }))
  ));
  return res.filter(r => r.status === 'fulfilled' && r.value?.price).map(r => r.value);
}

// ── Claude calls ──────────────────────────────────────────────────────────────

function extractJSON(text) {
  if (!text) return null;
  const c = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(c.slice(s, e + 1)); } catch { return null; }
}

async function callClaude(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`API ${resp.status}: ${data?.error?.message}`);
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const result = extractJSON(raw);
  if (!result) throw new Error('Parse failed: ' + raw.slice(0, 150));
  return result;
}

async function getHighRiskPick(today, mkt) {
  const prompt = `You are a professional high-risk ETF trading analyst. Today is ${today}.
LIVE MARKET DATA:
Fear & Greed: ${mkt.fearGreed ? mkt.fearGreed.value + '/100 — ' + mkt.fearGreed.label : 'N/A'}
Earnings today: ${mkt.earnings.join(', ') || 'none'}
Live quotes: ${mkt.quotes.map(q => `${q.symbol} $${q.price?.toFixed(2)} (${q.change >= 0 ? '+' : ''}${q.change?.toFixed(2)}%)`).join(' | ')}
Top news: ${mkt.news.slice(0, 8).map((n, i) => `${i + 1}.[${n.source}] ${n.headline}`).join('\n')}

TASK: Pick the best leveraged ETF for TODAY using eToro.
Available: TQQQ, SQQQ, SOXL, SOXS, SPXL, SPXS, LABU, TECL, ARKK, UVXY, MSTR, COIN.
Respond ONLY with raw JSON, no markdown, start with {:
{"ticker":"TQQQ","name":"ProShares UltraPro QQQ","leverage":"3x","direction":"Bull","action":"BUY","amount":"€10","upside":"+40-80% potential","rationale":"3 sentences citing specific live data.","leverage_reason":"Why this leverage level today.","sell_target":"+25%","stop_loss":"-15%","key_risk":"Main risk today."}`;
  return callClaude(prompt);
}

async function getBlueChipPick(today, mkt) {
  const analystStr = mkt.analysts.map(a => {
    const total = (a.strongBuy || 0) + (a.buy || 0) + (a.hold || 0) + (a.sell || 0);
    const pct = total ? Math.round(((a.strongBuy || 0) + (a.buy || 0)) / total * 100) : 0;
    return `${a.symbol}: ${pct}% bullish`;
  }).join(', ');

  const prompt = `You are a senior equity research analyst. Today is ${today}.
LIVE MARKET DATA:
Fear & Greed: ${mkt.fearGreed ? mkt.fearGreed.value + '/100 — ' + mkt.fearGreed.label : 'N/A'}
Analyst ratings: ${analystStr}
Live quotes: ${mkt.quotes.map(q => `${q.symbol} $${q.price?.toFixed(2)} (${q.change >= 0 ? '+' : ''}${q.change?.toFixed(2)}%)`).join(' | ')}
Top news: ${mkt.news.slice(0, 8).map((n, i) => `${i + 1}.[${n.source}] ${n.headline}`).join('\n')}

TASK: Pick ONE blue chip US stock for a long-term €10 buy via Revolut.
Candidates: NVDA, AAPL, MSFT, META, AMZN, GOOGL, TSLA, AMD, AVGO, CRM, PLTR.
Respond ONLY with raw JSON, no markdown, start with {:
{"ticker":"NVDA","name":"NVIDIA Corporation","sector":"AI / Semiconductors","action":"BUY","amount":"€10","upside":"+20-35% over 12 months","rationale":"3 sentences citing analyst data or news.","growth_thesis":"Why this company wins long-term.","sell_target":"+30%","stop_loss":"-12%","hold_period":"6-12 months","key_risk":"Main risk."}`;
  return callClaude(prompt);
}

// ── Message formatter ─────────────────────────────────────────────────────────

function formatWhatsApp(riskPick, bluePick, fearGreed, quotes) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const fng = fearGreed ? `Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})` : '';
  const topQuotes = (quotes || []).slice(0, 3)
    .map(q => `${q.symbol} $${q.price?.toFixed(2)} (${q.change >= 0 ? '+' : ''}${q.change?.toFixed(2)}%)`)
    .join('  |  ');

  return `*SIGNAL Morning Briefing*
${today}
${fng}
${topQuotes}

*HIGH RISK — eToro*
${riskPick.ticker} ${riskPick.leverage} ${riskPick.direction}
${riskPick.amount} · ${riskPick.upside}
${riskPick.rationale}
Target: ${riskPick.sell_target}  |  Stop: ${riskPick.stop_loss}
_${riskPick.key_risk}_

*BLUE CHIP — Revolut*
${bluePick.ticker} · ${bluePick.sector}
${bluePick.amount} · ${bluePick.upside}
${bluePick.rationale}
Target: ${bluePick.sell_target}  |  Hold: ${bluePick.hold_period}
_${bluePick.key_risk}_

_Not financial advice. Do your own research._`;
}

// ── API endpoint ──────────────────────────────────────────────────────────────

app.post('/api/briefing', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const [news, fearGreed, analysts, earnings, quotes] = await Promise.all([
      fetchNews(), fetchFearGreed(), fetchAnalysts(), fetchEarnings(), fetchQuotes()
    ]);

    const mkt = { news, fearGreed, analysts, earnings, quotes };

    const [riskPick, bluePick] = await Promise.all([
      getHighRiskPick(today, mkt),
      getBlueChipPick(today, mkt)
    ]);

    const text = formatWhatsApp(riskPick, bluePick, fearGreed, quotes);
    res.json({ text, riskPick, bluePick });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3001, () => console.log('SIGNAL backend running'));
