/**
 * ============================================================================
 * DARABIA ENGINE V5 — ENDPOINT SUBIDA PDF
 * api/subir-pdf.js · Vercel Serverless Function (Node.js 18+)
 * v1.0
 *
 * Autor: Honás Darabia (Jonás Agudo Osuna) · IES Virgen del Pilar, Zaragoza
 *
 * RESPONSABILIDAD ÚNICA:
 *   1. Recibir multipart/form-data con un PDF y metadatos del alumno.
 *   2. Extraer el texto del PDF en memoria (sin tocar disco).
 *   3. Limpiar artefactos típicos de extracción PDF.
 *   4. Construir el payload que evaluar.js espera y delegar la evaluación.
 *   5. Devolver al cliente la respuesta de evaluar.js sin mutarla.
 *
 * NO HACE:
 *   - No llama a Anthropic directamente. Eso es trabajo de evaluar.js.
 *   - No persiste el PDF. Vercel es efímero, el PDF vive solo en memoria.
 *   - No conoce la rúbrica del caso. Eso vive en el JSON del caso.
 *
 * DEPENDENCIAS NPM:
 *   - busboy (parser multipart, ~60KB, todo en memoria)
 *   - pdf-parse (extracción de texto desde Buffer)
 *
 * VARIABLES DE ENTORNO:
 *   Las mismas que usa evaluar.js. Este endpoint solo delega.
 * ============================================================================
 */

'use strict';

const Busboy = require('busboy');
const pdfParse = require('pdf-parse');
const evaluarHandler = require('./evaluar.js');

// ============================================================================
// CONFIGURACIÓN VERCEL — debe declararse en el módulo
// ============================================================================
//
// maxDuration: 60s   → el plan Hobby permite hasta 60s; suficiente para
//                       extracción (1-3s) + reintentos backoff (hasta 14s) +
//                       llamada Anthropic (15-40s).
// bodyParser: false  → necesario para que busboy reciba el stream crudo
//                       sin que Vercel lo parsee como JSON.
module.exports.config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

// ============================================================================
// CONSTANTES
// ============================================================================

const LIMITES = {
  max_pdf_bytes: 8 * 1024 * 1024,          // 8 MB (espejo del cliente)
  max_texto_bytes: 1 * 1024 * 1024,        // 1 MB de texto extraído (defensa)
  min_texto_chars: 800,                    // umbral PDF "vacío" / escaneado
  ratio_alfabetico_minimo: 0.5,            // 50% de chars alfabéticos esperados
  cors_origins_permitidos: [
    'https://darabia.vercel.app',
    'https://ies-virgen-pilar.aeducar.es',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ],
};

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================

module.exports = async function handler(req, res) {
  _setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return _error(res, 405, 'METHOD_NOT_ALLOWED', 'Solo se admite POST.');
  }

  try {
    // 1. Parsear multipart → { pdfBuffer, fields }
    const { pdfBuffer, fields, pdfFilename } = await _parsearMultipart(req);

    // 2. Validar que el PDF llegó y los campos mínimos están presentes
    _validarEntrada(pdfBuffer, fields, pdfFilename);

    // 3. Extraer texto del PDF
    const textoCrudo = await _extraerTextoPDF(pdfBuffer);

    // 4. Limpiar artefactos típicos de extracción PDF
    const textoLimpio = _limpiarTextoPDF(textoCrudo);

    // 5. Validar calidad del texto extraído
    _validarTextoExtraido(textoLimpio);

    // 6. Construir payload para evaluar.js
    const payloadEvaluacion = _construirPayloadEvaluacion(fields, textoLimpio, pdfFilename);

    // 7. Delegar en evaluar.js usando req/res falsos
    const respuestaEvaluacion = await _delegarAEvaluar(payloadEvaluacion, req);

    // 8. Devolver al cliente
    return res.status(200).json(respuestaEvaluacion);

  } catch (err) {
    return _manejarError(res, err);
  }
};

// ============================================================================
// PARSEO MULTIPART CON BUSBOY (todo en memoria, sin tocar disco)
// ============================================================================

