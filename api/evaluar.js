/**
 * ============================================================================
 * DARABIA ENGINE V5 — BACKEND PROXY
 * api/evaluar.js · Vercel Serverless Function (Node.js 18+)
 *
 * Autor: Honás Darabia (Jonás Agudo Osuna) · IES Virgen del Pilar, Zaragoza
 * Módulo: Psicosociología Aplicada (PRL) · Curso 2025-2026
 *
 * RESPONSABILIDADES:
 *   1. Recibir el payload del motor cliente (script_caso05_core.js)
 *   2. Resolver el JSON del caso por caso_id (intermodularidad)
 *   3. Construir el system prompt dinámicamente desde la rúbrica del JSON
 *   4. Llamar a la API de Anthropic (o devolver Mock si DARABIA_MOCK=true)
 *   5. Validar y reenviar la respuesta estructurada al motor
 *
 * SEGURIDAD:
 *   - La API key NUNCA sale del servidor. Vive en variables de entorno Vercel.
 *   - El cliente nunca ve ANTHROPIC_API_KEY.
 *
 * INTERMODULARIDAD:
 *   - Para añadir el Caso 06: require('../data/caso06.json') y añadir al mapa.
 *   - Cero refactor del motor cliente entre casos.
 *
 * VARIABLES DE ENTORNO REQUERIDAS (Vercel → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY   → sk-ant-...  (NUNCA en el código)
 *   DARABIA_MOCK        → "true" para staging/desarrollo sin coste de API
 *   DARABIA_ENV         → "production" | "staging" | "development"
 * ============================================================================
 */

'use strict';

// ============================================================================
// SECCIÓN A — REGISTRO DE CASOS (intermodularidad: añadir caso = añadir línea)
// ============================================================================

const CASOS = {
  'psicosocial_gestoria_v1': require('../data/psicosocial_gestoria.json'),
  // 'psicosocial_hospital_v1': require('../data/psicosocial_hospital.json'),  ← Caso 06
  // 'psicosocial_logistica_v1': require('../data/psicosocial_logistica.json'), ← Caso 07
};

// ============================================================================
// SECCIÓN B — CONSTANTES Y CONFIGURACIÓN
// ============================================================================

const CONFIG = {
  modelo: 'claude-sonnet-4-20250514',
  max_tokens: 2000,
  timeout_ms: 50000,
  version_motor_soportada: '5.0.0',
  cors_origins_permitidos: [
    'https://darabia.vercel.app',
    'https://ies-virgen-pilar.aeducar.es',
    'http://localhost:3000',   // desarrollo local
    'http://127.0.0.1:5500',  // Live Server VS Code
  ],
};

// ============================================================================
// SECCIÓN C — HANDLER PRINCIPAL (entry point de Vercel)
// ============================================================================

module.exports = async function handler(req, res) {

  // — CORS —
  _setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // — Solo POST —
  if (req.method !== 'POST') {
    return _error(res, 405, 'METHOD_NOT_ALLOWED', 'Solo se admite POST.');
  }

  try {
    // 1. Parsear y validar payload de entrada
    const payload = _validarPayload(req.body);

    // 2. Resolver JSON del caso
    const caso = _resolverCaso(payload.caso_id);

    // 3. Rama Mock o Real
    const esMock = process.env.DARABIA_MOCK === 'true';
    const respuesta = esMock
      ? _generarMock(caso, payload)
      : await _llamarAnthropic(caso, payload);

    // 4. Validar estructura de respuesta antes de enviar al motor
    _validarRespuestaIA(respuesta, caso);

    // 5. Log de auditoría (sin datos personales sensibles)
    _logAuditoria(payload, respuesta, esMock);

    return res.status(200).json(respuesta);

  } catch (err) {
    return _manejarError(res, err);
  }
};

// ============================================================================
// SECCIÓN D — VALIDACIÓN DEL PAYLOAD ENTRANTE
// ============================================================================

/**
 * Verifica que el motor envía lo mínimo necesario para la evaluación.
 * Falla rápido con mensaje claro si algo falta — no intentamos adivinar.
 */
