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
    const { ticker, assetType, exchange, lang } = JSON.parse(event.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'API key no configurada en Netlify. Ve a Site Settings → Environment Variables y agrega ANTHROPIC_API_KEY.' })
    };

    const es = lang === 'es';

    // Ask for pipe-delimited plain text — NO JSON from the model
    const system = es
      ? `Eres un analista financiero experto. Responde UNICAMENTE con una lista de valores separados por el simbolo | en este orden exacto, sin explicaciones, sin JSON, sin markdown, sin saltos de linea extra. Maximo 80 caracteres por campo. Sin comillas.`
      : `You are an expert financial analyst. Respond ONLY with pipe-separated values in this exact order, no explanations, no JSON, no markdown. Max 80 chars per field. No quotes.`;

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
      ? `Analiza ${ticker} (${assetType}, ${exchange}, referencia Mayo 2026). Responde con exactamente ${fields.length} valores separados por | en este orden:\n${fields.join(' | ')}`
      : `Analyze ${ticker} (${assetType}, ${exchange}, reference May 2026). Reply with exactly ${fields.length} pipe-separated values in this order:\n${fields.join(' | ')}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err?.error?.message || res.statusText }) };
    }

    const data = await res.json();
    const txt = (data.content?.find(b => b.type === 'text')?.text || '').trim();

    // Parse pipe-delimited response — no JSON parsing needed
    const parts = txt.split('|').map(v => v.trim().replace(/\n/g,' ').replace(/\r/g,'').slice(0,120));

    const g = (i, fallback='—') => parts[i] || fallback;

    const result = {
      ticker: ticker.toUpperCase(),
      nombre: ticker.toUpperCase(),
      tipo: assetType,
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