function _parsearMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: LIMITES.max_pdf_bytes,
        files: 1,
        fields: 10,
      },
    });

    const fields = {};
    let pdfBuffer = null;
    let pdfFilename = null;
    let pdfTruncado = false;

    busboy.on('field', (nombre, valor) => {
      fields[nombre] = valor;
    });

    busboy.on('file', (nombreCampo, stream, info) => {
      if (nombreCampo !== 'pdf') {
        // Campo de archivo inesperado: drenar y descartar
        stream.resume();
        return;
      }
      pdfFilename = info.filename || 'sin_nombre.pdf';
      const trozos = [];

      stream.on('data', (chunk) => trozos.push(chunk));
      stream.on('limit', () => { pdfTruncado = true; });
      stream.on('end', () => {
        if (pdfTruncado) {
          // No reject aquí: dejamos que busboy.on('finish') resuelva y
          // _validarEntrada lance el error con código consistente.
          pdfBuffer = null;
          return;
        }
        pdfBuffer = Buffer.concat(trozos);
      });
    });

    busboy.on('error', (err) => reject(_crearError('MULTIPART_ERROR', 400, `Error al parsear multipart: ${err.message}`)));

    busboy.on('finish', () => {
      if (pdfTruncado) {
        return reject(_crearError('PDF_DEMASIADO_GRANDE', 413, `El PDF supera el límite de ${LIMITES.max_pdf_bytes / 1024 / 1024} MB.`));
      }
      resolve({ pdfBuffer, fields, pdfFilename });
    });

    req.pipe(busboy);
  });
}

// ============================================================================
// VALIDACIÓN DE ENTRADA
// ============================================================================

function _validarEntrada(pdfBuffer, fields, pdfFilename) {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw _crearError('PDF_AUSENTE', 400, 'No se ha recibido el archivo PDF en el campo "pdf".');
  }

  // Magic number de PDF: los 4 primeros bytes deben ser "%PDF"
  const magic = pdfBuffer.slice(0, 4).toString('ascii');
  if (magic !== '%PDF') {
    throw _crearError('PDF_INVALIDO', 400, 'El archivo recibido no es un PDF válido (cabecera incorrecta).');
  }

  const requeridos = ['nombre', 'caso_id', 'version_motor'];
  for (const campo of requeridos) {
    if (!fields[campo] || fields[campo].trim().length === 0) {
      throw _crearError('CAMPO_REQUERIDO', 400, `Campo de formulario requerido ausente: "${campo}".`);
    }
  }
}

// ============================================================================
// EXTRACCIÓN DE TEXTO DEL PDF
// ============================================================================

async function _extraerTextoPDF(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    return data.text || '';
  } catch (err) {
    throw _crearError('PDF_NO_EXTRAIBLE', 422, `No se ha podido extraer texto del PDF: ${err.message}`);
  }
}

// ============================================================================
// LIMPIEZA DE ARTEFACTOS DE EXTRACCIÓN PDF
// ============================================================================

/**
 * Limpia los tres artefactos más comunes que ensucian la entrada al prompt:
 *   1. Guiones de corte de línea: "gestio-\nnar" → "gestionar"
 *   2. Espacios y saltos múltiples → un solo espacio
 *   3. Ligaduras Unicode (ﬁ → fi, ﬂ → fl, etc.) vía normalización NFKC
 *
 * Esta limpieza determinista vive aquí en JS para no gastar tokens del prompt
 * pidiendo a Claude que la haga.
 */
function _limpiarTextoPDF(texto) {
  if (!texto) return '';
  return texto
    .replace(/-\n/g, '')          // unir palabras cortadas por guion
    .replace(/\s+/g, ' ')         // colapsar espacios y saltos múltiples
    .normalize('NFKC')            // normalizar ligaduras y compatibilidad
    .trim();
}

// ============================================================================
// VALIDACIÓN DE LA CALIDAD DEL TEXTO EXTRAÍDO
// ============================================================================

/**
 * Un PDF escaneado o corrupto puede pasar la extracción y devolver basura.
 * Aplicamos dos heurísticas baratas antes de gastar una llamada a Claude:
 *
 *   1. Longitud mínima: por debajo del umbral, el PDF está vacío o es imagen.
 *   2. Ratio alfabético: si <60% son letras/dígitos/puntuación normal,
 *      probable extracción rota (gibberish, encoding malo, etc.).
 *
 * El umbral está calibrado con el dictamen modelo del Caso 05:
 * un dictamen aceptable ronda los 4.000-8.000 caracteres limpios.
 */
