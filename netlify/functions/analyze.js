exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cuerpo JSON inválido.' }) };
    }

    const { ticker, assetType, exchange, lang } = body;

    if (!ticker || !assetType || !exchange) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'ticker, assetType y exchange son requeridos.' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'API key no configurada en Netlify. Ve a Site Settings → Environment Variables y agrega ANTHROPIC_API_KEY.' })
    };

    const es = lang === 'es';

    // Dynamic date reference
    const now = new Date();
    const dateRef = now.toLocaleDateString(es ? 'es-ES' : 'en-US', { month: 'long', year: 'numeric' });

    // Sanitize inputs: strip pipe characters that would break parsing, limit length
    const safeTicker   = String(ticker).replace(/[|]/g, '').trim().slice(0, 20).toUpperCase();
    const safeAsset    = String(assetType).replace(/[|]/g, '').trim().slice(0, 50);
    const safeExchange = String(exchange).replace(/[|]/g, '').trim().slice(0, 30);

    const system = es
      ? `Eres un analista financiero experto. Responde ÚNICAMENTE con exactamente 35 valores separados por el símbolo |. NUNCA uses | dentro de un valor. Sin explicaciones, sin JSON, sin markdown, sin comillas, sin saltos de línea adicionales. Máximo 100 caracteres por campo. Si no tienes un dato exacto, da una estimación razonada.`
      : `You are an expert financial analyst. Respond ONLY with exactly 35 pipe-separated values. NEVER use the | character inside a value. No explanations, no JSON, no markdown, no quotes, no extra line breaks. Max 100 chars per field. If exact data is unavailable, provide a reasoned estimate.`;

    const fields_es = [
      'tendencia(ALCISTA|BAJISTA|LATERAL)',
      'fuerza(FUERTE|MODERADA|DEBIL)',
      'soporte1','soporte2','resistencia1','resistencia2',
      'RSI_valor_y_lectura','MACD_señal','medias_moviles','volumen_descripcion',
      'patrones_chartistas','analisis_tecnico_breve',
      'valoracion(SOBREVALORADO|INFRAVALORADO|JUSTO VALOR)',
      'metricas_clave','catalizadores','analisis_fundamental_breve',
      'sentimiento(POSITIVO|NEGATIVO|NEUTRAL)',
      'institucional','minorista','fear_greed','analisis_sentimiento_breve',
      'riesgo(ALTO|MEDIO|BAJO)','volatilidad','beta','stop_loss',
      'escenario_alcista','escenario_bajista','analisis_riesgo_breve',
      'senal(COMPRA|VENTA|MANTENER)','confianza(ALTA|MEDIA|BAJA)',
      'zona_entrada','precio_objetivo','timeframe','razon_señal','consideraciones_especiales'
    ];

    const fields_en = [
      'trend(BULLISH|BEARISH|SIDEWAYS)',
      'strength(STRONG|MODERATE|WEAK)',
      'support1','support2','resistance1','resistance2',
      'RSI_value_reading','MACD_signal','moving_averages','volume_description',
      'chart_patterns','brief_technical_analysis',
      'valuation(OVERVALUED|UNDERVALUED|FAIR VALUE)',
      'key_metrics','catalysts','brief_fundamental_analysis',
      'sentiment(POSITIVE|NEGATIVE|NEUTRAL)',
      'institutional','retail','fear_greed','brief_sentiment_analysis',
      'risk(HIGH|MEDIUM|LOW)','volatility','beta','stop_loss',
      'bullish_scenario','bearish_scenario','brief_risk_analysis',
      'signal(BUY|SELL|HOLD)','confidence(HIGH|MEDIUM|LOW)',
      'entry_zone','target_price','timeframe','signal_reason','special_considerations'
    ];

    const fields = es ? fields_es : fields_en;

    const userMsg = es
      ? `Analiza ${safeTicker} (${safeAsset}, ${safeExchange}, referencia ${dateRef}). Responde con exactamente ${fields.length} valores separados por | en este orden:\n${fields.join(' | ')}\n\nIMPORTANTE: Exactamente 35 campos separados por |. Sin texto adicional antes ni después.`
      : `Analyze ${safeTicker} (${safeAsset}, ${safeExchange}, reference ${dateRef}). Reply with exactly ${fields.length} pipe-separated values in this order:\n${fields.join(' | ')}\n\nIMPORTANT: Exactly 35 fields separated by |. No extra text before or after.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2500,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err?.error?.message || res.statusText }) };
    }

    const data = await res.json();
    let txt = (data.content?.find(b => b.type === 'text')?.text || '').trim();

    // Strip markdown code fences the model might add despite instructions
    txt = txt.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    // Collapse all line breaks into spaces so the split works correctly
    txt = txt.replace(/\r?\n/g, ' ');

    const parts = txt.split('|').map(v => v.trim().slice(0, 120));

    const g = (i, fallback = '—') => (parts[i] && parts[i].trim()) ? parts[i].trim() : fallback;

    const result = {
      ticker: safeTicker,
      nombre: safeTicker,
      tipo: safeAsset,
      resumen_ejecutivo: g(11),
      tecnico: {
        tendencia: g(0), fuerza_tendencia: g(1),
        soportes: [g(2), g(3)],
        resistencias: [g(4), g(5)],
        indicadores: { rsi: g(6), macd: g(7), medias_moviles: g(8), volumen: g(9) },
        patrones: g(10),
        analisis_detallado: g(11),
      },
      fundamental: { valoracion: g(12), metricas_clave: g(13), catalistas: g(14), analisis_detallado: g(15) },
      sentimiento: { mercado: g(16), institucional: g(17), minorista: g(18), fear_greed: g(19), analisis_detallado: g(20) },
      riesgo: { nivel: g(21), volatilidad: g(22), beta: g(23), stop_loss_sugerido: g(24), escenario_alcista: g(25), escenario_bajista: g(26), analisis_detallado: g(27) },
      senales: {
        primaria: g(28), confianza: g(29), zona_entrada: g(30),
        objetivo_precio: g(31), timeframe: g(32), razon: g(33),
        senales_especificas: [{ tipo: g(28), descripcion: g(33), condicion: g(30) }]
      },
      consideraciones_especiales: g(34),
    };

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (e) {
    if (e.name === 'AbortError') {
      return { statusCode: 504, headers, body: JSON.stringify({ error: 'La solicitud tardó demasiado. Por favor intenta de nuevo.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
