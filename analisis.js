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

// Ciudades y provincias de España: las 50 provincias (con sus formas
// cooficiales donde aplica: Alacant/Alicante, Girona, Lleida, Ourense, A
// Coruña, Araba/Álava, Gipuzkoa, Bizkaia...), sus capitales cuando difieren
// del nombre de la provincia, y los ~100 municipios mas poblados de España
// (INE), que cubren de sobra las localidades que suelen aparecer en la
// direccion de un contrato aunque no sean capital de provincia (p.ej.
// Mijas, Marbella, Torrevieja, Fuengirola). Es una lista cerrada (gazetteer):
// no cubre absolutamente todos los ~8100 municipios de España, pero junto
// con la regla "cp" de abajo (que anonimiza CUALQUIER localidad que
// acompañe a un codigo postal, este o no en esta lista) da una cobertura
// muy alta sin arriesgarse a los falsos positivos de intentar adivinar por
// patron que es una ciudad y que no.
// Provincias (nombre oficial y formas cooficiales) y comunidades autonomas
// -> etiqueta [PROVINCIA]. Ojo: varias provincias comparten nombre literal
// con su propia capital (Madrid, Sevilla, Málaga, Córdoba, Granada,
// Valencia, Murcia...); esa ambiguedad es inevitable con un simple listado
// de nombres, y aqui se resuelve a favor de [PROVINCIA] por ser el caso mas
// habitual en un bloque de direccion ("Provincia: MADRID").
const PROVINCIAS_COMUNIDADES = [
  "Almería", "Cádiz", "Córdoba", "Granada", "Huelva", "Jaén", "Málaga", "Sevilla",
  "Huesca", "Teruel", "Zaragoza", "Asturias", "Baleares", "Illes Balears",
  "Álava", "Araba", "Vizcaya", "Bizkaia", "Guipúzcoa", "Gipuzkoa",
  "Las Palmas", "Santa Cruz de Tenerife", "Cantabria", "Ávila", "Burgos",
  "León", "Palencia", "Salamanca", "Segovia", "Soria", "Valladolid", "Zamora",
  "Albacete", "Ciudad Real", "Cuenca", "Guadalajara", "Toledo",
  "Barcelona", "Girona", "Gerona", "Lleida", "Lérida", "Tarragona",
  "Badajoz", "Cáceres", "A Coruña", "La Coruña", "Lugo", "Ourense", "Orense", "Pontevedra",
  "La Rioja", "Madrid", "Murcia", "Navarra",
  "Alicante", "Alacant", "Castellón", "Castelló", "Valencia", "València",
  "Ceuta", "Melilla",
  // Comunidades autonomas que no coinciden con el nombre de ninguna
  // provincia de la lista de arriba (Asturias, Baleares, Cantabria, La
  // Rioja, Madrid, Murcia y Navarra son a la vez provincia y comunidad
  // autonoma de una sola provincia, ya cubiertas).
  "Andalucía", "Aragón", "Canarias", "Castilla-La Mancha", "Castilla la Mancha",
  "Castilla y León", "Cataluña", "Catalunya", "Comunidad Valenciana",
  "Comunitat Valenciana", "País Valencià", "Extremadura", "Galicia",
  "País Vasco", "Euskadi",
];

// Ciudades/municipios -> etiqueta [CIUDAD]: capitales de provincia cuyo
// nombre difiere del de esta (por lo que no hay ambiguedad con
// PROVINCIAS_COMUNIDADES) y los ~90 municipios mas poblados de España
// (INE) que no son capital de provincia.
const CIUDADES = [
  "Vitoria-Gasteiz", "Bilbao", "San Sebastián", "Donostia", "Oviedo",
  "Palma", "Palma de Mallorca", "Santander", "Logroño", "Pamplona", "Iruña",
  "Castellón de la Plana", "Las Palmas de Gran Canaria", "Santiago de Compostela",
  "Vigo", "Gijón", "L'Hospitalet de Llobregat", "Elche", "Elx", "Terrassa",
  "Badalona", "Cartagena", "Sabadell", "Jerez de la Frontera", "Móstoles",
  "Alcalá de Henares", "Fuenlabrada", "Leganés", "Getafe", "Alcorcón",
  "San Cristóbal de La Laguna", "Marbella", "Dos Hermanas", "Torrejón de Ardoz",
  "Parla", "Mataró", "Algeciras", "Santa Coloma de Gramenet", "Alcobendas",
  "Reus", "Telde", "Barakaldo", "Roquetas de Mar", "Las Rozas de Madrid",
  "San Fernando", "Lorca", "Sant Cugat del Vallès", "San Sebastián de los Reyes",
  "Cornellà de Llobregat", "El Puerto de Santa María", "Rivas-Vaciamadrid",
  "Pozuelo de Alarcón", "Chiclana de la Frontera", "Sant Boi de Llobregat",
  "El Ejido", "Talavera de la Reina", "Torrevieja", "Mijas", "Torrent",
  "Coslada", "Vélez-Málaga", "Arona", "Fuengirola", "Avilés", "Getxo",
  "Manresa", "Rubí", "Orihuela", "Valdemoro", "Alcalá de Guadaíra",
];

// Cada nombre admite tambien su forma TODO EN MAYÚSCULAS ("Baleares" y
// "BALEARES", "Cataluña" y "CATALUÑA"): es habitual que el bloque de
// direccion o los formularios impresos escriban la provincia/comunidad
// autonoma en mayusculas. No se generaliza a mayuscula/minuscula libre
// (case-insensitive completo) para no arriesgarse a que una palabra suelta
// en minuscula que coincida por casualidad con un topónimo (p.ej. "reus",
// el verbo) se anonimice por error.
function formasCiudad(nombre) {
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normal = escapar(nombre);
  const mayus = escapar(nombre.toUpperCase());
  return normal === mayus ? normal : `(?:${normal}|${mayus})`;
}
// Ordenadas de mas larga a mas corta: en una alternancia regex (a|b|c) el
// motor prueba las opciones en orden y se queda con la PRIMERA que caza en
// esa posicion (no seguirá probando a ver si hay una mas larga), asi que si
// "Palma" fuese antes que "Palma de Mallorca" en la lista, "Palma de
// Mallorca" se cortaria en seco dejando " de Mallorca" sin anonimizar.
function patronLugares(lista) {
  return [...lista]
    .sort((a, b) => b.length - a.length)
    .map(formasCiudad)
    .join("|");
}
const PATRON_PROVINCIAS = patronLugares(PROVINCIAS_COMUNIDADES);
const PATRON_CIUDADES = patronLugares(CIUDADES);

