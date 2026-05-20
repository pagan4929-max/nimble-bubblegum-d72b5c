// Flow Scanner — Tradier API (datos reales de opciones, funciona desde servidor)
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // Tickers mas activos del mercado para escanear opciones
    const watchlist = [
      'SPY','QQQ','AAPL','TSLA','NVDA','AMD','AMZN','MSFT','META','GOOGL',
      'NFLX','BAC','JPM','GS','XLF','IWM','DIA','GLD','TLT','VIX'
    ];

    // Calcular fecha de expiracion de esta semana (viernes)
    const now = new Date();
    const day = now.getDay();
    const daysToFriday = day <= 5 ? 5 - day : 6;
    const friday = new Date(now);
    friday.setDate(now.getDate() + daysToFriday);
    const expiry = friday.toISOString().split('T')[0];

    // Usar Yahoo Finance API publica para obtener datos de opciones
    const allContracts = [];

    for (const sym of watchlist.slice(0, 8)) {
      try {
        const url = `https://query2.finance.yahoo.com/v7/finance/options/${sym}?date=${Math.floor(friday.getTime()/1000)}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
          }
        });

        if (!res.ok) continue;
        const data = await res.json();
        const chain = data?.optionChain?.result?.[0];
        if (!chain) continue;

        const calls = (chain.options?.[0]?.calls || []);
        const puts  = (chain.options?.[0]?.puts  || []);

        const process = (opts, type) => opts
          .filter(o => {
            const delta = Math.abs(o.delta || 0);
            const vol   = o.volume || 0;
            const oi    = o.openInterest || 0;
            const prem  = (o.lastPrice || 0) * (o.volume || 0) * 100;
            return delta >= 0.30 && delta <= 0.75 && vol >= 2500 && oi >= 2500 && prem >= 500000;
          })
          .map(o => ({
            symbol: sym,
            strike: o.strike || 0,
            expiry:  o.expiration ? new Date(o.expiration * 1000).toISOString().split('T')[0] : expiry,
            type,
            price:   o.lastPrice   || 0,
            volume:  o.volume       || 0,
            oi:      o.openInterest || 0,
            delta:   Math.abs(o.delta || 0),
            iv:      o.impliedVolatility || 0,
            premium: Math.round((o.lastPrice || 0) * (o.volume || 0) * 100),
          }));

        allContracts.push(...process(calls, 'CALL'), ...process(puts, 'PUT'));
      } catch (_) { continue; }
    }

    // Ordenar por premium descendente
    allContracts.sort((a, b) => b.premium - a.premium);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ contracts: allContracts.slice(0, 50) })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, contracts: [] }) };
  }
};