function _validarPayload(body) {
  if (!body || typeof body !== 'object') {
    throw _crearError('PAYLOAD_INVALIDO', 400, 'El cuerpo de la petición no es un objeto JSON válido.');
  }

  const requeridos = ['caso_id', 'version_motor', 'alumno', 'dictamen'];
  for (const campo of requeridos) {
    if (!body[campo]) {
      throw _crearError('PAYLOAD_INVALIDO', 400, `Campo requerido ausente: "${campo}".`);
    }
  }

  if (!body.alumno?.validado || !body.alumno?.nombre) {
    throw _crearError('ALUMNO_NO_VALIDADO', 400, 'El alumno no está validado en el payload.');
  }

  if (!body.dictamen?.texto_completo || body.dictamen.texto_completo.trim().length < 200) {
    throw _crearError('DICTAMEN_INSUFICIENTE', 400, 'El dictamen está vacío o es demasiado breve (mínimo 200 caracteres).');
  }

  // Advertencia de versión (no bloquea, pero se loguea)
  if (body.version_motor !== CONFIG.version_motor_soportada) {
    console.warn(`[EVALUAR] Versión de motor inesperada: ${body.version_motor} (esperada: ${CONFIG.version_motor_soportada})`);
  }

  return body;
}

// ============================================================================
// SECCIÓN E — RESOLUCIÓN DEL CASO POR caso_id
// ============================================================================

function _resolverCaso(caso_id) {
  const caso = CASOS[caso_id];
  if (!caso) {
    throw _crearError(
      'CASO_NO_ENCONTRADO',
      404,
      `El caso_id "${caso_id}" no está registrado en este servidor. ¿Falta añadirlo al mapa CASOS?`
    );
  }
  return caso;
}

// ============================================================================
// SECCIÓN F — CONSTRUCCIÓN DEL SYSTEM PROMPT (dinámica, desde el JSON del caso)
// ============================================================================

/**
 * El system prompt se genera 100% desde el JSON del caso.
 * Cuando llegue el prompt_evaluacion_psico.txt en la Fase 3, este método
 * lo incorporará como sección adicional. Por ahora construye el prompt
 * completo desde la rúbrica del JSON para que la Fase 2 sea autosuficiente.
 *
 * NUNCA hay criterios hardcodeados aquí. Todo viene del caso.
 */
