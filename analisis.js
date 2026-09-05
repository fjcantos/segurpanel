// analisis.js
//
// Motor de analisis de contratos para la pestana "Analisis":
//   1. Extraccion de texto desde PDF, Word (.doc/.docx), OpenDocument (.odt),
//      texto plano (.txt) y JPG/PNG (OCR).
//   2. Anonimizacion de datos sensibles (nombres, DNI/NIE/NIF/CIF, direcciones,
//      telefonos, emails, datos bancarios, nombres de empresa).
//   3. Deteccion y puntuacion (1-10) de clausulas de riesgo habituales en
//      contratos de alarmas (permanencia, penalizacion, renovacion automatica,
//      subida de precio, etc.).
//   4. Analisis legal avanzado clausula por clausula con la API de Anthropic
//      (Claude actuando como abogado experto en contratos de seguridad
//      privada y derecho del consumidor español).
//   5. Generacion de informes PDF con la plantilla corporativa de UIC (basico
//      y avanzado).
//
// Todo el procesado ocurre en el servidor: el archivo original nunca se
// reenvia al navegador ni se incrusta en el informe, asi que ni los datos
// anonimizados ni los logos de terceros que pudiera contener el documento
// original llegan a formar parte del PDF generado.

const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const sharp = require("sharp");
const tesseractOcr = require("node-tesseract-ocr");
const PDFDocument = require("pdfkit");
const WordExtractor = require("word-extractor");
const JSZip = require("jszip");

const LOGO_PATH = path.join(__dirname, "assets", "LOGO_UIC_limpio.png");

const ROJO = "#CC0000";
const ROJO_OSCURO = "#7a0000";
const NEGRO = "#1a1a1a";
const GRIS = "#555555";
const GRIS_CLARO = "#f2f2f2";
const BORDE = "#dddddd";

/* ================================================================
   1. Extraccion de texto por tipo de archivo
   ================================================================ */

const MIME_PDF = "application/pdf";
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_DOC = "application/msword";
const MIME_ODT = "application/vnd.oasis.opendocument.text";
const MIME_TXT = "text/plain";
const MIMES_IMAGEN = new Set(["image/jpeg", "image/png"]);

// node-tesseract-ocr invoca el binario "tesseract" del sistema operativo en
// lugar de cargar el WASM de tesseract.js en memoria (que hacia fallar el
// deploy en Render por consumo excesivo de RAM). Si ese binario no esta
// instalado en el servidor (p.ej. en el plan gratuito de Render, que no
// permite instalar paquetes del sistema), se lanza OcrNoDisponibleError con
// un mensaje claro para el usuario.
class OcrNoDisponibleError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "OcrNoDisponibleError";
    this.ocrNoDisponible = true;
  }
}

const OCR_CONFIG = { lang: "spa", oem: 1, psm: 3 };

function esErrorBinarioTesseractAusente(err) {
  const mensaje = String((err && err.message) || "");
  return (
    err &&
    (err.code === 127 ||
      err.code === "ENOENT" ||
      /not found|no se reconoce|no encontrado|command not found/i.test(mensaje))
  );
}

