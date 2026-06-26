// Flow Scanner — CBOE delayed quotes API (no auth required, works server-side)
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

    // This Friday + next Friday
    const now = new Date();
    const day = now.getDay();
    const daysToFriday = day === 0 ? 5 : day <= 5 ? 5 - day : 6;
    const friday1 = new Date(now);
    friday1.setDate(now.getDate() + daysToFriday);
    const friday2 = new Date(friday1);
    friday2.setDate(friday1.getDate() + 7);

    // CBOE uses MM/DD/YYYY for expiration_date field
    const fmtCBOE = d =>
      `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
    const fmtISO = d =>
      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    const cboeExpiries = [fmtCBOE(friday1), fmtCBOE(friday2)];
    const expiryStrings = [fmtISO(friday1), fmtISO(friday2)];

    const errors = [];

    // Fetch CBOE delayed options chain for one symbol (8s timeout)
    const fetchCBOE = async (sym) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(
          `https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
              'Referer': 'https://www.cboe.com/',
            },
            signal: ctrl.signal,
          }
        );
        clearTimeout(tid);
        if (!res.ok) { errors.push(`${sym}:${res.status}`); return null; }
        return await res.json();
      } catch (e) {
        clearTimeout(tid);
        errors.push(`${sym}:${e.name}`);
        return null;
      }
    };

    // Parse CBOE response into our contract shape
    const processCBOE = (data, sym) => {
      const opts = data?.data?.options;
      if (!Array.isArray(opts)) return [];

      return opts.map(o => {
        if (!cboeExpiries.includes(o.expiration_date)) return null;

        const vol = o.volume || 0;
        const oi  = o.open_interest || 0;
        const px  = o.last_trade_price || 0;
        const premium = Math.round(px * vol * 100);
        const voi = oi > 0 ? Math.round((vol / oi) * 100) / 100 : 0;

        if (vol < 10 || premium < 500) return null;

        const [m, dd, y] = o.expiration_date.split('/');
        return {
          symbol: sym,
          strike: parseFloat(o.strike_price) || 0,
          expiry: `${y}-${m}-${dd}`,
          type: o.option_type === 'C' ? 'CALL' : 'PUT',
          price: px,
          volume: vol,
          oi,
          delta: Math.abs(o.delta || 0),
          iv: o.iv || 0,
          premium,
          voi,
        };
      }).filter(Boolean);
    };

    // Fetch all symbols in parallel
    const settled = await Promise.allSettled(
      watchlist.map(sym =>
        fetchCBOE(sym).then(data => data ? processCBOE(data, sym) : [])
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
          errors: errors.length ? errors.slice(0, 8) : undefined,
        },
      }),
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, contracts: [] }) };
  }
};
