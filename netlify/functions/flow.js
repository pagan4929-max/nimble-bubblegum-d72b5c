// Flow Scanner — Yahoo Finance public API (options chain, parallel scan)
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
      'NFLX','BAC','JPM','GS','XLF','IWM','DIA','GLD','TLT','VIX',
      'INTC','AVGO','QCOM','MU','MS','COIN','PLTR','SOFI',
    ];

    // This Friday + next Friday
    const now = new Date();
    const day = now.getDay();
    const daysToFriday = day === 0 ? 5 : day <= 5 ? 5 - day : 6;
    const friday1 = new Date(now);
    friday1.setDate(now.getDate() + daysToFriday);
    const friday2 = new Date(friday1);
    friday2.setDate(friday1.getDate() + 7);
    const expirations = [friday1, friday2];
    const expiryStrings = expirations.map(d => d.toISOString().split('T')[0]);

    // Fetch options chain for one symbol/expiry, tries query2 then query1
    const fetchChain = async (sym, expiryDate) => {
      const ts = Math.floor(expiryDate.getTime() / 1000);
      for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(
            `https://${host}/v7/finance/options/${sym}?date=${ts}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
              },
              signal: ctrl.signal,
            }
          );
          clearTimeout(tid);
          if (!res.ok) continue;
          const data = await res.json();
          return data?.optionChain?.result?.[0] || null;
        } catch (_) {
          clearTimeout(tid);
        }
      }
      return null;
    };

    // Rough delta approximation from spot/strike when Yahoo omits it
    const approxDelta = (spot, strike, type) => {
      if (!spot || !strike) return 0.5;
      const m = spot / strike;
      if (type === 'call') return m > 1.05 ? 0.7 : m < 0.95 ? 0.3 : 0.5;
      return m < 0.95 ? 0.7 : m > 1.05 ? 0.3 : 0.5;
    };

    const processChain = (chain, sym, expiryStr) => {
      const spot = chain.quote?.regularMarketPrice || 0;
      const process = (opts, type) => (opts || []).map(o => {
        const vol = o.volume || 0;
        const oi  = o.openInterest || 0;
        const px  = o.lastPrice || 0;
        const premium = Math.round(px * vol * 100);
        const voi = oi > 0 ? Math.round((vol / oi) * 100) / 100 : 0;

        if (vol < 10 || premium < 500) return null;

        return {
          symbol: sym,
          strike: o.strike || 0,
          expiry: o.expiration
            ? new Date(o.expiration * 1000).toISOString().split('T')[0]
            : expiryStr,
          type: type.toUpperCase(),
          price: px,
          volume: vol,
          oi,
          delta: o.delta ? Math.abs(o.delta) : approxDelta(spot, o.strike, type),
          iv: o.impliedVolatility || 0,
          premium,
          voi,
        };
      }).filter(Boolean);

      const calls = chain.options?.[0]?.calls || [];
      const puts  = chain.options?.[0]?.puts  || [];
      return [...process(calls, 'call'), ...process(puts, 'put')];
    };

    // Build parallel task list: all symbols × all expirations
    const tasks = watchlist.flatMap(sym =>
      expirations.map((exp, i) => ({ sym, exp, expStr: expiryStrings[i] }))
    );

    const settled = await Promise.allSettled(
      tasks.map(({ sym, exp, expStr }) =>
        fetchChain(sym, exp).then(chain => chain ? processChain(chain, sym, expStr) : [])
      )
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
        },
      }),
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, contracts: [] }) };
  }
};
