// analisis.js
//
// Motor de analisis de contratos para la pestana "Analisis":
//   1. Extraccion de texto desde PDF, Word (.docx), JPG/PNG (OCR).
//   2. Anonimizacion de datos sensibles (nombres, DNI/NIE/NIF/CIF, direcciones,
//      telefonos, emails, datos bancarios, nombres de empresa).
//   3. Deteccion y puntuacion (1-10) de clausulas de riesgo habituales en
//      contratos de alarmas (permanencia, penalizacion, renovacion automatica,
//      subida de precio, etc.).
//   4. Generacion del informe PDF con la plantilla corporativa de UIC.
//
// Todo el procesado ocurre en el servidor: el archivo original nunca se
// reenvia al navegador ni se incrusta en el informe, asi que ni los datos
// anonimizados ni los logos de terceros que pudiera contener el documento
// original llegan a formar parte del PDF generado.

const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const { createWorker } = require("tesseract.js");
const PDFDocument = require("pdfkit");

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
const MIMES_IMAGEN = new Set(["image/jpeg", "image/png"]);

// El worker de OCR tarda varios segundos en inicializarse (descarga/carga el
// modelo). Se crea una unica vez y se reutiliza entre peticiones en lugar de
// crearlo y destruirlo por cada imagen.
let ocrWorkerPromesa = null;
function obtenerOcrWorker() {
  if (!ocrWorkerPromesa) {
    ocrWorkerPromesa = createWorker("spa").catch((err) => {
      ocrWorkerPromesa = null; // permite reintentar en la siguiente peticion
      throw err;
    });
  }
  return ocrWorkerPromesa;
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

  if (MIMES_IMAGEN.has(mimetype) || ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    const worker = await obtenerOcrWorker();
    const resultado = await worker.recognize(buffer);
    return resultado.data.text || "";
  }

  throw new Error("Formato de archivo no soportado. Sube un PDF, un Word (.docx), o una imagen JPG/PNG.");
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
    re: /\b(?:Calle|C\/|Avda\.?|Avenida|Plaza|Pza\.?|Paseo|Polígono|Poligono|Camino|Urbanización|Urbanizacion)\s+[^\n,;]{3,60}/gi,
  },
  // Codigo postal + poblacion (p.ej. "28045 Madrid")
  { id: "cp", etiqueta: "[CÓDIGO POSTAL]", re: /\b\d{5}\b(?=\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g },
  // Nombres de persona tras etiquetas habituales de contrato
  {
    id: "nombre",
    etiqueta: "[NOMBRE]",
    re: /(?:D\.|Dña\.|Sr\.|Sra\.|Nombre y apellidos|Nombre del cliente|Nombre del titular|Titular|Abonado|Representante legal|Cliente)(\s*:?\s*)([A-ZÁÉÍÓÚÑ][a-zÀ-ÿ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-zÀ-ÿ]+){1,4})/g,
    grupoReemplazo: 2,
  },
  // Razon social generica ("... S.L.", "... S.A.", "... S.L.U.", "... S.C.")
  {
    id: "empresa",
    etiqueta: "[EMPRESA]",
    re: /\b[A-ZÁÉÍÓÚÑ][\wÀ-ÿ&.,'\- ]{1,60}?,?\s+S\.?\s?(?:L\.?U?\.?|A\.?U?\.?|C\.?|COOP\.?)\b/g,
  },
];

function anonimizarTexto(texto) {
  let resultado = texto;
  const conteos = {};

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

  EMPRESAS_CONOCIDAS.forEach((nombreEmpresa) => {
    const re = new RegExp("\\b" + nombreEmpresa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    let n = 0;
    resultado = resultado.replace(re, () => {
      n++;
      return "[EMPRESA]";
    });
    if (n > 0) conteos.empresa = (conteos.empresa || 0) + n;
  });

  const totalAnonimizado = Object.values(conteos).reduce((s, v) => s + v, 0);
  return { texto: resultado, conteos, total: totalAnonimizado };
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
   4. Generacion del informe PDF (plantilla UIC)
   ================================================================ */

function colorNivel(nivel) {
  switch (nivel) {
    case "Bajo": return { fondo: "#f5d6d6", texto: ROJO_OSCURO };
    case "Medio": return { fondo: "#e39494", texto: ROJO_OSCURO };
    case "Alto": return { fondo: ROJO, texto: "#ffffff" };
    default: return { fondo: ROJO_OSCURO, texto: "#ffffff" };
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

  /* ---- Cabecera con logo UIC ---- */
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, doc.page.margins.left, doc.page.margins.top, { width: 130 });
  }
  doc
    .fillColor(NEGRO)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("Informe de análisis de contrato", doc.page.margins.left + 150, doc.page.margins.top + 6, {
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

  /* ---- Pie de pagina ---- */
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
      .text(
        "Informe generado automáticamente por SegurPanel (UIC). Análisis orientativo, no constituye asesoramiento legal.",
        doc.page.margins.left,
        doc.page.height - margenInferiorOriginal + 15,
        { width: anchoUtil, align: "center" }
      );
    doc.page.margins.bottom = margenInferiorOriginal;
  }

  doc.end();
  return doc;
}

module.exports = {
  extraerTexto,
  anonimizarTexto,
  detectarClausulas,
  generarInformePDF,
  MIME_PDF,
  MIME_DOCX,
  MIMES_IMAGEN,
};