async function extraerTextoImagen(buffer) {
  // Preprocesado ligero con sharp (escala de grises, normalizado de
  // contraste y nitidez, limite de resolucion) para mejorar la precision del
  // OCR y mantener bajo el consumo de memoria/CPU en el servidor.
  const imagenProcesada = await sharp(buffer)
    .rotate()
    .resize({ width: 2000, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  try {
    const texto = await tesseractOcr.recognize(imagenProcesada, OCR_CONFIG);
    return texto || "";
  } catch (err) {
    if (esErrorBinarioTesseractAusente(err)) {
      throw new OcrNoDisponibleError(
        "El reconocimiento de texto en imágenes (OCR) no está disponible en este servidor. " +
          "Sube el contrato en PDF o Word (.docx): esos formatos sí funcionan correctamente en la nube."
      );
    }
    throw err;
  }
}

// El texto de un .odt vive en content.xml dentro del zip, marcado con
// elementos de OpenDocument (text:p, text:h, ...). Se insertan saltos de
// linea en los limites de parrafo/salto antes de quitar las etiquetas, para
// no perder la estructura del documento.
async function extraerTextoOdt(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const archivoContenido = zip.file("content.xml");
  if (!archivoContenido) {
    throw new Error("El archivo .odt no contiene content.xml: puede estar dañado o no ser un OpenDocument válido.");
  }
  const xml = await archivoContenido.async("string");
  const conSaltos = xml
    .replace(/<text:p\b[^>]*>/g, "\n")
    .replace(/<text:h\b[^>]*>/g, "\n")
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n");
  const sinEtiquetas = conSaltos.replace(/<[^>]+>/g, "");
  return sinEtiquetas
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

async function extraerTexto(buffer, mimetype, nombreArchivo) {
  const ext = path.extname(nombreArchivo || "").toLowerCase();

  if (mimetype === MIME_PDF || ext === ".pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const resultado = await parser.getText();
      return resultado.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (mimetype === MIME_DOCX || ext === ".docx") {
    const resultado = await mammoth.extractRawText({ buffer });
    return resultado.value || "";
  }

  if (mimetype === MIME_DOC || ext === ".doc") {
    const extractor = new WordExtractor();
    const documento = await extractor.extract(buffer);
    return documento.getBody() || "";
  }

  if (mimetype === MIME_ODT || ext === ".odt") {
    return await extraerTextoOdt(buffer);
  }

  if (mimetype === MIME_TXT || ext === ".txt") {
    return buffer.toString("utf-8");
  }

  if (MIMES_IMAGEN.has(mimetype) || ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    return await extraerTextoImagen(buffer);
  }

  throw new Error(
    "Formato de archivo no soportado. Sube un PDF, un Word (.doc/.docx), un OpenDocument (.odt), texto plano (.txt) o una imagen JPG/PNG."
  );
}

/* ================================================================
   2. Anonimizacion de datos sensibles
   ================================================================ */

// Nombres de companias del sector que pueden aparecer identificando al
// cliente o al proveedor del contrato analizado.
const EMPRESAS_CONOCIDAS = [
  "Verisure", "Sector Alarm", "Sicor", "Segurma", "ADT", "Seguridad 3D",
  "Grupo Control", "Trablisa", "MPA", "Prosegur",
];

const REGLAS_ANONIMIZACION = [
  // Email
  { id: "email", etiqueta: "[EMAIL]", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // IBAN / cuenta bancaria (ES + 2 digitos de control + 20 digitos, con o sin espacios)
  { id: "iban", etiqueta: "[IBAN]", re: /\b[A-Z]{2}\d{2}(?:[ -]?\d{4}){4,5}\b/g },
  // NIE: letra X/Y/Z + 7 digitos + letra
  { id: "nie", etiqueta: "[NIE]", re: /\b[XYZxyz]\d{7}[A-Za-z]\b/g },
  // CIF: letra + 7 digitos + digito/letra de control
  { id: "cif", etiqueta: "[CIF]", re: /\b[A-HJNPQSUVWabhjnpqsuvw]\d{7}[0-9A-Ja-j]\b/g },
  // DNI/NIF: 8 digitos + letra
  { id: "dni", etiqueta: "[DNI/NIF]", re: /\b\d{8}[A-Za-z]\b/g },
  // Telefono espanol (fijo o movil, con o sin prefijo +34)
  { id: "telefono", etiqueta: "[TELÉFONO]", re: /(?:(?:\+|00)34[ .-]?)?\b[6789]\d{2}(?:[ .-]?\d{3}){2}\b/g },
  // Direcciones postales habituales en contratos
  {
    id: "direccion",
    etiqueta: "[DIRECCIÓN]",
    re: /\b(?:Calle|C\/|Avda\.?|Avenida|Plaza|Pza\.?|Paseo|Pº\.?|Polígono|Poligono|Camino|Urbanización|Urbanizacion|Vía|Via|Ronda|Travesía|Travesia|Glorieta|Bloque)\s+[^\n,;]{3,60}/gi,
  },
  // Piso/puerta/planta (p.ej. "3º B", "Piso 2, Puerta 4") que suelen acompañar
  // a una direccion ya anonimizada por la regla anterior.
  {
    id: "piso_puerta",
    etiqueta: "[PISO/PUERTA]",
    re: /\b(?:Piso|Puerta|Planta|Escalera|Portal)\s*[:.\-]?\s*[0-9A-Za-zºª]{1,4}\b/gi,
  },
  // Codigo postal + poblacion (p.ej. "28045 Madrid")
  { id: "cp", etiqueta: "[CÓDIGO POSTAL]", re: /\b\d{5}\b(?=\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g },
  // Numero de cliente/abonado/poliza/contrato (identificador interno que
  // permite rastrear a la persona aunque el nombre ya se haya anonimizado)
  {
    id: "referencia",
    etiqueta: "[REF]",
    re: /(?:N[uú]mero|N[ºo]\.?)\s+de\s+(?:cliente|abonado|p[oó]liza|contrato|expediente|instalaci[oó]n)(\s*:?\s*)([A-Za-z0-9/\-]{3,20})/gi,
    grupoReemplazo: 2,
  },
  // Nombres de persona tras etiquetas habituales de contrato. Admite
  // apellidos compuestos con conectores en minuscula ("de", "del", "la"...).
  {
    id: "nombre",
    etiqueta: "[NOMBRE]",
    re: /(?:D\.|Dña\.|Don|Doña|Sr\.|Sra\.|Nombre y apellidos|Nombre del cliente|Nombre del titular|Nombre del contratante|Titular|Abonado|Asegurado|Contratante|Suscriptor|Representante legal|Representado por|En representaci[oó]n de|Firmado por|Apellidos y nombre|Cliente)(\s*:?\s*)([A-ZÁÉÍÓÚÑ][a-zÀ-ÿ]+(?:\s+(?:de|del|de la|de los|de las|la|las|los|y)\s+[A-ZÁÉÍÓÚÑ][a-zÀ-ÿ]+|\s+[A-ZÁÉÍÓÚÑ][a-zÀ-ÿ]+){1,4})/g,
    grupoReemplazo: 2,
  },
  // Razon social generica ("... S.L.", "... S.A.", "... S.L.U.", "... S.C.")
  // que no sea una de las empresas de alarmas ya cubiertas por
  // EMPRESAS_CONOCIDAS (p.ej. el negocio del propio cliente, o un
  // subcontratista).
  {
    id: "empresa",
    etiqueta: "[EMPRESA]",
    re: /\b[A-ZÁÉÍÓÚÑ][\wÀ-ÿ&.,'\- ]{1,60}?,?\s+S\.?\s?(?:L\.?U?\.?|A\.?U?\.?|C\.?|COOP\.?)\b/g,
  },
];

// La empresa de seguridad/alarmas contratante recibe una etiqueta propia,
// distinta de [EMPRESA] (razon social generica de terceros), para que quede
// igual de anonima pero identificable como "la empresa de seguridad" en el
// informe sin revelar cual es.
const ETIQUETA_EMPRESA_SEGURIDAD = "[EMPRESA_SEGURIDAD]";

function anonimizarTexto(texto) {
  let resultado = texto;
  const conteos = {};

  // Las empresas de alarmas conocidas se sustituyen ANTES que la regla
  // generica de razon social ("... S.L./S.A."), para que su [EMPRESA_SEGURIDAD]
  // no acabe pisada por la etiqueta generica [EMPRESA] si el nombre tambien
  // termina en "S.L."/"S.A." (p.ej. "Sector Alarm España S.L.U.").
  EMPRESAS_CONOCIDAS.forEach((nombreEmpresa) => {
    // Admite hasta 2 palabras con mayuscula inicial entre el nombre conocido
    // y el sufijo de forma societaria (p.ej. "Sector Alarm España, S.L.U."),
    // para no dejar ese sufijo suelto a merced de la regla generica [EMPRESA].
    const re = new RegExp(
      "\\b" +
        nombreEmpresa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\b(?:(?:\\s+[A-ZÁÉÍÓÚÑ][\\wÀ-ÿ]*){0,2}[\\s,]+S\\.?\\s?(?:L\\.?U?\\.?|A\\.?U?\\.?|C\\.?|COOP\\.?)\\.?)?",
      "gi"
    );
    let n = 0;
    resultado = resultado.replace(re, () => {
      n++;
      return ETIQUETA_EMPRESA_SEGURIDAD;
    });
    if (n > 0) conteos.empresaSeguridad = (conteos.empresaSeguridad || 0) + n;
  });

  REGLAS_ANONIMIZACION.forEach((regla) => {
    let n = 0;
    resultado = resultado.replace(regla.re, (...args) => {
      n++;
      if (regla.grupoReemplazo) {
        // Sustituye solo el grupo capturado (p.ej. el nombre tras "Titular:")
        // y conserva la etiqueta que precede al dato.
        const grupo = args[regla.grupoReemplazo];
        return args[0].replace(grupo, regla.etiqueta);
      }
      return regla.etiqueta;
    });
    if (n > 0) conteos[regla.id] = n;
  });

  const totalAnonimizado = Object.values(conteos).reduce((s, v) => s + v, 0);
  return { texto: resultado, conteos, total: totalAnonimizado };
}

// Segunda pasada de anonimizacion, pensada para el TEXTO YA GENERADO por la
// IA en el analisis avanzado (resumenGeneral y cada campo de cada clausula):
// aunque la IA solo recibe texto ya anonimizado como entrada, esta pasada
// actua como red de seguridad por si reformulase o reintrodujese algun dato
// que la primera pasada no hubiera cubierto, para que el informe final sea
// siempre 100% anonimo.
function anonimizarResumenIA(resumen) {
  const limpiar = (valor) => (typeof valor === "string" ? anonimizarTexto(valor).texto : valor);
  return {
    ...resumen,
    resumenGeneral: limpiar(resumen.resumenGeneral),
    clausulas: (resumen.clausulas || []).map((c) => ({
      ...c,
      titulo: limpiar(c.titulo),
      explicacion: limpiar(c.explicacion),
      baseLegal: limpiar(c.baseLegal),
    })),
  };
}

/* ================================================================
   2b. Extraccion de provincia y empresa (para estadisticas internas)
   ================================================================ */
//
// Se ejecuta sobre el texto ORIGINAL, antes de anonimizar, porque el codigo
// postal y el nombre de la empresa son precisamente los patrones que
// anonimizarTexto() sustituye por [CÓDIGO POSTAL]/[EMPRESA]. El resultado
// (solo provincia + empresa, sin ningun dato personal) es lo unico que se
// guarda en la base de datos para la pestana Estadisticas.

// Prefijo de codigo postal (dos primeros digitos) -> provincia. Los nombres
// coinciden exactamente con los `data-provincia` del SVG de España (mismo
// dataset amCharts) para poder cruzar ambos sin tabla de conversion aparte.
const CP_PROVINCIA = {
  "01": "Araba/Álava", "02": "Albacete", "03": "Alicante", "04": "Almería",
  "05": "Ávila", "06": "Badajoz", "07": "Baleares", "08": "Barcelona",
  "09": "Burgos", "10": "Cáceres", "11": "Cádiz", "12": "Castellón",
  "13": "Ciudad Real", "14": "Córdoba", "15": "A Coruña", "16": "Cuenca",
  "17": "Girona", "18": "Granada", "19": "Guadalajara", "20": "Gipuzkoa",
  "21": "Huelva", "22": "Huesca", "23": "Jaén", "24": "León",
  "25": "Lleida", "26": "La Rioja", "27": "Lugo", "28": "Madrid",
  "29": "Málaga", "30": "Murcia", "31": "Navarra", "32": "Ourense",
  "33": "Asturias", "34": "Palencia", "35": "Las Palmas", "36": "Pontevedra",
  "37": "Salamanca", "38": "Santa Cruz de Tenerife", "39": "Cantabria",
  "40": "Segovia", "41": "Sevilla", "42": "Soria", "43": "Tarragona",
  "44": "Teruel", "45": "Toledo", "46": "Valencia", "47": "Valladolid",
  "48": "Bizkaia", "49": "Zamora", "50": "Zaragoza", "51": "Ceuta", "52": "Melilla",
};

// Claves de empresa tal como se usan en el resto de la app (COLORES_EMPRESA
// en index.html): MPA y Prosegur son la misma compañía a efectos de color,
// asi que ambas se normalizan a "MPA/Prosegur".
function normalizarEmpresaDetectada(nombre) {
  if (nombre === "MPA" || nombre === "Prosegur") return "MPA/Prosegur";
  return nombre;
}

function extraerProvincia(textoOriginal) {
  const conteo = {};
  const re = /\b(\d{5})\b/g;
  let m;
  while ((m = re.exec(textoOriginal))) {
    const provincia = CP_PROVINCIA[m[1].slice(0, 2)];
    if (provincia) conteo[provincia] = (conteo[provincia] || 0) + 1;
  }
  let mejor = null;
  let max = 0;
  for (const [provincia, n] of Object.entries(conteo)) {
    if (n > max) {
      max = n;
      mejor = provincia;
    }
  }
  return mejor;
}

function extraerEmpresaDominante(textoOriginal) {
  const conteo = {};
  EMPRESAS_CONOCIDAS.forEach((nombre) => {
    const re = new RegExp("\\b" + nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    const coincidencias = textoOriginal.match(re);
    if (coincidencias) conteo[nombre] = (conteo[nombre] || 0) + coincidencias.length;
  });
  let mejor = null;
  let max = 0;
  for (const [nombre, n] of Object.entries(conteo)) {
    if (n > max) {
      max = n;
      mejor = nombre;
    }
  }
  return normalizarEmpresaDetectada(mejor);
}

// Punto de entrada unico usado por server.js: se llama con el texto
// original justo despues de extraerTexto() y antes de anonimizarTexto().
function extraerProvinciaYEmpresa(textoOriginal) {
  return {
    provincia: extraerProvincia(textoOriginal),
    empresa: extraerEmpresaDominante(textoOriginal),
  };
}

/* ================================================================
   3. Deteccion y puntuacion de clausulas de riesgo
   ================================================================ */

const REGLAS_CLAUSULAS = [
  {
    id: "penalizacion",
    label: "Penalización por baja anticipada",
    re: /penalizaci[oó]n|indemnizaci[oó]n por baja|coste de cancelaci[oó]n anticipada/i,
    score: 9,
    descripcion: "Impone una compensación económica al cliente si cancela el contrato antes de finalizar el período pactado.",
  },
  {
    id: "renovacion",
    label: "Renovación automática",
    re: /renovaci[oó]n autom[aá]tica|pr[oó]rroga t[aá]cita/i,
    score: 7,
    descripcion: "El contrato se renueva por sí solo si no se comunica la baja con antelación, alargando la permanencia sin un nuevo consentimiento expreso.",
  },
  {
    id: "permanencia",
    label: "Cláusula de permanencia",
    re: /permanencia|per[ií]odo m[ií]nimo de contrataci[oó]n|per[ií]odo m[ií]nimo/i,
    score: 6,
    descripcion: "Obliga a mantener el contrato activo durante un período mínimo antes de poder darse de baja sin penalización.",
  },
  {
    id: "cesion_datos",
    label: "Cesión de datos a terceros",
    re: /cesi[oó]n de datos|comunicaci[oó]n de datos a terceros|finalidad comercial/i,
    score: 6,
    descripcion: "Contempla compartir los datos del cliente con terceros; conviene revisar que cumple el RGPD y la LOPDGDD.",
  },
  {
    id: "subida_precio",
    label: "Revisión / subida de precio",
    re: /subida de precio|revisi[oó]n de tarifa|actualizaci[oó]n anual del precio|incremento del precio|vinculad[oa] al IPC/i,
    score: 5,
    descripcion: "Permite incrementar la cuota periódicamente (a menudo ligado al IPC) sin necesidad de una nueva negociación con el cliente.",
  },
  {
    id: "exclusividad",
    label: "Exclusividad de mantenimiento",
    re: /exclusividad|mantenimiento obligatorio con la empresa/i,
    score: 4,
    descripcion: "Obliga a contratar el mantenimiento en exclusiva con el proveedor, limitando la libre elección de otro servicio técnico.",
  },
  {
    id: "preaviso",
    label: "Plazo de preaviso para cancelar",
    re: /preaviso/i,
    score: 4,
    descripcion: "Exige comunicar la baja con una antelación mínima; si no se respeta el plazo, el contrato puede prorrogarse igualmente.",
  },
  {
    id: "titularidad_equipo",
    label: "Titularidad del equipo",
    re: /propiedad del equipo|cesi[oó]n de uso del equipo|en r[eé]gimen de comodato/i,
    score: 3,
    descripcion: "Aclara si el equipo instalado es propiedad del cliente o de la empresa, lo que afecta a la baja y a la retirada del material.",
  },
];

function detectarClausulas(textoAnonimizado) {
  const encontradas = [];

  REGLAS_CLAUSULAS.forEach((regla) => {
    const coincidencia = textoAnonimizado.match(regla.re);
    if (!coincidencia) return;
    const idx = coincidencia.index;
    const inicio = Math.max(0, idx - 60);
    const fin = Math.min(textoAnonimizado.length, idx + coincidencia[0].length + 60);
    const fragmento =
      (inicio > 0 ? "…" : "") +
      textoAnonimizado.slice(inicio, fin).replace(/\s+/g, " ").trim() +
      (fin < textoAnonimizado.length ? "…" : "");

    encontradas.push({
      id: regla.id,
      label: regla.label,
      score: regla.score,
      descripcion: regla.descripcion,
      fragmento,
    });
  });

  encontradas.sort((a, b) => b.score - a.score);

  let puntuacionGlobal;
  if (encontradas.length === 0) {
    puntuacionGlobal = 1;
  } else {
    const media = encontradas.reduce((s, c) => s + c.score, 0) / encontradas.length;
    const maxima = Math.max(...encontradas.map((c) => c.score));
    puntuacionGlobal = Math.min(10, Math.max(1, Math.round(media * 0.6 + maxima * 0.4)));
  }

  let nivel;
  if (puntuacionGlobal <= 3) nivel = "Bajo";
  else if (puntuacionGlobal <= 6) nivel = "Medio";
  else if (puntuacionGlobal <= 8) nivel = "Alto";
  else nivel = "Muy alto";

  return { clausulas: encontradas, puntuacionGlobal, nivel };
}

/* ================================================================
   4. Analisis legal avanzado con la API de Anthropic
   ================================================================ */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODELO_ANALISIS_AVANZADO = "claude-opus-5";
const MAX_TOKENS_ANALISIS_AVANZADO = 16000;
// Limite prudente de caracteres reenviados al modelo: evita contratos
// desproporcionados (escaneos con mucho ruido OCR) y mantiene la peticion
// dentro de un tiempo de respuesta razonable para el usuario.
const MAX_CARACTERES_ANALISIS_AVANZADO = 60000;

const SYSTEM_PROMPT_ANALISIS_LEGAL = `Eres un abogado especializado en contratos de seguridad privada, con 15 años de experiencia, y experto en derecho del consumidor español. Tu misión es analizar contratos de alarmas y seguridad para proteger a personas consumidoras, muchas de ellas mayores y sin ninguna formación jurídica.

Basas tu análisis exclusivamente en la legislación española vigente:
- Ley 5/2014, de 4 de abril, de Seguridad Privada.
- Real Decreto Legislativo 1/2007 (Ley General para la Defensa de los Consumidores y Usuarios, LGDCU).
- Ley 7/1998, sobre Condiciones Generales de la Contratación (LCGC).
- Código Civil español.
- Reglamento (UE) 2016/679 (RGPD) y Ley Orgánica 3/2018 (LOPDGDD).

Analiza el contrato cláusula por cláusula. Para cada cláusula relevante que identifiques:
- Numérala tal como aparece en el documento original (si no tiene numeración propia, asígnale un número correlativo).
- Ponle un título muy simple y descriptivo (máximo 8 palabras).
- Explícala en un lenguaje MUY sencillo, como si hablases con una persona mayor sin ningún conocimiento legal: frases cortas, sin tecnicismos ni jerga jurídica, yendo directa al grano de lo que significa para ella.
- Indica la base legal española aplicable de forma concreta (ley y, si es posible, artículo). Nunca inventes un artículo o una ley que no exista: si no estás seguro del número exacto, cita solo la ley general aplicable.
- Asigna un nivel de riesgo para la persona consumidora: "bajo", "medio", "alto" o "muy_alto", según cuánto pueda perjudicarle esa cláusula.

Tu tono es siempre profesional, íntegro y protector de los intereses de la persona consumidora. Sé preciso y justo: no exageres los riesgos ni los minimices. Si una cláusula es habitual y no supone un riesgo relevante, dilo también con claridad y márcala como riesgo "bajo".

Además del detalle por cláusula, entrega una valoración global del contrato (puntuación de 1 a 10, donde 10 es el riesgo más alto para la persona consumidora) y un resumen general breve en el mismo lenguaje sencillo.

ANONIMATO ABSOLUTO (regla innegociable): el texto que recibes ya ha sido anonimizado automáticamente y contiene marcadores como [NOMBRE], [DNI/NIF], [DIRECCIÓN], [TELÉFONO], [EMAIL], [IBAN], [EMPRESA_SEGURIDAD], etc. en lugar de los datos reales.
- Nunca intentes adivinar, inferir o reconstruir el dato real oculto tras un marcador (nombre, empresa, dirección, DNI...). Si necesitas referirte a él, usa el propio marcador o una descripción genérica (p.ej. "la empresa de seguridad", "la persona titular").
- Si por cualquier motivo detectas en el texto un nombre propio, una razón social, un teléfono, un email, un DNI/NIE/CIF, una dirección o cualquier otro dato que permita identificar a una persona o empresa concreta y que NO esté ya anonimizado, no lo repitas literalmente en tu respuesta: sustitúyelo tú mismo por el marcador genérico que corresponda.
- En ningún campo de tu respuesta (resumen, título, explicación o base legal) debe aparecer un nombre propio de persona, una razón social real, una dirección, un teléfono, un email, un DNI/NIE/CIF ni ningún otro dato identificativo. El informe final debe ser 100% anónimo.`;

const ESQUEMA_ANALISIS_LEGAL = {
  type: "object",
  properties: {
    resumenGeneral: {
      type: "string",
      description: "Resumen general del contrato en lenguaje muy sencillo, 2-4 frases, dirigido a una persona sin conocimientos legales.",
    },
    puntuacionGlobal: {
      type: "integer",
      description: "Puntuación global de riesgo para la persona consumidora, en una escala del 1 (mínimo) al 10 (máximo). Nunca uses un valor fuera de ese rango.",
    },
    nivelGlobal: { type: "string", enum: ["bajo", "medio", "alto", "muy_alto"] },
    clausulas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          numero: { type: "string", description: "Número o referencia de la cláusula tal como aparece en el contrato." },
          titulo: { type: "string", description: "Título simple y descriptivo, máximo 8 palabras." },
          explicacion: { type: "string", description: "Explicación en lenguaje muy sencillo, 2-5 frases." },
          baseLegal: { type: "string", description: "Ley y, si es posible, artículo español aplicable." },
          riesgo: { type: "string", enum: ["bajo", "medio", "alto", "muy_alto"] },
        },
        required: ["numero", "titulo", "explicacion", "baseLegal", "riesgo"],
        additionalProperties: false,
      },
    },
  },
  required: ["resumenGeneral", "puntuacionGlobal", "nivelGlobal", "clausulas"],
  additionalProperties: false,
};

class AnalisisAvanzadoError extends Error {}

// Envia el texto (ya anonimizado) a la API de Anthropic para que Claude,
// actuando como abogado experto, analice el contrato clausula por clausula.
// La respuesta viene forzada a un JSON Schema (output_config.format), por lo
// que el primer bloque de texto de la respuesta es JSON valido garantizado.
async function analizarConIA(textoAnonimizado) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnalisisAvanzadoError("El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.");
  }

  const textoRecortado = textoAnonimizado.slice(0, MAX_CARACTERES_ANALISIS_AVANZADO);

  const respuesta = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO_ANALISIS_AVANZADO,
      max_tokens: MAX_TOKENS_ANALISIS_AVANZADO,
      system: SYSTEM_PROMPT_ANALISIS_LEGAL,
      messages: [
        {
          role: "user",
          content: `Analiza el siguiente contrato de seguridad/alarmas cláusula por cláusula:\n\n${textoRecortado}`,
        },
      ],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: ESQUEMA_ANALISIS_LEGAL },
      },
    }),
  });

  const datos = await respuesta.json();

  if (!respuesta.ok) {
    const mensajeError =
      (datos && datos.error && datos.error.message) || `Error ${respuesta.status} al llamar a la API de Anthropic.`;
    throw new AnalisisAvanzadoError(mensajeError);
  }

  const bloqueTexto = (datos.content || []).find((b) => b.type === "text");
  if (!bloqueTexto) {
    throw new AnalisisAvanzadoError("El asistente no ha devuelto un análisis interpretable.");
  }

  let analisis;
  try {
    analisis = JSON.parse(bloqueTexto.text);
  } catch (e) {
    throw new AnalisisAvanzadoError("No se pudo interpretar la respuesta del asistente.");
  }

  if (!Array.isArray(analisis.clausulas)) analisis.clausulas = [];
  // El esquema JSON no admite minimum/maximum en campos "integer" (la API de
  // Anthropic los rechaza), asi que el rango 1-10 solo queda pedido por
  // instrucciones en el prompt/descripcion: se fuerza aqui por si acaso.
  analisis.puntuacionGlobal = Math.min(10, Math.max(1, Math.round(Number(analisis.puntuacionGlobal) || 1)));
  return analisis;
}