function _validarTextoExtraido(texto) {
  if (texto.length < LIMITES.min_texto_chars) {
    throw _crearError(
      'PDF_VACIO',
      422,
      `El texto extraído del PDF tiene solo ${texto.length} caracteres (mínimo ${LIMITES.min_texto_chars}). ¿Es un PDF escaneado o de imágenes?`
    );
  }

  if (texto.length > LIMITES.max_texto_bytes) {
    throw _crearError(
      'TEXTO_DEMASIADO_LARGO',
      413,
      `El texto extraído supera el límite razonable (${(texto.length / 1024).toFixed(0)} KB).`
    );
  }

  // Ratio de caracteres "razonables" (letras, dígitos, espacios, puntuación común)
  const charsLegibles = (texto.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ0-9\s.,;:¿?¡!()\-—«»"'%/€]/g) || []).length;
  const ratio = charsLegibles / texto.length;

  if (ratio < LIMITES.ratio_alfabetico_minimo) {
    throw _crearError(
      'PDF_GIBBERISH',
      422,
      `El texto extraído contiene demasiados caracteres no legibles (ratio ${(ratio * 100).toFixed(0)}%). Posible PDF corrupto o con encoding incompatible.`
    );
  }
}

// ============================================================================
// CONSTRUCCIÓN DEL PAYLOAD PARA evaluar.js
// ============================================================================

/**
 * Construye el shape exacto que evaluar.js espera.
 * Referencia: api/evaluar.js sección D (_validarPayload).
 */
function _construirPayloadEvaluacion(fields, textoLimpio, pdfFilename) {
  return {
    caso_id: fields.caso_id,
    version_motor: fields.version_motor,
    timestamp_envio: new Date().toISOString(),
    alumno: {
      nombre: fields.nombre.trim(),
      grupo: (fields.grupo || 'sin grupo').trim(),
      validado: true,
    },
    dictamen: {
      texto_completo: textoLimpio,
      origen: 'pdf_subido',
      pdf_filename: pdfFilename,
    },
    llaves_desbloqueadas: [], // No aplica en flujo de subida PDF
  };
}

// ============================================================================
// DELEGACIÓN A evaluar.js (req/res falsos)
// ============================================================================

/**
 * Llama al handler de evaluar.js como una función, sin pasar por HTTP.
 * Construimos un req mínimo con los campos que evaluar.js consume y un res
 * falso que captura status + body en lugar de escribir a la red.
 *
 * Si evaluar.js cambia su contrato interno, este shim falla en el primer
 * test. Es deuda técnica controlada: la alternativa (refactorizar evaluar.js
 * para exportar una función pura) está fuera de alcance esta fase.
 */
async function _delegarAEvaluar(payload, reqOriginal) {
  return new Promise((resolve, reject) => {
    let statusCapturado = 200;
    let bodyCapturado = null;
    let resuelto = false;

    const reqFalso = {
      method: 'POST',
      headers: reqOriginal.headers,
      body: payload,
    };

    const resFalso = {
      setHeader: () => {},
      status(code) {
        statusCapturado = code;
        return this;
      },
      json(data) {
        bodyCapturado = data;
        if (resuelto) return this;
        resuelto = true;
        if (statusCapturado >= 200 && statusCapturado < 300) {
          resolve(data);
        } else {
          // evaluar.js devolvió error operacional con su propio shape
          const err = _crearError(
            data?.codigo || 'EVALUAR_ERROR',
            statusCapturado,
            data?.mensaje || 'evaluar.js devolvió un error sin mensaje.'
          );
          reject(err);
        }
        return this;
      },
      end() {
        if (resuelto) return this;
        resuelto = true;
        resolve(bodyCapturado);
        return this;
      },
    };

    Promise.resolve(evaluarHandler(reqFalso, resFalso))
      .catch((err) => {
        if (resuelto) return;
        resuelto = true;
        reject(err);
      });
  });
}

// ============================================================================
// CORS
// ============================================================================

function _setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const esOrigenPermitido = LIMITES.cors_origins_permitidos.includes(origin)
    || process.env.DARABIA_ENV !== 'production';

  res.setHeader('Access-Control-Allow-Origin', esOrigenPermitido ? origin : LIMITES.cors_origins_permitidos[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ============================================================================
// MANEJO DE ERRORES
// ============================================================================

function _crearError(codigo, httpStatus, mensaje) {
  const err = new Error(mensaje);
  err.codigo = codigo;
  err.httpStatus = httpStatus;
  return err;
}

function _error(res, httpStatus, codigo, mensaje) {
  return res.status(httpStatus).json({ error: true, codigo, mensaje });
}

function _manejarError(res, err) {
  const httpStatus = err.httpStatus || 500;
  const codigo = err.codigo || 'ERROR_INTERNO';
  const mensaje = err.codigo
    ? err.message
    : 'Error interno del servidor. Contacta con el administrador.';

  const detalle = process.env.DARABIA_ENV !== 'production'
    ? (err.stack || err.message)
    : undefined;

  console.error(`[SUBIR-PDF] ERROR ${httpStatus} ${codigo}: ${err.message}`, detalle || '');

  return res.status(httpStatus).json({
    error: true,
    codigo,
    mensaje,
    ...(detalle && { detalle }),
  });
}