function _construirSystemPrompt(caso, payload) {
  const { rubrica_evaluacion, ejes_evaluacion, mapeo_ejes_criterios, knockout_criteria } = caso.aciertos_criticos;

  // — Identidad del perito evaluador —
  const identidad = `Eres Honás Darabia, técnico PRL colegiado nº 0847, perito evaluador del simulador de psicosociología aplicada Darabia Engine V5.
Tu función es evaluar el dictamen de un alumno de CFGS Prevención de Riesgos Profesionales y devolver una evaluación estructurada en JSON.
Tono: directo, técnico, preciso. Sin condescendencia. Sin relleno. Los comentarios al profesor son útiles o no son.`;

  // — Contexto del caso —
  const ctxCaso = `
CASO: ${caso.caso.titulo}
SECTOR: ${caso.caso.sector}
MODELOS TEÓRICOS DEL CASO: ${caso.caso.modelos_teoricos.join(', ')}
INSTRUMENTO: ${caso.caso.instrumento}
EMPRESA: ${caso.contexto.empresa}
PLANTILLA: ${caso.contexto.plantilla} personas
DATOS OBJETIVOS: Absentismo ${caso.contexto.datos_objetivos.absentismo} (sector: ${caso.contexto.datos_objetivos.referencia_sector}), ${caso.contexto.datos_objetivos.bajas_psicologicas_12m} bajas psicológicas en 12 meses (${caso.contexto.datos_objetivos.dias_baja_total} días), horas extra media marzo: ${caso.contexto.datos_objetivos.horas_extra_media_marzo}, última evaluación psicosocial: ${caso.contexto.datos_objetivos.ultima_evaluacion_psicosocial}.`;

  // — Rúbrica completa (generada dinámicamente desde el JSON) —
  const rubricaTexto = rubrica_evaluacion.criterios.map(c =>
    `  - ${c.nombre} (id: "${c.id}", peso: ${c.peso}%): ${c.descripcion}`
  ).join('\n');

  const rubrica = `
RÚBRICA DE EVALUACIÓN (total: ${rubrica_evaluacion.total_sumando}%):
${rubricaTexto}`;

  // — Mapeo ejes → criterios —
  const mapeoTexto = Object.entries(mapeo_ejes_criterios).map(([eje, criterios]) =>
    `  - ${eje}: evalúa los criterios [${criterios.join(', ')}]`
  ).join('\n');

  const ejesTexto = `
EJES DE EVALUACIÓN Y SU MAPEO A CRITERIOS:
${mapeoTexto}`;

  // — Criterios knockout (generados dinámicamente) —
  const knockoutsTexto = Object.entries(knockout_criteria).map(([id, ko]) =>
    `  - KNOCKOUT "${id}": ${ko.descripcion}
    Penalización si se ignora: ${ko.penalizacion_si_ignorada} puntos sobre nota_global.
    Penalización si se diagnostica sin protocolo: ${ko.penalizacion_diagnostico_sin_protocolo} puntos sobre nota_global.
    Respuesta mínima exigida: "${ko.respuesta_minima}".`
  ).join('\n');

  const knockouts = `
CRITERIOS KNOCKOUT TRANSVERSALES (no suman, solo restan si se fallan):
${knockoutsTexto}`;

  // — Llaves desbloqueadas por el alumno —
  const llavesTexto = payload.llaves_desbloqueadas?.length > 0
    ? payload.llaves_desbloqueadas.join(', ')
    : 'Ninguna llave desbloqueada.';

  const llaves = `
EVIDENCIAS DESBLOQUEADAS POR EL ALUMNO DURANTE LAS ENTREVISTAS:
  ${llavesTexto}
(Usa esto para contextualizar el dictamen — el alumno tuvo acceso a estas evidencias.)`;

  // — Instrucciones de salida (JSON estricto) —
  const instruccionesSalida = `
INSTRUCCIONES DE EVALUACIÓN:
1. Lee el dictamen completo del alumno.
2. Evalúa cada criterio de la rúbrica con rigor técnico.
3. Aplica penalizaciones knockout si corresponde (restan de nota_global).
4. Calcula nota_global como suma ponderada de criterios (0-100), con knockouts aplicados. Nunca por debajo de 0.
5. Para cada eje de evaluación, calcula la puntuación obtenida sobre su máximo (suma de pesos de los criterios que componen ese eje).
6. Redacta nota_asesoramiento_docente: texto para el profesor que explique los puntos fuertes, débiles y qué observar en la corrección manual (40%). Máximo 300 palabras. Sin florituras.

FORMATO DE SALIDA — RESPONDE ÚNICAMENTE CON ESTE JSON. SIN TEXTO ANTES NI DESPUÉS. SIN BACKTICKS. SIN MARKDOWN:
{
  "nota_global": <número 0-100>,
  "vector_ejes": [
    ${ejes_evaluacion.map(eje => {
      const criteriosDelEje = mapeo_ejes_criterios[eje] || [];
      const maxEje = rubrica_evaluacion.criterios
        .filter(c => criteriosDelEje.includes(c.id))
        .reduce((s, c) => s + c.peso, 0);
      return `{ "eje": "${eje}", "puntuacion": <número 0-${maxEje}>, "max": ${maxEje} }`;
    }).join(',\n    ')}
  ],
  "detalle_criterios": {
    ${rubrica_evaluacion.criterios.map(c =>
      `"${c.id}": { "puntuacion": <número 0-${c.peso}>, "max": ${c.peso}, "observacion": "<máx 80 palabras>" }`
    ).join(',\n    ')}
  },
  "knockouts_aplicados": [
    { "id": "<knockout_id>", "penalizacion": <número>, "motivo": "<texto breve>" }
  ],
  "nota_asesoramiento_docente": "<texto para el profesor, máx 300 palabras>"
}`;

  // — JSON completo del caso (referencia literal para el Prompt Maestro) —
  // El modelo tiene acceso directo a aciertos_criticos, rubrica_evaluacion,
  // knockout_criteria, jerarquia_preventiva e indicadores_validos sin ambigüedades.
  const jsonCasoCompleto = `
================================================================================
REFERENCIA TÉCNICA — JSON COMPLETO DEL CASO (fuente de verdad para la evaluación)
================================================================================
${JSON.stringify(caso, null, 2)}
================================================================================`;

  return [identidad, ctxCaso, rubrica, ejesTexto, knockouts, llaves, instruccionesSalida, jsonCasoCompleto].join('\n');
}

