/*
  Посредник для плитки «Рынки».
  Браузер не может читать Yahoo Finance напрямую (CORS), поэтому
  этот маленький сервер забирает данные и отдаёт их приложению.

  Развернуть: dash.cloudflare.com → Workers & Pages → Create → Worker →
  вставить этот файл целиком → Deploy → скопировать адрес *.workers.dev
  в настройки плитки «Рынки».

  Эндпоинты:
    /ping
    /quotes?s=AAPL,0700.HK,SBER.ME   — котировки (.ME = Мосбиржа)
    /chart?s=AAPL&usd=1               — дневные цены за год (usd=1 — пересчёт в доллары по курсу каждого дня)
    /metals                           — учётные цены ЦБ РФ на драгметаллы за год
    /cbrdyn?id=R01235                 — курс валюты ЦБ РФ за год
    /search?q=apple                   — поиск акций
*/

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};
let auth = null; // cookie + crumb Yahoo, живут в памяти воркера

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const cache = caches.default;
    const key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return hit;

    let data, ttl = 0;
    try {
      switch (url.pathname) {
        case '/ping':   data = { ok: true, time: Date.now() }; break;
        case '/debug':  data = await debug(); break;
        case '/quotes': data = await quotes(url.searchParams.get('s') || ''); ttl = 60; break;
        case '/chart':  data = await chart(url.searchParams.get('s') || '', url.searchParams.get('usd') === '1'); ttl = 6 * 3600; break;
        case '/metals': data = await metals(); ttl = 3 * 3600; break;
        case '/cbrdyn': data = await cbrDyn(url.searchParams.get('id') || 'R01235'); ttl = 3 * 3600; break;
        case '/search': data = await search(url.searchParams.get('q') || ''); ttl = 24 * 3600; break;
        default: return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
    const res = json(data, 200, ttl);
    if (ttl) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
};

function json(obj, status = 200, ttl = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}` }
  });
}
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };

// Цены LSE в пенсах, JSE в центах, TASE в агоротах → переводим в основную валюту
function norm(price, cur) {
  if (cur === 'GBp') return [price / 100, 'GBP'];
  if (cur === 'ZAc') return [price / 100, 'ZAR'];
  if (cur === 'ILA') return [price / 100, 'ILS'];
  return [price, cur];
}

/* ---------------- котировки ---------------- */
// Бесплатный Cloudflare разрешает ~50 внешних запросов за вызов,
// поэтому приложение присылает символы пачками по 40.
async function quotes(list) {
  const syms = [...new Set(list.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 45);
  const moex = syms.filter(s => s.endsWith('.ME')).map(s => s.slice(0, -3));
  const yah = syms.filter(s => !s.endsWith('.ME'));
  const errors = [];
  const [a, b] = await Promise.all([
    yahooQuotes(yah, errors).catch(e => { errors.push('yahoo: ' + e.message); return []; }),
    moexQuotes(moex).catch(e => { errors.push('moex: ' + e.message); return []; })
  ]);
  return { rows: [...a, ...b], errors };
}

async function yahooAuth(force) {
  if (auth && !force && Date.now() - auth.t < 3600e3) return auth;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const set = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''];
  const cookie = set.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<') || crumb.length > 40) throw new Error('crumb');
  auth = { cookie, crumb, t: Date.now() };
  return auth;
}

async function yahooQuotes(syms, errors) {
  if (!syms.length) return [];
  let out = [];
  try {
    for (const part of chunk(syms, 60)) {
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {
        const a = await yahooAuth(attempt > 0);
        const u = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(part.join(','))}&crumb=${encodeURIComponent(a.crumb)}`;
        res = await fetch(u, { headers: { 'User-Agent': UA, Cookie: a.cookie } });
        if (res.ok) break;
      }
      if (!res.ok) throw new Error('quote ' + res.status);
      const j = await res.json();
      for (const q of (j.quoteResponse && j.quoteResponse.result) || []) {
        if (q.regularMarketPrice == null) continue;
        const [price, cur] = norm(q.regularMarketPrice, q.currency);
        out.push({ s: q.symbol, name: q.longName || q.shortName || q.symbol, price, chg: q.regularMarketChangePercent ?? 0, cur, cap: q.marketCap || null });
      }
    }
    return out;
  } catch (e) {
    errors.push('yahoo quote: ' + e.message + ', пробую запасной путь');
    // запасной путь без crumb: по одному символу через chart (без капитализации)
    out = []; let fail = '';
    for (const part of chunk(syms, 8)) {
      const rows = await Promise.all(part.map(s => chartMeta(s).catch(err => { fail = err.message; return null; })));
      out.push(...rows.filter(Boolean));
    }
    if (!out.length && fail) errors.push('yahoo chart: ' + fail);
    return out;
  }
}