// Conectores de apellidos compuestos ("del Río", "de la Torre", "van Dijk"),
// tolerantes a mayuscula/minuscula inicial del conector: en la practica los
// contratos (sobre todo si vienen de OCR o de un formulario mal rellenado)
// no siempre respetan que el conector vaya en minuscula ("Enrique Del rio"
// en vez de "Enrique del Río"), y exigir minuscula estricta dejaba a medias
// justo la parte del apellido que sigue al conector.
const CONECTOR_APELLIDO = "(?:[Dd]e(?:\\s+la|\\s+los|\\s+las)?|[Dd]el|[Ll]a|[Ll]as|[Ll]os|[Yy]|[Vv]an|[Vv]on|[Dd]er|[Dd]o|[Dd]os|[Dd]as)";
// Una palabra de un nombre: o bien "Tipo Título" (mayuscula inicial, resto
// minuscula) o bien TODO EN MAYUSCULAS (2 letras o mas). Esta segunda forma
// hace falta porque los formularios de contrato piden a menudo el nombre
// "en letra de molde" (bloque/mayusculas), y la gente lo escribe tal cual
// se lo piden ("MARIA JOSE FERNANDEZ RUIZ"). Cualquiera de las dos formas
// sigue exigiendo mayuscula en algun punto de la palabra, que es lo que
// evita que la regla se coma texto normal de la frase en minuscula.
const PALABRA_NOMBRE = "(?:[A-ZÁÉÍÓÚÑ][a-zà-ÿ]+|[A-ZÁÉÍÓÚÑ]{2,})";
// Nombre de pila + hasta 4 palabras mas (apellidos simples o compuestos con
// conector). La palabra que sigue a un conector reconocido no necesita
// empezar en mayuscula (ver comentario de CONECTOR_APELLIDO); cualquier
// otra palabra del nombre si debe cumplir PALABRA_NOMBRE, para no empezar
// a comerse texto normal de la frase que sigue.
const PATRON_NOMBRE =
  PALABRA_NOMBRE + "(?:\\s+" + CONECTOR_APELLIDO + "\\s+[A-Za-zÀ-ÿ]+|\\s+" + PALABRA_NOMBRE + "){1,4}";
// Honorifico opcional entre la etiqueta de rol ("Cliente:", "Titular:"...) y
// el nombre en si ("Cliente: D. Alejandro..."), para no dejarlo colgando.
const HONORIFICO_OPCIONAL = "(?:D\\.|Dña\\.|Don|Doña|Sr\\.|Sra\\.)?\\s*";

// Conectores tipicos en topónimos compuestos ("Puerto de Santa María",
// "Palma de Mallorca"), con la misma tolerancia a mayuscula/minuscula que
// CONECTOR_APELLIDO, para la regla "cp" de abajo (codigo postal + poblacion
// que no está en el gazetteer CIUDADES_PROVINCIAS).
const CONECTOR_LUGAR = "(?:[Dd]e(?:\\s+la|\\s+los|\\s+las)?|[Dd]el|[Ll]a|[Ll]as|[Ll]os)";

// Construye la alternancia de una lista de etiquetas de rol ("Cliente",
// "El instalador"...) tolerando que la inicial vaya en mayuscula o en
// minuscula (una etiqueta de campo suele ir capitalizada, pero mencionada a
// mitad de frase - "firmado por el instalador..." - suele ir en minuscula).
// A proposito NO se usa el flag "i" de la regex entera para esto: eso haria
// case-insensible tambien PATRON_NOMBRE, que depende de exigir mayuscula
// inicial en cada palabra del nombre para no empezar a comerse texto
// corriente en minuscula (ver el bug ya corregido de las reglas
// "cliente"/"empleado" en el historial de este fichero).
function disparadoresRol(frases) {
  return frases
    .map((frase) => {
      const escapada = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
      const inicial = frase[0];
      const minuscula = inicial.toLowerCase();
      if (inicial === minuscula) return escapada; // ya en minuscula (p.ej. "P.p.")
      return `(?:${escapada}|${escapada.replace(inicial, minuscula)})`;
    })
    .join("|");
}

const CLIENTE_DISPARADORES = disparadoresRol([
  "Nombre y apellidos", "Apellidos y nombre", "Nombre del cliente", "Nombre del titular",
  "Nombre del contratante", "Nombre del abonado", "Datos del cliente", "Datos del titular",
  "Nombre en letra de molde",
  "El cliente", "El titular", "El abonado", "El contratante", "El suscriptor",
  "Titular", "Abonado", "Asegurado", "Contratante", "Suscriptor", "Cliente",
]);

const EMPLEADO_DISPARADORES = disparadoresRol([
  "Técnico instalador", "Instalador", "Técnico", "Comercial", "Vendedor", "Agente",
  "Empleado", "Trabajador", "Gestor comercial", "Gestor", "Delegado", "Asesor", "Apoderado",
  "Representante legal", "Representado por", "En representación de", "Actuando en representación de",
  "En nombre de", "Por poder", "P.p.", "El comercial", "El técnico", "El instalador",
  "El empleado", "El representante", "El gestor", "El asesor",
  // Firma/autoria de la parte de la empresa, con distintas redacciones
  // habituales ("Vendido por:", "Firmado por:", la instalacion "realizada"
  // o "realizado" por según a que se refiera la frase).
  "Vendido por", "Realizado por", "Realizada por", "Firmado por",
  "La instalación será realizada por", "La instalación fue realizada por",
]);