/* ================================================================
   5. Generacion de informes PDF (plantilla UIC)
   ================================================================ */

function colorNivel(nivel) {
  switch (nivel) {
    case "Bajo": return { fondo: "#f5d6d6", texto: ROJO_OSCURO };
    case "Medio": return { fondo: "#e39494", texto: ROJO_OSCURO };
    case "Alto": return { fondo: ROJO, texto: "#ffffff" };
    default: return { fondo: ROJO_OSCURO, texto: "#ffffff" };
  }
}

// Colores por nivel de riesgo (verde/amarillo/naranja/rojo) usados en el
// informe de analisis avanzado: a diferencia de colorNivel() (solo tonos
// rojos, para el informe basico), aqui cada nivel tiene un color distinto.
const VERDE = "#1f9d55";
const AMARILLO = "#c9971f";
const NARANJA = "#d97706";

function colorRiesgo(riesgo) {
  switch (riesgo) {
    case "bajo": return { color: VERDE, etiqueta: "Riesgo bajo" };
    case "medio": return { color: AMARILLO, etiqueta: "Riesgo medio" };
    case "alto": return { color: NARANJA, etiqueta: "Riesgo alto" };
    default: return { color: ROJO_OSCURO, etiqueta: "Riesgo muy alto" };
  }
}