async function chartMeta(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const m = j.chart.result[0].meta;
  const prev = m.chartPreviousClose || m.previousClose;
  const [price, cur] = norm(m.regularMarketPrice, m.currency);
  const [p0] = norm(prev, m.currency);
  return { s, name: m.longName || m.shortName || s, price, chg: p0 ? (price / p0 - 1) * 100 : 0, cur, cap: null };
}

async function moexQuotes(ids) {
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids, 100)) {
    const u = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata'
      + '&securities.columns=SECID,SHORTNAME,SECNAME,PREVPRICE,CURRENCYID'
      + '&marketdata.columns=SECID,LAST,LCURRENTPRICE,LASTTOPREVPRICE,ISSUECAPITALIZATION'
      + '&securities=' + encodeURIComponent(part.join(','));
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const rows = t => t.data.map(r => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
    const md = Object.fromEntries(rows(j.marketdata).map(r => [r.SECID, r]));
    for (const s of rows(j.securities)) {
      const m = md[s.SECID] || {};
      const price = m.LAST ?? m.LCURRENTPRICE ?? s.PREVPRICE;
      if (price == null) continue;
      out.push({ s: s.SECID + '.ME', name: s.SECNAME || s.SHORTNAME, price, chg: m.LASTTOPREVPRICE ?? 0, cur: 'RUB', cap: m.ISSUECAPITALIZATION || null });
    }
  }
  return out;
}

/* ---------------- график за год ---------------- */
async function chart(s, usd) {
  if (!s) throw new Error('no symbol');
  const c = s.endsWith('.ME') ? await moexHistory(s.slice(0, -3)) : await yahooHistory(s);
  if (!usd || c.cur === 'USD') return c;
  // пересчёт в доллары по курсу на каждую дату
  try {
    const fx = c.cur === 'RUB' ? (await cbrDyn('R01235')).pts : (await yahooHistory(c.cur + '=X')).pts;
    if (!fx.length) throw new Error('fx');
    let j = 0;
    const pts = c.pts.map(([t, v]) => {
      while (j + 1 < fx.length && fx[j + 1][0] <= t) j++;
      return [t, +(v / fx[j][1]).toFixed(4)];
    });
    return { cur: 'USD', pts, local: c.cur };
  } catch {
    return c; // не вышло — отдаём в местной валюте, приложение это покажет
  }
}

async function yahooHistory(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('yahoo chart HTTP ' + r.status);
  const j = await r.json();
  const res = j.chart.result[0], ts = res.timestamp || [], cl = res.indicators.quote[0].close || [];
  const div = ['GBp', 'ZAc', 'ILA'].includes(res.meta.currency) ? 100 : 1;
  const pts = [];
  ts.forEach((t, i) => { if (cl[i] != null) pts.push([t * 1000, +(cl[i] / div).toFixed(4)]); });
  return { cur: norm(0, res.meta.currency)[1], pts };
}

async function moexHistory(id) {
  const from = new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10);
  const pts = [];
  for (let start = 0; start < 600; start += 100) {
    const u = `https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(id)}.json?iss.meta=off&history.columns=TRADEDATE,CLOSE&from=${from}&start=${start}`;
    const j = await (await fetch(u)).json();
    const d = j.history.data;
    d.forEach(([date, close]) => { if (close != null) pts.push([Date.parse(date), close]); });
    if (d.length < 100) break;
  }
  return { cur: 'RUB', pts };
}