// ============================================================================
// SECCIÓN G — LLAMADA A LA API DE ANTHROPIC (con reintentos backoff)
// ============================================================================

async function _llamarAnthropic(caso, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw _crearError('CONFIG_ERROR', 500, 'ANTHROPIC_API_KEY no está configurada en las variables de entorno de Vercel.');
  }

  const systemPrompt = _construirSystemPrompt(caso, payload);

  const mensajeUsuario = `DICTAMEN DEL ALUMNO A EVALUAR:
Alumno: ${payload.alumno.nombre} | Grupo: ${payload.alumno.grupo || 'no especificado'}
Timestamp de envío: ${payload.timestamp_envio}

${payload.dictamen.texto_completo}`;

  // — Política de reintentos —
  // intento 1 → inmediato
  // intento 2 → +2s
  // intento 3 → +4s
  // Solo se reintenta en errores transitorios (rate limit, sobrecarga, timeout).
  const MAX_INTENTOS = 3;
  const ESPERAS_MS = [0, 2000, 4000];
  const CODIGOS_REINTENTABLES = ['LIMITE_CUOTA', 'API_SOBRECARGADA', 'TIMEOUT_API'];

  let ultimoError;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    if (ESPERAS_MS[intento - 1] > 0) {
      await new Promise(r => setTimeout(r, ESPERAS_MS[intento - 1]));
    }

    try {
      return await _ejecutarLlamadaAnthropic(apiKey, systemPrompt, mensajeUsuario);
    } catch (err) {
      ultimoError = err;
      const esReintentable = CODIGOS_REINTENTABLES.includes(err.codigo);
      if (!esReintentable || intento === MAX_INTENTOS) {
        throw err;
      }
      console.warn(`[EVALUAR] Intento ${intento}/${MAX_INTENTOS} fallido (${err.codigo}). Reintentando...`);
    }
  }

  throw ultimoError; // defensa: nunca debería llegar aquí
}

/**
 * Helper privado: una sola llamada a Anthropic + parseo de respuesta.
 * Extraído de _llamarAnthropic para que el bucle de reintentos sea limpio.
 * El cuerpo es exactamente el de la versión anterior, sin cambios funcionales.
 */
async function _ejecutarLlamadaAnthropic(apiKey, systemPrompt, mensajeUsuario) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout_ms);

  let respuestaRaw;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.modelo,
        max_tokens: CONFIG.max_tokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: mensajeUsuario }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // — Manejo de códigos de error de Anthropic —
    if (resp.status === 401) throw _crearError('API_KEY_INVALIDA', 502, 'La API key es inválida o ha expirado.');
    if (resp.status === 429) throw _crearError('LIMITE_CUOTA', 429, 'Límite de rate de Anthropic alcanzado. Reintenta en unos segundos.');
    if (resp.status === 402) throw _crearError('SIN_SALDO', 402, 'Cuenta de Anthropic sin saldo suficiente.');
    if (resp.status === 529) throw _crearError('API_SOBRECARGADA', 503, 'API de Anthropic sobrecargada. Reintenta en unos segundos.');
    if (!resp.ok) throw _crearError('API_ERROR', 502, `Anthropic respondió con HTTP ${resp.status}.`);

    respuestaRaw = await resp.json();

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw _crearError('TIMEOUT_API', 504, `La API de Anthropic no respondió en ${CONFIG.timeout_ms / 1000}s.`);
    }
    if (err.codigo) throw err; // ya es un error nuestro, relanzar
    throw _crearError('RED_ERROR', 502, `Error de red al contactar Anthropic: ${err.message}`);
  }

  // — Extraer texto de la respuesta de Anthropic —
  const textoRespuesta = respuestaRaw?.content
    ?.filter(b => b.type === 'text')
    ?.map(b => b.text)
    ?.join('')
    ?.trim();

  if (!textoRespuesta) {
    throw _crearError('RESPUESTA_VACIA', 502, 'Anthropic devolvió una respuesta sin contenido de texto.');
  }

  // — Parsear JSON (limpiando posibles backticks si el modelo se equivoca) —
  const jsonLimpio = textoRespuesta
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(jsonLimpio);
  } catch (parseErr) {
    throw _crearError(
      'JSON_INVALIDO',
      502,
      `La IA devolvió texto que no es JSON válido. Fragmento: "${jsonLimpio.substring(0, 200)}..."`
    );
  }
}