function etiquetaNivelGlobal(nivelGlobal) {
  switch (nivelGlobal) {
    case "bajo": return "Bajo";
    case "medio": return "Medio";
    case "alto": return "Alto";
    default: return "Muy alto";
  }
}

// Cabecera comun (logo UIC, titulo, fecha y linea separadora) para ambos
// informes; devuelve la posicion Y donde empieza el cuerpo del documento.
function dibujarCabecera(doc, anchoUtil, titulo) {
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, doc.page.margins.left, doc.page.margins.top, { width: 130 });
  }
  doc
    .fillColor(NEGRO)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(titulo, doc.page.margins.left + 150, doc.page.margins.top + 6, {
      width: anchoUtil - 150,
    });
  doc
    .fillColor(ROJO)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("UIC · Unión de Instaladores y Consumidores", doc.page.margins.left + 150, doc.page.margins.top + 30, {
      width: anchoUtil - 150,
    });

  const fecha = new Intl.DateTimeFormat("es-ES", { dateStyle: "long", timeStyle: "short" }).format(new Date());
  doc
    .fillColor(GRIS)
    .font("Helvetica")
    .fontSize(9)
    .text(`Fecha del análisis: ${fecha}`, doc.page.margins.left + 150, doc.page.margins.top + 48, {
      width: anchoUtil - 150,
    });

  doc.moveTo(doc.page.margins.left, doc.page.margins.top + 85)
    .lineTo(doc.page.width - doc.page.margins.right, doc.page.margins.top + 85)
    .lineWidth(1.5)
    .strokeColor(ROJO)
    .stroke();

  doc.y = doc.page.margins.top + 100;
}

