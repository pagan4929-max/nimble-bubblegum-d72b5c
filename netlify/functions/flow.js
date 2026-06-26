// Flow Scanner — Barchart internal API (no auth required)
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const watchlist = [
      'SPY','QQQ','AAPL','TSLA','NVDA','AMD','AMZN','MSFT','META','GOOGL',
      'NFLX','BAC','JPM','GS','XLF','IWM','DIA','GLD','TLT',
      'INTC','AVGO','QCOM','MU','MS','COIN','PLTR','SOFI',
    ];

    // This Friday + next Friday in YYYY-MM-DD
    const now = new Date();
    const day = now.getDay();
    const daysToFriday = day === 0 ? 5 : day <= 5 ? 5 - day : 6;
    const friday1 = new Date(now);
    friday1.setDate(now.getDate() + daysToFriday);
    const friday2 = new Date(friday1);
    friday2.setDate(friday1.getDate() + 7);
    const fmtISO = d =>
      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const validExpiries = new Set([fmtISO(friday1), fmtISO(friday2)]);
    const expiryStrings = [fmtISO(friday1), fmtISO(friday2)];

    const errors = [];

    // Barchart internal proxy — same endpoint the barchart.com website uses
    const fetchBarchart = async (sym) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const params = new URLSearchParams({
          symbol: sym,
          expirationType: 'weekly',
          raw: '1',
          fields: 'strikePrice,optionType,lastPrice,bidPrice,askPrice,volume,openInterest,impliedVolatility,delta,expirationDate',
        });
        const res = await fetch(
          `https://www.barchart.com/proxies/core-api/v1/options/chain?${params}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': `https://www.barchart.com/stocks/quotes/${sym}/options/weekly`,
              'Origin': 'https://www.barchart.com',
              'X-Requested-With': 'XMLHttpRequest',
            },
            signal: ctrl.signal,
          }
        );
        clearTimeout(tid);
        if (!res.ok) { errors.push(`${sym}:BC${res.status}`); return null; }
        return await res.json();
      } catch (e) {
        clearTimeout(tid);
        errors.push(`${sym}:${e.name.slice(0,8)}`);
        return null;
      }
    };

    // Nasdaq public options API (fallback)
    const fetchNasdaq = async (sym) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(
          `https://api.nasdaq.com/api/quote/${sym}/option-chain?assetclass=stocks&limit=200&expiryType=weekly&type=both`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Origin': 'https://www.nasdaq.com',
              'Referer': 'https://www.nasdaq.com/',
            },
            signal: ctrl.signal,
          }
        );
        clearTimeout(tid);
        if (!res.ok) { errors.push(`${sym}:NQ${res.status}`); return null; }
        return await res.json();
      } catch (e) {
        clearTimeout(tid);
        return null;
      }
    };

    // Parse Barchart response
    const parseBarchart = (data, sym) => {
      const rows = data?.data;
      if (!Array.isArray(rows)) return null; // null = try fallback
      return rows.map(item => {
        const r = item.raw || item;
        const expiry = r.expirationDate?.slice(0, 10);
        if (!expiry || !validExpiries.has(expiry)) return null;
        const vol = r.volume || 0;
        const oi  = r.openInterest || 0;
        const px  = r.lastPrice || 0;
        const premium = Math.round(px * vol * 100);
        const voi = oi > 0 ? Math.round((vol / oi) * 100) / 100 : 0;
        if (vol < 10 || premium < 500) return null;
        return {
          symbol: sym,
          strike: r.strikePrice || 0,
          expiry,
          type: (r.optionType || '').toLowerCase() === 'call' ? 'CALL' : 'PUT',
          price: px,
          volume: vol,
          oi,
          delta: Math.abs(r.delta || 0),
          iv: r.impliedVolatility || 0,
          premium,
          voi,
        };
      }).filter(Boolean);
    };

    // Parse Nasdaq response
    const parseNasdaq = (data, sym) => {
      const rows = data?.data?.optionChainList?.rows;
      if (!Array.isArray(rows)) return [];
      const contracts = [];
      for (const row of rows) {
        // Each row has call + put side
        for (const [side, prefix] of [['CALL','c_'], ['PUT','p_']]) {
          const raw = row[side.toLowerCase() === 'call' ? 'call' : 'put'];
          if (!raw) continue;
          const expiry = row.expirygroup
            ? (() => { const d = new Date(row.expirygroup); return isNaN(d) ? null : fmtISO(d); })()
            : null;
          if (!expiry || !validExpiries.has(expiry)) continue;
          const vol = parseInt((raw.volume || '0').replace(/,/g,'')) || 0;
          const oi  = parseInt((raw.openinterest || raw.oi || '0').replace(/,/g,'')) || 0;
          const px  = parseFloat(raw.lastprice || raw.last || '0') || 0;
          const premium = Math.round(px * vol * 100);
          const voi = oi > 0 ? Math.round((vol / oi) * 100) / 100 : 0;
          if (vol < 10 || premium < 500) continue;
          contracts.push({
            symbol: sym,
            strike: parseFloat(row.strike || row.strikeprice || '0') || 0,
            expiry,
            type: side,
            price: px,
            volume: vol,
            oi,
            delta: Math.abs(parseFloat(raw.delta || '0')) || 0,
            iv: parseFloat((raw.iv || '0').replace('%','')) / 100 || 0,
            premium,
            voi,
          });
        }
      }
      return contracts;
    };

    // Fetch each symbol: try Barchart first, Nasdaq as fallback
    const settled = await Promise.allSettled(
      watchlist.map(async sym => {
        const bcData = await fetchBarchart(sym);
        if (bcData !== null) {
          const parsed = parseBarchart(bcData, sym);
          if (parsed !== null) return parsed;
        }
        // Fallback to Nasdaq
        const nqData = await fetchNasdaq(sym);
        return nqData ? parseNasdaq(nqData, sym) : [];
      })
    );

    const all = settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    // Deduplicate by symbol|strike|expiry|type
    const seen = new Set();
    const unique = all.filter(c => {
      const key = `${c.symbol}|${c.strike}|${c.expiry}|${c.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => b.premium - a.premium);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        contracts: unique.slice(0, 100),
        meta: {
          scanned: watchlist.length,
          total: unique.length,
          expirations: expiryStrings,
          ts: new Date().toISOString(),
          errors: errors.length ? errors.slice(0, 10) : undefined,
        },
      }),
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, contracts: [] }) };
  }
};