// ============================================================================
// SECCIÓN H — MODO MOCK (DARABIA_MOCK=true)
// ============================================================================

/**
 * Genera una respuesta simulada válida que satisface _validarRespuestaIA del motor.
 * Los valores son realistas (no todos perfectos) para que el circuito de
 * renderizado de resultados sea testeable de extremo a extremo.
 * 
 * Los ejes y criterios se generan dinámicamente desde el JSON del caso —
 * el Mock también es ciego.
 */
function _generarMock(caso, payload) {
  const { rubrica_evaluacion, ejes_evaluacion, mapeo_ejes_criterios } = caso.aciertos_criticos;

  // Simulamos una nota mediocre-buena (alumno que se deja Sonia sin protocolo)
  const detallesCriterios = {};
  let notaBase = 0;

  for (const criterio of rubrica_evaluacion.criterios) {
    // Simulación: el alumno obtiene entre el 60% y el 85% en cada criterio
    const pct = criterio.id === 'triangulacion' ? 0.80 :
                criterio.id === 'modelos_teoricos' ? 0.65 :
                criterio.id === 'hipotesis' ? 0.75 :
                criterio.id === 'plan_accion' ? 0.60 :
                criterio.id === 'argumentacion' ? 0.70 : 0.70;

    const puntuacion = Math.round(criterio.peso * pct);
    detallesCriterios[criterio.id] = {
      puntuacion,
      max: criterio.peso,
      observacion: `[MOCK] Nivel ${Math.round(pct * 100)}%. Criterio "${criterio.nombre}" evaluado en modo simulación.`,
    };
    notaBase += puntuacion;
  }

  // Knockout Sonia: simulamos que el alumno la ignoró
  const knockoutsAplicados = [
    {
      id: 'senyal_sonia',
      penalizacion: 15,
      motivo: '[MOCK] El alumno no ha abierto protocolo de investigación para la situación de Sonia Peralta.',
    },
  ];
  const notaGlobal = Math.max(0, notaBase - 15);

  // Vector de ejes generado desde el JSON
  const vectorEjes = ejes_evaluacion.map(eje => {
    const criteriosDelEje = mapeo_ejes_criterios[eje] || [];
    const maxEje = rubrica_evaluacion.criterios
      .filter(c => criteriosDelEje.includes(c.id))
      .reduce((s, c) => s + c.peso, 0);
    const puntuacionEje = criteriosDelEje.reduce((s, cId) => {
      return s + (detallesCriterios[cId]?.puntuacion || 0);
    }, 0);
    return { eje, puntuacion: puntuacionEje, max: maxEje };
  });

  const nota_asesoramiento_docente =
    `[MODO MOCK — Respuesta simulada para validar el circuito Motor-Backend]\n\n` +
    `Alumno: ${payload.alumno.nombre} | Grupo: ${payload.alumno.grupo || 'N/A'}\n` +
    `Nota automática simulada: ${notaGlobal}/100 (base ${notaBase} − 15 knockout Sonia)\n\n` +
    `PUNTOS FUERTES (simulados): Triangulación aceptable con 2-3 fuentes por factor. ` +
    `Karasek aplicado con las dimensiones demanda/control. Hipótesis organizacional, no individual.\n\n` +
    `PUNTOS DÉBILES (simulados): Siegrist infrautilizado — Ana es el caso canónico de ERI y el alumno no lo desarrolla. ` +
    `Plan de acción con indicadores incompletos (falta responsable en 2 medidas). ` +
    `CRÍTICO: Sonia Peralta no recibe protocolo de investigación — knockout activado (−15 pts).\n\n` +
    `PARA LA CORRECCIÓN MANUAL (40%): Revisa si el alumno distingue entre hipótesis organizacional e individual. ` +
    `El plan de acción necesita revisión manual del componente Rigor Operativo.`;

  return {
    nota_global: notaGlobal,
    vector_ejes: vectorEjes,
    detalle_criterios: detallesCriterios,
    knockouts_aplicados: knockoutsAplicados,
    nota_asesoramiento_docente,
    _mock: true, // flag interno; el motor lo puede mostrar en consola
  };
}