// Pie de pagina comun, repetido en todas las paginas ya generadas del
// documento (se invoca justo antes de doc.end()).
function dibujarPiePagina(doc, anchoUtil, texto) {
  // Se escribe por debajo del margen inferior habitual del documento; si no
  // se anula temporalmente ese margen, pdfkit interpreta la posicion como un
  // desbordamiento y crea una pagina en blanco adicional solo para el pie.
  const margenInferiorOriginal = doc.page.margins.bottom;
  const rangoPaginas = doc.bufferedPageRange();
  for (let i = 0; i < rangoPaginas.count; i++) {
    doc.switchToPage(rangoPaginas.start + i);
    doc.page.margins.bottom = 0;
    doc
      .fillColor(GRIS)
      .font("Helvetica")
      .fontSize(8)
      .text(texto, doc.page.margins.left, doc.page.height - margenInferiorOriginal + 15, {
        width: anchoUtil,
        align: "center",
      });
    doc.page.margins.bottom = margenInferiorOriginal;
  }
}

// Crea el PDFDocument del informe y lo devuelve ya cerrado (doc.end() ya se
// ha llamado); quien invoque esta funcion solo tiene que hacer doc.pipe(res).
function generarInformePDF({ nombreArchivo, clausulas, puntuacionGlobal, nivel, conteosAnonimizacion, totalAnonimizado }) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    bufferPages: true, // necesario para volver a paginas anteriores y anadir el pie de pagina
    info: { Title: "Informe de análisis de contrato - UIC" },
  });

  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  dibujarCabecera(doc, anchoUtil, "Informe de análisis de contrato");

  /* ---- Nota de anonimizacion ---- */
  doc
    .fillColor(GRIS)
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text(
      totalAnonimizado > 0
        ? `Antes de este análisis se anonimizaron automáticamente ${totalAnonimizado} dato(s) sensible(s) del documento original (nombres, DNI/NIE/NIF/CIF, direcciones, teléfonos, emails, datos bancarios y/o nombres de empresa). Este informe no contiene datos personales ni logotipos de terceros.`
        : "No se detectaron datos personales identificables en el documento. Este informe no contiene datos personales ni logotipos de terceros.",
      { width: anchoUtil }
    );
  doc.moveDown(1.2);

  /* ---- Puntuacion global ---- */
  const cajaY = doc.y;
  const cajaAlto = 70;
  doc.roundedRect(doc.page.margins.left, cajaY, anchoUtil, cajaAlto, 6).fillColor(GRIS_CLARO).fill();

  doc
    .fillColor(ROJO)
    .font("Helvetica-Bold")
    .fontSize(30)
    .text(`${puntuacionGlobal}/10`, doc.page.margins.left + 20, cajaY + 15, { continued: false });

  const { fondo, texto } = colorNivel(nivel);
  const badgeAncho = 110;
  const badgeX = doc.page.margins.left + 150;
  const badgeY = cajaY + 22;
  doc.roundedRect(badgeX, badgeY, badgeAncho, 26, 13).fillColor(fondo).fill();
  doc
    .fillColor(texto)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(`Riesgo ${nivel}`, badgeX, badgeY + 7, { width: badgeAncho, align: "center" });

  doc
    .fillColor(NEGRO)
    .font("Helvetica")
    .fontSize(9)
    .text(
      clausulas.length === 0
        ? "No se han detectado cláusulas de riesgo relevantes en el texto analizado."
        : `Se han detectado ${clausulas.length} cláusula(s) de riesgo. Revisa y negocia las de mayor puntuación antes de firmar.`,
      doc.page.margins.left + 290,
      cajaY + 15,
      { width: anchoUtil - 300 }
    );

  doc.x = doc.page.margins.left;
  doc.y = cajaY + cajaAlto + 20;

  /* ---- Listado de clausulas ---- */
  doc.fillColor(NEGRO).font("Helvetica-Bold").fontSize(13).text("Cláusulas detectadas", doc.page.margins.left);
  doc.moveDown(0.5);

  if (clausulas.length === 0) {
    doc
      .fillColor(GRIS)
      .font("Helvetica")
      .fontSize(10)
      .text("No se han detectado cláusulas de riesgo automáticamente. Revisa el documento completo manualmente.", doc.page.margins.left);
  }

  clausulas.forEach((clausula) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();

    const inicioBloque = doc.y;
    doc
      .fillColor(NEGRO)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(clausula.label, doc.page.margins.left, inicioBloque, { width: anchoUtil - 60 });

    doc
      .fillColor(ROJO)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`${clausula.score}/10`, doc.page.width - doc.page.margins.right - 50, inicioBloque, {
        width: 50,
        align: "right",
      });

    // Los dos .text() anteriores comparten la misma linea (etiqueta a la
    // izquierda, puntuacion a la derecha) pero pueden dejar el cursor
    // doc.x/doc.y en sitios distintos; se fija explicitamente la columna
    // izquierda antes de seguir, para que la descripcion no herede la
    // posicion x del bloque de puntuacion (que queda pegado al margen
    // derecho) y termine recortada fuera de la pagina.
    doc.x = doc.page.margins.left;
    doc.y = inicioBloque + 16;

    doc.fillColor(GRIS).font("Helvetica").fontSize(9.5).text(clausula.descripcion, doc.page.margins.left, doc.y, { width: anchoUtil });

    doc.x = doc.page.margins.left;
    doc.moveDown(0.15);
    doc
      .fillColor("#888888")
      .font("Helvetica-Oblique")
      .fontSize(8.5)
      .text(`"${clausula.fragmento}"`, doc.page.margins.left, doc.y, { width: anchoUtil });

    doc.x = doc.page.margins.left;
    doc.moveDown(0.3);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(BORDE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.6);
    doc.x = doc.page.margins.left;
  });

  dibujarPiePagina(
    doc,
    anchoUtil,
    "Informe generado automáticamente por SegurPanel (UIC). Análisis orientativo, no constituye asesoramiento legal."
  );

  doc.end();
  return doc;
}