/* ---------------- поиск ---------------- */
async function search(q) {
  q = q.trim();
  if (q.length < 2) return [];
  const cyr = /[а-яё]/i.test(q);
  const [y, m] = await Promise.all([
    cyr ? [] : fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`, { headers: { 'User-Agent': UA } })
      .then(r => r.json())
      .then(j => (j.quotes || []).filter(x => x.quoteType === 'EQUITY' && !x.symbol.endsWith('.ME')).map(x => ({ s: x.symbol, name: x.longname || x.shortname || x.symbol, ex: x.exchDisp || x.exchange })))
      .catch(() => []),
    fetch(`https://iss.moex.com/iss/securities.json?iss.meta=off&q=${encodeURIComponent(q)}&limit=20&securities.columns=secid,shortname,name,group,primary_boardid,is_traded`)
      .then(r => r.json())
      .then(j => j.securities.data.filter(r => r[3] === 'stock_shares' && r[4] === 'TQBR' && r[5]).map(r => ({ s: r[0] + '.ME', name: r[2] || r[1], ex: 'MOEX' })))
      .catch(() => [])
  ]);
  return cyr ? [...m, ...y] : [...y, ...m];
}

/* ---------------- диагностика: откройте /debug в браузере ---------------- */
async function debug() {
  const t = async (name, fn) => { try { return [name, 'ok: ' + await fn()]; } catch (e) { return [name, 'ОШИБКА: ' + (e && e.message || e)]; } };
  const res = await Promise.all([
    t('yahoo crumb', async () => { auth = null; const a = await yahooAuth(true); return 'crumb получен'; }),
    t('yahoo quote AAPL', async () => { const e = []; const r = await yahooQuotes(['AAPL', '7203.T'], e); if (e.length) throw new Error(e.join('; ')); return r.map(x => x.s + '=' + x.price).join(', '); }),
    t('yahoo chart AAPL', async () => { const c = await chart('AAPL'); return c.pts.length + ' точек'; }),
    t('moex SBER', async () => { const r = await moexQuotes(['SBER']); return r.map(x => x.s + '=' + x.price).join(', ') || 'пусто'; }),
    t('moex chart SBER', async () => { const c = await moexHistory('SBER'); return c.pts.length + ' точек'; }),
    t('chart 7203.T в $', async () => { const c = await chart('7203.T', true); return c.cur + ', ' + c.pts.length + ' точек'; }),
    t('cbr металлы', async () => { const c = await metals(); return 'золото ' + c.hist[1].length + ' точек'; }),
    t('cbr USD', async () => { const c = await cbrDyn('R01235'); return c.pts.length + ' точек'; })
  ]);
  return Object.fromEntries(res);
}

/* ---------------- ЦБ РФ: драгметаллы и курсы валют ---------------- */
const cbrDate = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const cbrRange = () => { const to = new Date(), from = new Date(Date.now() - 366 * 864e5); return `date_req1=${cbrDate(from)}&date_req2=${cbrDate(to)}`; };
const num = x => parseFloat(x.replace(/\s/g, '').replace(',', '.'));
async function cbrText(u) {
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('cbr HTTP ' + r.status);
  return r.text(); // названия в windows-1251 не нужны, цифры и даты — ASCII
}
async function metals() {
  const x = await cbrText('https://www.cbr.ru/scripts/xml_metall.asp?' + cbrRange());
  const hist = { 1: [], 2: [], 3: [], 4: [] };
  const re = /<Record Date="(\d\d)\.(\d\d)\.(\d{4})" Code="(\d)">\s*<Buy>([\d\s,.]+)<\/Buy>/g;
  let m;
  while ((m = re.exec(x))) hist[m[4]] && hist[m[4]].push([Date.UTC(+m[3], m[2] - 1, +m[1]), num(m[5])]);
  Object.values(hist).forEach(a => a.sort((p, q) => p[0] - q[0]));
  if (!hist[1].length) throw new Error('cbr: пустой ответ');
  return { cur: 'RUB', hist };
}
async function cbrDyn(id) {
  const x = await cbrText(`https://www.cbr.ru/scripts/XML_dynamic.asp?${cbrRange()}&VAL_NM_RQ=${encodeURIComponent(id)}`);
  const re = /<Record Date="(\d\d)\.(\d\d)\.(\d{4})"[^>]*>\s*<Nominal>(\d+)<\/Nominal>\s*<Value>([\d\s,.]+)<\/Value>/g;
  const pts = []; let m;
  while ((m = re.exec(x))) pts.push([Date.UTC(+m[3], m[2] - 1, +m[1]), +(num(m[5]) / +m[4]).toFixed(6)]);
  if (!pts.length) throw new Error('cbr: пустой ответ');
  return { cur: 'RUB', pts };
}