// ============================================================================
// SECCIÓN I — VALIDACIÓN DE LA RESPUESTA IA (espejo de _validarRespuestaIA del motor)
// ============================================================================

/**
 * El servidor valida antes de enviar, el motor valida al recibir.
 * Doble red de seguridad. Si esto falla en el servidor, el motor
 * nunca llega a procesar una respuesta rota.
 */
function _validarRespuestaIA(data, caso) {
  // Acepta nota_global o puntuacion_total como equivalentes funcionales.
  // Si llega puntuacion_total, lo normaliza a nota_global para mantener
  // compatibilidad con el motor cliente sin romper la estructura existente.
  if (typeof data?.puntuacion_total === 'number' && typeof data?.nota_global !== 'number') {
    data.nota_global = data.puntuacion_total;
  }
  if (typeof data?.nota_global !== 'number' || data.nota_global < 0 || data.nota_global > 100) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502, 'nota_global (o puntuacion_total) ausente o fuera del rango 0-100.');
  }

  if (!Array.isArray(data.vector_ejes)) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502, 'vector_ejes no es un array.');
  }

  const ejesEsperados = caso.aciertos_criticos.ejes_evaluacion;
  const ejesRecibidos = data.vector_ejes.map(e => e.eje);
  for (const eje of ejesEsperados) {
    if (!ejesRecibidos.includes(eje)) {
      throw _crearError('RESPUESTA_IA_INVALIDA', 502, `Falta el eje "${eje}" en vector_ejes.`);
    }
  }

  if (typeof data.nota_asesoramiento_docente !== 'string' || data.nota_asesoramiento_docente.trim().length < 10) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502, 'nota_asesoramiento_docente ausente o demasiado corta.');
  }
}

// ============================================================================
// SECCIÓN J — CORS
// ============================================================================

function _setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const esOrigenPermitido = CONFIG.cors_origins_permitidos.includes(origin)
    || process.env.DARABIA_ENV !== 'production'; // en dev/staging, cualquier origen

  res.setHeader('Access-Control-Allow-Origin', esOrigenPermitido ? origin : CONFIG.cors_origins_permitidos[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ============================================================================
// SECCIÓN K — MANEJO DE ERRORES
// ============================================================================

function _crearError(codigo, httpStatus, mensaje) {
  const err = new Error(mensaje);
  err.codigo = codigo;
  err.httpStatus = httpStatus;
  return err;
}

function _manejarError(res, err) {
  const esOperacional = !!err.codigo; // error que conocemos vs error inesperado

  const httpStatus = err.httpStatus || 500;
  const codigo = err.codigo || 'ERROR_INTERNO';
  const mensaje = esOperacional ? err.message : 'Error interno del servidor. Contacta con el administrador.';

  // En producción, no exponemos el stack de errores inesperados
  const detalle = process.env.DARABIA_ENV !== 'production' ? (err.stack || err.message) : undefined;

  console.error(`[EVALUAR] ERROR ${httpStatus} ${codigo}: ${err.message}`, detalle || '');

  return res.status(httpStatus).json({
    error: true,
    codigo,
    mensaje,
    ...(detalle && { detalle }),
  });
}

// ============================================================================
// SECCIÓN L — LOG DE AUDITORÍA (sin datos personales sensibles)
// ============================================================================

function _logAuditoria(payload, respuesta, esmock) {
  const log = {
    timestamp: new Date().toISOString(),
    caso_id: payload.caso_id,
    grupo: payload.alumno.grupo || 'N/A',
    // Nunca logueamos el nombre del alumno en producción
    alumno_hash: _hash(payload.alumno.nombre),
    nota_global: respuesta.nota_global,
    llaves_desbloqueadas: payload.llaves_desbloqueadas?.length || 0,
    modo: esmock ? 'MOCK' : 'REAL',
    motor: payload.version_motor,
    env: process.env.DARABIA_ENV || 'unknown',
  };
  console.log('[AUDIT]', JSON.stringify(log));
}

/** Hash simple (no criptográfico) para identificar al alumno sin revelar su nombre. */
function _hash(str) {
  if (!str) return '?';
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).toUpperCase();
}