// Informe legal avanzado: analisis clausula por clausula generado por Claude
// (analizarConIA), con explicacion en lenguaje sencillo, base legal y una
// barra de color por nivel de riesgo (verde/amarillo/naranja/rojo).
function generarInformePDFAvanzado({ resumenGeneral, puntuacionGlobal, nivelGlobal, clausulas, totalAnonimizado }) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    bufferPages: true,
    info: { Title: "Informe de análisis legal avanzado - UIC" },
  });

  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  dibujarCabecera(doc, anchoUtil, "Análisis legal avanzado del contrato");

  doc
    .fillColor(GRIS)
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text(
      (totalAnonimizado > 0
        ? `Antes de este análisis se anonimizaron automáticamente ${totalAnonimizado} dato(s) sensible(s) del documento original. `
        : "") +
        "Análisis elaborado con asistencia de inteligencia artificial (Claude, de Anthropic), basado en la Ley 5/2014 de Seguridad Privada, la LGDCU, la LCGC, el Código Civil español y el RGPD/LOPDGDD. Es un análisis orientativo y no sustituye el asesoramiento de un abogado colegiado.",
      { width: anchoUtil }
    );
  doc.moveDown(1.2);

  /* ---- Puntuacion global ---- */
  const cajaY = doc.y;
  const cajaAlto = 70;
  doc.roundedRect(doc.page.margins.left, cajaY, anchoUtil, cajaAlto, 6).fillColor(GRIS_CLARO).fill();

  doc
    .fillColor(NEGRO)
    .font("Helvetica-Bold")
    .fontSize(30)
    .text(`${puntuacionGlobal}/10`, doc.page.margins.left + 20, cajaY + 15);

  const nivelTexto = etiquetaNivelGlobal(nivelGlobal);
  const { color: colorGlobal } = colorRiesgo(nivelGlobal);
  const badgeAncho = 110;
  const badgeX = doc.page.margins.left + 150;
  const badgeY = cajaY + 22;
  doc.roundedRect(badgeX, badgeY, badgeAncho, 26, 13).fillColor(colorGlobal).fill();
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(`Riesgo ${nivelTexto}`, badgeX, badgeY + 7, { width: badgeAncho, align: "center" });

  doc
    .fillColor(NEGRO)
    .font("Helvetica")
    .fontSize(9)
    .text(resumenGeneral || "", doc.page.margins.left + 290, cajaY + 12, { width: anchoUtil - 300 });

  doc.x = doc.page.margins.left;
  doc.y = cajaY + cajaAlto + 20;

  /* ---- Listado de clausulas ---- */
  doc.fillColor(NEGRO).font("Helvetica-Bold").fontSize(13).text("Cláusulas analizadas", doc.page.margins.left);
  doc.moveDown(0.5);

  if (clausulas.length === 0) {
    doc
      .fillColor(GRIS)
      .font("Helvetica")
      .fontSize(10)
      .text("El asistente no ha identificado cláusulas individuales. Revisa el documento completo manualmente.", doc.page.margins.left);
  }

  const anchoBarra = 5;
  const anchoTexto = anchoUtil - anchoBarra - 12;

  clausulas.forEach((clausula) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();

    const inicioBloque = doc.y;
    const xTexto = doc.page.margins.left + anchoBarra + 12;
    const { color: colorBarra, etiqueta } = colorRiesgo(clausula.riesgo);

    doc
      .fillColor(NEGRO)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`Cláusula ${clausula.numero} · ${clausula.titulo}`, xTexto, inicioBloque, { width: anchoTexto - 90 });

    doc
      .fillColor(colorBarra)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(etiqueta, doc.page.width - doc.page.margins.right - 90, inicioBloque + 1, { width: 90, align: "right" });

    doc.x = xTexto;
    doc.y = inicioBloque + 18;
    doc.fillColor(GRIS).font("Helvetica").fontSize(9.5).text(clausula.explicacion, xTexto, doc.y, { width: anchoTexto });

    doc.x = xTexto;
    doc.moveDown(0.2);
    doc
      .fillColor("#888888")
      .font("Helvetica-Oblique")
      .fontSize(8.5)
      .text(`Base legal: ${clausula.baseLegal}`, xTexto, doc.y, { width: anchoTexto });

    const finBloque = doc.y + doc.currentLineHeight() + 6;

    // Barra de color vertical a la izquierda del bloque, representando el
    // nivel de riesgo de la clausula (verde/amarillo/naranja/rojo).
    doc.rect(doc.page.margins.left, inicioBloque, anchoBarra, finBloque - inicioBloque).fillColor(colorBarra).fill();

    doc.x = doc.page.margins.left;
    doc.y = finBloque;
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(BORDE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.6);
    doc.x = doc.page.margins.left;
  });

  dibujarPiePagina(
    doc,
    anchoUtil,
    "Informe generado por SegurPanel (UIC) con asistencia de IA. Análisis orientativo, no constituye asesoramiento legal."
  );

  doc.end();
  return doc;
}

module.exports = {
  extraerTexto,
  anonimizarTexto,
  anonimizarResumenIA,
  extraerProvinciaYEmpresa,
  detectarClausulas,
  analizarConIA,
  generarInformePDF,
  generarInformePDFAvanzado,
  OcrNoDisponibleError,
  AnalisisAvanzadoError,
  MIME_PDF,
  MIME_DOCX,
  MIME_DOC,
  MIME_ODT,
  MIME_TXT,
  MIMES_IMAGEN,
};