const REGLAS_ANONIMIZACION = [
  // Email
  { id: "email", etiqueta: "[EMAIL]", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // IBAN / cuenta bancaria (ES + 2 digitos de control + 20 digitos, con o sin espacios)
  { id: "iban", etiqueta: "[IBAN]", re: /\b[A-Z]{2}\d{2}(?:[ -]?\d{4}){4,5}\b/g },
  // Cuenta bancaria formato CCC antiguo (4-4-2-10 digitos, con o sin
  // separadores). Va antes que telefono: aunque \b evita que un telefono de 9
  // digitos "muerda" en mitad de esta tirada de 20, mantener el orden deja
  // claro cual de las dos reglas manda si algun dia dejan de ser excluyentes.
  { id: "cuenta_bancaria", etiqueta: "[CUENTA_BANCARIA]", re: /\b\d{4}[ -]?\d{4}[ -]?\d{2}[ -]?\d{10}\b/g },
  // NIE: letra X/Y/Z + 7 digitos + letra, con separador opcional (espacio o guion)
  { id: "nie", etiqueta: "[NIE]", re: /\b[XYZxyz][-\s]?\d{7}[-\s]?[A-Za-z]\b/g },
  // CIF: letra + 7 digitos + digito/letra de control
  { id: "cif", etiqueta: "[CIF]", re: /\b[A-HJNPQSUVWabhjnpqsuvw]\d{7}[0-9A-Ja-j]\b/g },
  // DNI/NIF: 8 digitos + letra, con separador opcional (espacio o guion)
  { id: "dni", etiqueta: "[DNI/NIF]", re: /\b\d{8}[-\s]?[A-Za-z]\b/g },
  // Telefono espanol (fijo o movil, con o sin prefijo +34, con o sin parentesis)
  { id: "telefono", etiqueta: "[TELÉFONO]", re: /(?:\(?(?:\+|00)34\)?[ .-]?)?\b[6789]\d{2}(?:[ .-]?\d{3}){2}\b/g },
  // Direcciones postales habituales en contratos. Incluye las formas
  // catalanas/gallegas/vascas mas comunes de "calle" (Carrer, Rúa, Kalea) y
  // "avenida"/"paseo"/"plaza" (Avinguda, Passeig, Plaça, Rambla), no solo las
  // castellanas. El espacio tras el prefijo es OPCIONAL (\s*, no \s+): con
  // abreviaturas cortas como "C/" es habitual escribir el nombre de la calle
  // pegado ("C/Geranio 1") y con \s+ ese caso no matcheaba nada en absoluto.
  {
    id: "direccion",
    etiqueta: "[DIRECCIÓN]",
    re: /\b(?:Calle|C\/|Avda\.?|Avenida|Avinguda|Avgda\.?|Plaza|Plaça|Pza\.?|Paseo|Passeig|Pº\.?|Polígono|Poligono|Camino|Urbanización|Urbanizacion|Vía|Via|Ronda|Travesía|Travesia|Travessera|Glorieta|Bloque|Carrer|Rambla|Rúa|Rua|Kalea|Praza)\s*[^\n,;]{3,60}/gi,
  },
  // Piso/puerta/planta (p.ej. "3º B", "Piso 2, Puerta 4") que suelen acompañar
  // a una direccion ya anonimizada por la regla anterior.
  {
    id: "piso_puerta",
    etiqueta: "[PISO/PUERTA]",
    re: /\b(?:Piso|Puerta|Planta|Escalera|Portal)\s*[:.\-]?\s*[0-9A-Za-zºª]{1,4}\b/gi,
  },
  // Codigo postal + poblacion (p.ej. "28045 Madrid", "07008 Palma de
  // Mallorca"): a diferencia de la version anterior (que solo comprobaba con
  // un lookahead que hubiera una poblacion detras y anonimizaba UNICAMENTE
  // el codigo postal, dejando el nombre de la poblacion intacto), esta
  // version consume y sustituye TAMBIEN el nombre de la localidad. Al ir por
  // contexto (codigo postal delante) cubre cualquier poblacion, este o no en
  // el gazetteer CIUDADES_PROVINCIAS de abajo (imposible enumerar los ~8100
  // municipios de España).
  {
    id: "cp",
    etiqueta: "[CÓDIGO POSTAL] [CIUDAD]",
    re: new RegExp(
      "\\b\\d{5}\\s+[A-ZÁÉÍÓÚÑ][a-zà-ÿ]+(?:\\s+" + CONECTOR_LUGAR + "\\s+[A-Za-zÀ-ÿ]+|\\s+[A-ZÁÉÍÓÚÑ][a-zà-ÿ]+){0,3}",
      "g"
    ),
  },
  // Provincias y comunidades autonomas de España que aparecen SIN codigo
  // postal delante (p.ej. "domicilio social en Palma de Mallorca, BALEARES",
  // "residente en Mijas (Málaga)"): la regla "cp" de arriba ya cubre la
  // poblacion cuando va pegada a un codigo postal, pero el nombre de la
  // provincia que suele acompañarla despues (", Baleares", ", CATALUÑA"...)
  // no lleva codigo postal propio y necesita esta regla aparte, basada en el
  // listado cerrado PROVINCIAS_COMUNIDADES (admite tanto "Baleares" como
  // "BALEARES", ver formasCiudad). Va ANTES que la regla "ciudad" de abajo
  // para que un nombre ambiguo que sea a la vez provincia y capital
  // homonima (Madrid, Sevilla, Málaga...) se etiquete como [PROVINCIA], el
  // caso mas habitual en un bloque de direccion.
  //
  // Limites de palabra con lookaround (no \b) porque varias provincias
  // empiezan por vocal acentuada (Álava, Ávila), y \b no detecta bien el
  // límite cuando el caracter a un lado no es una letra "\w" ASCII (las
  // vocales acentuadas no lo son).
  {
    id: "provincia",
    etiqueta: "[PROVINCIA]",
    re: new RegExp("(?<![A-Za-zÀ-ÿ])(?:" + PATRON_PROVINCIAS + ")(?![A-Za-zÀ-ÿ])", "g"),
  },
  // Ciudades/municipios de España (ver comentario de la regla "provincia"
  // de arriba: mismo mecanismo, listado CIUDADES en vez de
  // PROVINCIAS_COMUNIDADES).
  {
    id: "ciudad",
    etiqueta: "[CIUDAD]",
    re: new RegExp("(?<![A-Za-zÀ-ÿ])(?:" + PATRON_CIUDADES + ")(?![A-Za-zÀ-ÿ])", "g"),
  },
  // Matricula espanola actual: 4 digitos + 3 consonantes (sin vocales/Ñ/Q)
  { id: "matricula", etiqueta: "[MATRÍCULA]", re: /\b\d{4}\s?-?\s?[BCDFGHJKLMNPRSTVWXYZ]{3}\b/g },
  // URLs (http/https o www.), para no dejar rastreable ninguna web de terceros
  { id: "url", etiqueta: "[URL]", re: /\b(?:https?:\/\/|www\.)[^\s,;]+/gi },
  // Numero de cliente/abonado/poliza/contrato/serie/orden (identificador
  // interno que permite rastrear a la persona aunque el nombre ya se haya
  // anonimizado)
  {
    id: "referencia",
    etiqueta: "[REF]",
    re: /(?:(?:N[uú]mero|N[ºo]\.?)\s+de\s+(?:cliente|abonado|p[oó]liza|contrato|expediente|instalaci[oó]n|serie|orden)|C[oó]digo de cliente|Id de cliente)(\s*:?\s*)([A-Za-z0-9/\-]{3,20})/gi,
    grupoReemplazo: 2,
  },
  // Identificador interno del empleado que instala/vende/firma (distinto de
  // [REF], que es el identificador del CLIENTE). El propio ID no es un
  // nombre (puede llevar letras y numeros en cualquier orden/mayuscula), asi
  // que aqui si es seguro usar "gi": a diferencia de PATRON_NOMBRE, este
  // patron no depende de exigir mayuscula inicial como salvaguarda.
  {
    id: "id_empleado",
    etiqueta: "[ID_EMPLEADO]",
    re: /(?:ID\s+del\s+empleado|Employee\s+ID|Id\.?\s+de\s+empleado|Id\.?\s+empleado)(\s*:?\s*)([A-Za-z0-9][A-Za-z0-9/\-]{1,20})/gi,
    grupoReemplazo: 2,
  },
  // Nombres de CLIENTE: persona que contrata el servicio, tras cualquiera de
  // las etiquetas habituales con las que un contrato de alarmas identifica
  // a esa parte. Admite un honorifico opcional entre la etiqueta y el
  // nombre ("Cliente: D. Alejandro...") y apellidos compuestos con
  // conectores tolerantes a mayuscula/minuscula (ver PATRON_NOMBRE).
  {
    id: "cliente",
    etiqueta: "[CLIENTE]",
    re: new RegExp(
      "(?:" + CLIENTE_DISPARADORES + ")(\\s*:?\\s*)" +
        HONORIFICO_OPCIONAL +
        "(" + PATRON_NOMBRE + ")",
      "g"
    ),
    grupoReemplazo: 2,
  },
  // Nombres de EMPLEADO: persona que representa a la empresa de seguridad
  // (comercial, instalador, tecnico, apoderado que firma en su nombre...).
  {
    id: "empleado",
    etiqueta: "[EMPLEADO]",
    re: new RegExp(
      "(?:" + EMPLEADO_DISPARADORES + ")(\\s*:?\\s*)" +
        HONORIFICO_OPCIONAL +
        "(" + PATRON_NOMBRE + ")",
      "g"
    ),
    grupoReemplazo: 2,
  },
  // Nombres de persona tras un honorifico o firma SIN etiqueta de rol
  // explicita (p.ej. simplemente "D. Alejandro Jaime Palmer, mayor de
  // edad..." o "Fdo.: Enrique Del rio"): el rol (cliente o empleado) no se
  // puede saber con certeza solo por el honorifico, asi que se anonimiza
  // igualmente pero con la etiqueta generica [NOMBRE]. Va DESPUES de las
  // reglas "cliente" y "empleado" para que los casos con etiqueta de rol
  // expresa ya hayan quedado etiquetados con mas precision.
  {
    id: "nombre",
    etiqueta: "[NOMBRE]",
    re: new RegExp(
      "(?:D\\.|Dña\\.|Don|Doña|Sr\\.|Sra\\.|Fdo\\.?:?|Firmado)(\\s*:?\\s*)(" + PATRON_NOMBRE + ")",
      "g"
    ),
    grupoReemplazo: 2,
  },
  // Razon social por etiqueta explicita (antes de la regla generica S.L./S.A.
  // para que capture tambien nombres comerciales que no llevan esos sufijos)
  {
    id: "razon_social",
    etiqueta: "[EMPRESA]",
    re: /(?:Raz[oó]n Social|Denominaci[oó]n Social|Nombre comercial|Titular de la actividad|Nombre de la empresa)(\s*:?\s*)([^\n,;]{2,80})/gi,
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
   2b. Deteccion de la fecha de firma/creacion del contrato
   ================================================================ */
//
// Se busca en el texto ORIGINAL (antes de anonimizar: la fecha del contrato
// no es un dato personal). Reconoce fechas en letras ("a 14 de marzo de
// 2024") y fechas numericas (14/03/2024 o 14-03-2024). Si aparecen varias
// fechas plausibles, se usa la que aparece antes en el documento: la fecha
// de firma suele ir al principio (encabezado) o en el bloque de firmas al
// final, pero casi siempre antes que fechas incidentales sueltas en el
// cuerpo del contrato. Devuelve null si no encuentra ninguna.
const NOMBRES_MES = [
  "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const INDICE_MES = NOMBRES_MES.reduce((acc, nombre, i) => {
  if (nombre) acc[nombre] = i;
  return acc;
}, {});

function fechaContratoEsPlausible(dia, mes, anio) {
  if (!(mes >= 1 && mes <= 12)) return false;
  if (!(dia >= 1 && dia <= 31)) return false;
  const anioActual = new Date().getFullYear();
  return anio >= 1995 && anio <= anioActual + 1;
}

function formatearFechaContrato(dia, mes, anio) {
  return `${dia} de ${NOMBRES_MES[mes]} de ${anio}`;
}

function extraerFechaContrato(textoOriginal) {
  if (!textoOriginal) return null;
  const candidatas = [];

  const reLarga = /\b(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(\d{4})\b/gi;
  let m;
  while ((m = reLarga.exec(textoOriginal))) {
    const dia = parseInt(m[1], 10);
    const mes = INDICE_MES[m[2].toLowerCase()];
    const anio = parseInt(m[3], 10);
    if (mes && fechaContratoEsPlausible(dia, mes, anio)) {
      candidatas.push({ indice: m.index, texto: formatearFechaContrato(dia, mes, anio) });
    }
  }

  const reCorta = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
  while ((m = reCorta.exec(textoOriginal))) {
    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    const anio = parseInt(m[3], 10);
    if (fechaContratoEsPlausible(dia, mes, anio)) {
      candidatas.push({ indice: m.index, texto: formatearFechaContrato(dia, mes, anio) });
    }
  }

  if (candidatas.length === 0) return null;
  candidatas.sort((a, b) => a.indice - b.indice);
  return candidatas[0].texto;
}

/* ================================================================
   2c. Deteccion automatica de Hogar/Negocio
   ================================================================ */
//
// Cuenta cuantas palabras clave de cada lista aparecen en el contrato (texto
// original, antes de anonimizar: estas palabras no son datos sensibles). Gana
// el lado con mas coincidencias; en empate (incluido 0-0) no hay certeza y el
// Repositorio se guarda sin tipo, para que la persona usuaria lo indique a
// mano (ver renderFilaClasificar en index.html).

const PALABRAS_HOGAR = ["hogar", "vivienda", "residencial", "domicilio", "piso", "casa", "apartamento"];
const PALABRAS_NEGOCIO = ["negocio", "comercio", "empresa", "local comercial", "oficina", "industria", "nave"];

// "Empresa" es la palabra clave de Negocio menos fiable: casi todos los
// contratos hablan de "la empresa" para referirse a la PROPIA empresa de
// seguridad que presta el servicio (autorreferencia), lo que no dice nada
// sobre si el cliente es un hogar o un negocio. Antes de contar palabras
// clave se elimina esa autorreferencia (nombre conocido de la empresa de
// alarmas, o "la/esta/dicha empresa" seguida en la misma frase de un verbo
// habitual de prestacion de servicio) para que "empresa" solo puntue cuando
// el texto habla realmente del negocio del cliente.
const AUTORREFERENCIA_EMPRESA_SEGURIDAD = /\b(?:la|esta|dicha)\s+empresa\b(?=[^.]{0,40}\b(?:se compromete|instalar[aá]|prestar[aá]|facilitar[aá]|suministrar[aá]|garantiza|realizar[aá]|mantendr[aá]|de seguridad|de alarmas)\b)/gi;

function limpiarAutorreferenciasEmpresaSeguridad(textoOriginal) {
  let resultado = textoOriginal;
  EMPRESAS_CONOCIDAS.forEach((nombre) => {
    const re = new RegExp("\\b" + nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    resultado = resultado.replace(re, "");
  });
  return resultado.replace(AUTORREFERENCIA_EMPRESA_SEGURIDAD, "");
}

function contarPalabrasClave(textoOriginal, palabras) {
  return palabras.reduce((total, palabra) => {
    const re = new RegExp("\\b" + palabra.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    const coincidencias = textoOriginal.match(re);
    return total + (coincidencias ? coincidencias.length : 0);
  }, 0);
}

function detectarTipoContrato(textoOriginal) {
  const textoParaDeteccion = limpiarAutorreferenciasEmpresaSeguridad(textoOriginal);
  const puntosHogar = contarPalabrasClave(textoParaDeteccion, PALABRAS_HOGAR);
  const puntosNegocio = contarPalabrasClave(textoParaDeteccion, PALABRAS_NEGOCIO);
  if (puntosHogar === puntosNegocio) return { tipo: null, certeza: false, puntosHogar, puntosNegocio };
  return {
    tipo: puntosHogar > puntosNegocio ? "hogar" : "negocio",
    certeza: true,
    puntosHogar,
    puntosNegocio,
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

// Reintentos automaticos de la llamada a la API de Anthropic: en produccion
// se ha observado que la primera llamada puede fallar con "fetch failed"
// (timeout/corte de red a bajo nivel, o la API saturada devolviendo 429/5xx)
// sin que sea un fallo real del contrato ni de la peticion. MAX_REINTENTOS=3
// da hasta 4 intentos en total (el original + 3 reintentos), esperando 5s
// entre cada uno.
const MAX_REINTENTOS_IA = 3;
const ESPERA_REINTENTO_IA_MS = 5000;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Solo tiene sentido reintentar fallos TRANSITORIOS: un corte de red/timeout
// (fetch lanza excepcion) o una respuesta 429 (rate limit) / 5xx (error del
// lado de Anthropic) de la propia API. Un 4xx normal (400 peticion mal
// formada, 401 API key invalida...) va a fallar exactamente igual en el
// reintento, asi que se deja pasar sin reintentar.
function esFalloTransitorioIA(respuesta) {
  return respuesta.status === 429 || respuesta.status >= 500;
}

// Envuelve la llamada HTTP a Anthropic con la logica de reintentos de
// arriba. Devuelve la respuesta (ok o el ultimo fallo, para que el llamador
// la procese igual que antes) o relanza el ultimo error de red si ningun
// intento tuvo exito.
async function llamarAnthropicConReintentos(body, apiKey) {
  let ultimoError = null;
  for (let intento = 1; intento <= MAX_REINTENTOS_IA + 1; intento++) {
    try {
      const respuesta = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });

      const quedanIntentos = intento <= MAX_REINTENTOS_IA;
      if (!respuesta.ok && esFalloTransitorioIA(respuesta) && quedanIntentos) {
        console.error(
          `Analisis avanzado: la API de Anthropic devolvio ${respuesta.status} (intento ${intento}/${MAX_REINTENTOS_IA + 1}). Reintentando en ${ESPERA_REINTENTO_IA_MS / 1000}s...`
        );
        await esperar(ESPERA_REINTENTO_IA_MS);
        continue;
      }
      return respuesta;
    } catch (e) {
      // "fetch failed" y similares: fallo de red/timeout antes de recibir
      // siquiera una respuesta HTTP.
      ultimoError = e;
      if (intento <= MAX_REINTENTOS_IA) {
        console.error(
          `Analisis avanzado: fallo de red llamando a Anthropic (intento ${intento}/${MAX_REINTENTOS_IA + 1}): ${e.message}. Reintentando en ${ESPERA_REINTENTO_IA_MS / 1000}s...`
        );
        await esperar(ESPERA_REINTENTO_IA_MS);
      }
    }
  }
  // Se agotaron todos los intentos y el ultimo tambien fue un fallo de red
  // (si hubiera devuelto una respuesta HTTP, aunque fuese de error, ya se
  // habria devuelto en el bucle de arriba).
  throw new AnalisisAvanzadoError(
    `No se pudo conectar con la API de Anthropic tras ${MAX_REINTENTOS_IA + 1} intentos: ${ultimoError ? ultimoError.message : "error desconocido"}.`
  );
}

// Envia el texto (ya anonimizado) a la API de Anthropic para que Claude,
// actuando como abogado experto, analice el contrato clausula por clausula.
// La respuesta viene forzada a un JSON Schema (output_config.format), por lo
// que el primer bloque de texto de la respuesta es JSON valido garantizado.
// Reintenta automaticamente hasta 3 veces (ver llamarAnthropicConReintentos)
// si la primera llamada falla por un problema transitorio de red o de la
// API de Anthropic, antes de darse por vencido.
async function analizarConIA(textoAnonimizado) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnalisisAvanzadoError("El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.");
  }

  const textoRecortado = textoAnonimizado.slice(0, MAX_CARACTERES_ANALISIS_AVANZADO);

  const cuerpoPeticion = JSON.stringify({
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
  });

  const respuesta = await llamarAnthropicConReintentos(cuerpoPeticion, apiKey);

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

// Color corporativo de cada empresa conocida (EMPRESAS_CONOCIDAS en 2a),
// usado para el circulo identificativo de la cabecera del informe. El
// nombre real de la empresa NO se muestra en el PDF (el informe es para
// argumentacion comercial, no debe identificar a la competencia por su
// nombre): en su lugar se muestra `etiqueta`, una descripcion generica del
// color corporativo ("Empresa Rojo", "Empresa Azul"...). Sector Alarm usa
// dos colores de marca (negro y rojo): `relleno2` hace que el circulo se
// dibuje partido en dos mitades en vez de un solo color (ver
// dibujarCirculoEmpresa).
const COLOR_EMPRESA_DEFECTO = { relleno: "#9aa0a6", etiqueta: "Empresa no detectada" }; // gris
const COLORES_EMPRESA = {
  "Verisure": { relleno: "#E8003D", etiqueta: "Empresa Rojo" },
  "Sector Alarm": { relleno: "#000000", relleno2: "#CC0000", etiqueta: "Empresa Negro/Rojo" },
  "Sicor": { relleno: "#1B5E20", etiqueta: "Empresa Verde" },
  "Segurma": { relleno: "#F57C00", etiqueta: "Empresa Naranja" },
  "ADT": { relleno: "#0D47A1", etiqueta: "Empresa Azul" },
  "Seguridad 3D": { relleno: "#FDD835", etiqueta: "Empresa Amarillo/Verde" },
  "Grupo Control": { relleno: "#7B1C2B", etiqueta: "Empresa Burdeos" },
  "Trablisa": { relleno: "#0D1B3E", etiqueta: "Empresa Azul Marino/Naranja" },
  "MPA/Prosegur": { relleno: "#FDD835", etiqueta: "Empresa Amarillo" },
};

function colorEmpresa(empresa) {
  return COLORES_EMPRESA[empresa] || COLOR_EMPRESA_DEFECTO;
}

// Dibuja el circulo identificativo de la cabecera. Si `info.relleno2` esta
// definido (solo Sector Alarm) el circulo se parte en dos mitades verticales
// (izquierda `relleno`, derecha `relleno2`) recortando dos rectangulos con
// el propio circulo como mascara de recorte; si no, es un circulo de un
// solo color relleno.
function dibujarCirculoEmpresa(doc, cx, cy, r, info) {
  if (info.relleno2) {
    doc.save();
    doc.circle(cx, cy, r).clip();
    doc.rect(cx - r, cy - r, r, r * 2).fillColor(info.relleno).fill();
    doc.rect(cx, cy - r, r, r * 2).fillColor(info.relleno2).fill();
    doc.restore();
  } else {
    doc.circle(cx, cy, r).fillColor(info.relleno).fill();
  }
}

// Badge Hogar/Negocio de la cabecera. Colores distintos de los de riesgo
// (verde/amarillo/naranja/rojo) para que no se confundan con la puntuacion.
function colorTipoContrato(tipo) {
  if (tipo === "hogar") return { fondo: "#dbeafe", texto: "#1e3a8a", etiqueta: "HOGAR" };
  if (tipo === "negocio") return { fondo: "#ede9fe", texto: "#5b21b6", etiqueta: "NEGOCIO" };
  return { fondo: GRIS_CLARO, texto: GRIS, etiqueta: "Tipo no detectado" };
}

// Margenes de los informes PDF (analisis basico y avanzado): 50pt en los
// cuatro lados. anchoUtil = pageWidth - left - right se usa como ancho
// maximo de todos los bloques de texto del informe, y toda llamada a
// doc.text() de contenido variable (parrafos, nombres de empresa, fechas...)
// debe pasar ese `width` explicitamente: sin el, pdfkit no envuelve el texto
// y lo dibuja en una sola linea que se sale por el borde de la pagina.
const MARGENES_PDF = { top: 50, bottom: 50, left: 50, right: 50 };

// Cabecera comun (logo UIC, titulo, fecha, empresa detectada con su color
// corporativo, tipo de contrato y fecha del contrato, y linea separadora)
// para ambos informes; deja doc.y en la posicion donde empieza el cuerpo.
//
// meta = { empresa, tipo, fechaContrato }: los tres pueden venir vacios
// (documento sin empresa/tipo/fecha detectados), en cuyo caso se muestra un
// circulo gris, un badge "Tipo no detectado" y el texto "Fecha no detectada"
// respectivamente, en vez de omitir la fila.
function dibujarCabecera(doc, anchoUtil, titulo, meta = {}) {
  const { empresa, tipo, fechaContrato } = meta;
  const xInfo = doc.page.margins.left + 150;
  const anchoInfo = anchoUtil - 150;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, doc.page.margins.left, doc.page.margins.top, { width: 130 });
  }
  doc
    .fillColor(NEGRO)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(titulo, xInfo, doc.page.margins.top + 4, { width: anchoInfo });
  doc
    .fillColor(ROJO)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("UIC · Unidad de Inteligencia de Competencia", xInfo, doc.page.margins.top + 26, { width: anchoInfo });

  const fecha = new Intl.DateTimeFormat("es-ES", { dateStyle: "long", timeStyle: "short" }).format(new Date());
  doc
    .fillColor(GRIS)
    .font("Helvetica")
    .fontSize(9)
    .text(`Fecha del análisis: ${fecha}`, xInfo, doc.page.margins.top + 44, { width: anchoInfo });

  /* ---- Fila de metadatos del contrato: circulo de color corporativo +
     descripcion generica del color (nunca el nombre real de la empresa),
     badge Hogar/Negocio a la derecha ---- */
  const yMeta = doc.page.margins.top + 60;
  const infoEmpresa = colorEmpresa(empresa);
  const rCirculo = 5;
  const cxCirculo = xInfo + rCirculo;
  const cyCirculo = yMeta + 6;
  dibujarCirculoEmpresa(doc, cxCirculo, cyCirculo, rCirculo, infoEmpresa);

  const xEmpresa = xInfo + rCirculo * 2 + 8;
  const anchoBadgeTipo = 100;
  const anchoEmpresa = anchoInfo - (xEmpresa - xInfo) - anchoBadgeTipo - 10;
  doc
    .fillColor(NEGRO)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(infoEmpresa.etiqueta, xEmpresa, yMeta, { width: anchoEmpresa });

  const { fondo: fondoTipo, texto: textoTipo, etiqueta: etiquetaTipo } = colorTipoContrato(tipo);
  const xBadgeTipo = xInfo + anchoInfo - anchoBadgeTipo;
  doc.roundedRect(xBadgeTipo, yMeta - 3, anchoBadgeTipo, 17, 8).fillColor(fondoTipo).fill();
  doc
    .fillColor(textoTipo)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(etiquetaTipo, xBadgeTipo, yMeta + 1, { width: anchoBadgeTipo, align: "center" });

  /* ---- Fecha del propio contrato (distinta de la fecha del analisis) ---- */
  doc
    .fillColor(GRIS)
    .font("Helvetica")
    .fontSize(9)
    .text(`Fecha del contrato: ${fechaContrato || "Fecha no detectada"}`, xInfo, yMeta + 20, { width: anchoInfo });

  doc.moveTo(doc.page.margins.left, doc.page.margins.top + 100)
    .lineTo(doc.page.width - doc.page.margins.right, doc.page.margins.top + 100)
    .lineWidth(1.5)
    .strokeColor(ROJO)
    .stroke();

  // Reseteo defensivo de doc.x: la ultima llamada a .text() de arriba deja
  // el cursor en la columna junto al logo (xInfo), no en el margen
  // izquierdo. Cualquier .text() del cuerpo del informe que omita el
  // argumento x (llamada de la forma .text(str, {options})) heredaria esa
  // x en vez de partir del margen, desbordando el texto por la derecha.
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top + 115;
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
function generarInformePDF({ nombreArchivo, clausulas, puntuacionGlobal, nivel, conteosAnonimizacion, totalAnonimizado, empresa, tipo, fechaContrato }) {
  const doc = new PDFDocument({
    size: "A4",
    margins: MARGENES_PDF,
    bufferPages: true, // necesario para volver a paginas anteriores y anadir el pie de pagina
    info: { Title: "Informe de análisis de contrato - UIC" },
  });

  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  dibujarCabecera(doc, anchoUtil, "Informe de análisis de contrato", { empresa, tipo, fechaContrato });

  /* ---- Nota de anonimizacion ---- */
  doc
    .fillColor(GRIS)
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text(
      totalAnonimizado > 0
        ? `Antes de este análisis se anonimizaron automáticamente ${totalAnonimizado} dato(s) sensible(s) del documento original (nombres, DNI/NIE/NIF/CIF, direcciones, teléfonos, emails, datos bancarios y/o nombres de empresa). Este informe no contiene datos personales ni logotipos de terceros.`
        : "No se detectaron datos personales identificables en el documento. Este informe no contiene datos personales ni logotipos de terceros.",
      // x e y explicitos: sin ellos pdfkit interpreta la llamada como la
      // forma de 2 argumentos .text(str, options) y NO reposiciona doc.x,
      // heredando la x en la que quedo dibujarCabecera() (la columna de
      // texto junto al logo, no el margen izquierdo) — con el ancho
      // completo de la pagina (anchoUtil) eso desbordaba muy por la
      // derecha. Ver misma correccion en generarInformePDFAvanzado.
      doc.page.margins.left,
      doc.y,
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
    .text(`${puntuacionGlobal}/10`, doc.page.margins.left + 20, cajaY + 15, { width: 120, continued: false });

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
  doc.fillColor(NEGRO).font("Helvetica-Bold").fontSize(13).text("Cláusulas detectadas", doc.page.margins.left, doc.y, { width: anchoUtil });
  doc.moveDown(0.5);

  if (clausulas.length === 0) {
    doc
      .fillColor(GRIS)
      .font("Helvetica")
      .fontSize(10)
      .text("No se han detectado cláusulas de riesgo automáticamente. Revisa el documento completo manualmente.", doc.page.margins.left, doc.y, { width: anchoUtil });
  }

  clausulas.forEach((clausula) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();

    const inicioBloque = doc.y;
    const anchoLabel = anchoUtil - 60;
    // Altura real de la etiqueta con el ancho que va a ocupar: si es larga y
    // ocupa dos lineas, el bloque siguiente debe bajar en proporcion o la
    // descripcion se solapa visualmente con la segunda linea de la etiqueta.
    doc.font("Helvetica-Bold").fontSize(11);
    const altoLabel = doc.heightOfString(clausula.label, { width: anchoLabel });

    doc
      .fillColor(NEGRO)
      .text(clausula.label, doc.page.margins.left, inicioBloque, { width: anchoLabel });

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
    doc.y = inicioBloque + Math.max(altoLabel, 14) + 5;

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
function generarInformePDFAvanzado({ resumenGeneral, puntuacionGlobal, nivelGlobal, clausulas, totalAnonimizado, empresa, tipo, fechaContrato }) {
  const doc = new PDFDocument({
    size: "A4",
    margins: MARGENES_PDF,
    bufferPages: true,
    info: { Title: "Informe de análisis legal avanzado - UIC" },
  });

  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  dibujarCabecera(doc, anchoUtil, "Análisis legal avanzado del contrato", { empresa, tipo, fechaContrato });

  doc
    .fillColor(GRIS)
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text(
      (totalAnonimizado > 0
        ? `Antes de este análisis se anonimizaron automáticamente ${totalAnonimizado} dato(s) sensible(s) del documento original. `
        : "") +
        "Análisis elaborado con asistencia de inteligencia artificial (Claude, de Anthropic), basado en la Ley 5/2014 de Seguridad Privada, la LGDCU, la LCGC, el Código Civil español y el RGPD/LOPDGDD. Es un análisis orientativo y no sustituye el asesoramiento de un abogado colegiado.",
      // Ver comentario en generarInformePDF: x e y explicitos para que no
      // herede la x en la que quedo dibujarCabecera() y se salga por la
      // derecha con el ancho completo de la pagina.
      doc.page.margins.left,
      doc.y,
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
    .text(`${puntuacionGlobal}/10`, doc.page.margins.left + 20, cajaY + 15, { width: 120 });

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
  doc.fillColor(NEGRO).font("Helvetica-Bold").fontSize(13).text("Cláusulas analizadas", doc.page.margins.left, doc.y, { width: anchoUtil });
  doc.moveDown(0.5);

  if (clausulas.length === 0) {
    doc
      .fillColor(GRIS)
      .font("Helvetica")
      .fontSize(10)
      .text("El asistente no ha identificado cláusulas individuales. Revisa el documento completo manualmente.", doc.page.margins.left, doc.y, { width: anchoUtil });
  }

  const anchoBarra = 5;
  const anchoTexto = anchoUtil - anchoBarra - 12;

  clausulas.forEach((clausula) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();

    const inicioBloque = doc.y;
    const xTexto = doc.page.margins.left + anchoBarra + 12;
    const { color: colorBarra, etiqueta } = colorRiesgo(clausula.riesgo);
    const anchoTitulo = anchoTexto - 90;
    const tituloTexto = `Cláusula ${clausula.numero} · ${clausula.titulo}`;
    // Altura real del titulo con el ancho que va a ocupar: si es largo y
    // ocupa dos lineas, la explicacion debe bajar en proporcion o queda
    // solapada visualmente con la segunda linea del titulo.
    doc.font("Helvetica-Bold").fontSize(11);
    const altoTitulo = doc.heightOfString(tituloTexto, { width: anchoTitulo });

    doc
      .fillColor(NEGRO)
      .text(tituloTexto, xTexto, inicioBloque, { width: anchoTitulo });

    doc
      .fillColor(colorBarra)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(etiqueta, doc.page.width - doc.page.margins.right - 90, inicioBloque + 1, { width: 90, align: "right" });

    doc.x = xTexto;
    doc.y = inicioBloque + Math.max(altoTitulo, 14) + 5;
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
  extraerFechaContrato,
  detectarTipoContrato,
  detectarClausulas,
  analizarConIA,
  generarInformePDF,
  generarInformePDFAvanzado,
  dibujarCabecera,
  dibujarPiePagina,
  colorRiesgo,
  COLORES_PDF: { ROJO, ROJO_OSCURO, NEGRO, GRIS, GRIS_CLARO, BORDE, VERDE, AMARILLO, NARANJA },
  OcrNoDisponibleError,
  AnalisisAvanzadoError,
  MIME_PDF,
  MIME_DOCX,
  MIME_DOC,
  MIME_ODT,
  MIME_TXT,
  MIMES_IMAGEN,
};
