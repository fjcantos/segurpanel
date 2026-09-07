// formaciones.js
//
// Genera presentaciones PPTX de formación interna (retención/ventas) con la
// API de Anthropic, para la pestaña "Formaciones". Sigue el mismo patrón que
// analisis.js (analizarConIA + generarInformePDFAvanzado): una llamada a
// Claude con la respuesta forzada a un JSON Schema, y una funcion que
// construye el fichero binario final (aqui .pptx con pptxgenjs en vez de
// .pdf con pdfkit) a partir de ese JSON.
//
// Los 6 tipos de formacion comparten UN UNICO schema de diapositivas
// generico (ver ESQUEMA_FORMACION) para no mantener 6 esquemas casi
// identicos; lo que cambia por tipo es el prompt (system + mensaje) y, en
// "competencia" y "comparativa", el contexto real que ya tiene el cliente en
// pantalla (datos del Comparador, ficha de equipos, alianzas publicadas...)
// para que la IA no invente cifras que contradigan lo que ya se muestra en
// el resto de la app.

const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const db = require("./db");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODELO_FORMACIONES = "claude-opus-5";
const MAX_TOKENS_FORMACION = 8000;

const LOGO_PATH = path.join(__dirname, "assets", "LOGO_UIC_limpio.png");

const ROJO_UIC = "E8003D";
const NEGRO_UIC = "111111";
const BLANCO_UIC = "FFFFFF";
const GRIS_UIC = "6B7280";
const GRIS_CLARO_UIC = "F2F2F2";
const FUENTE_UIC = "Fira Sans";

const EMPRESAS_COMPETENCIA = [
  "Sector Alarm",
  "Sicor",
  "Segurma",
  "ADT",
  "Seguridad 3D",
  "Grupo Control",
  "Trablisa",
  "MPA/Prosegur",
];

const TIPOS_VALIDOS = ["competencia", "tecnicas", "objeciones", "normativa", "comparativa", "casos"];

// Solo se usa si el cliente no envia contexto.motivos (no deberia pasar en
// uso normal: el frontend ya lee los .chat-chip del IA Assistant), para que
// el endpoint nunca falle por falta de datos.
const MOTIVOS_BAJA_POR_DEFECTO = [
  "Me voy a vivir a otro lado",
  "Me han robado y la alarma no funcionó",
  "Es muy caro",
  "No la uso nunca",
  "Me voy al extranjero",
  "Me han ofrecido algo mejor",
  "Problemas económicos",
  "No estoy satisfecho con el servicio",
  "Me separo/divorcio",
  "Fallecimiento del titular",
  "Vendo la casa/piso",
  "La competencia es más barata",
];

class FormacionError extends Error {}

/* ================================================================
   1. Persona de IA compartida y schema generico de diapositivas
   ================================================================ */

const PERSONA_FORMADOR = `Eres un formador experto en retención de clientes y ventas, con más de 20 años de experiencia en el sector de la seguridad privada y las alarmas en España. Dominas las técnicas de los mejores formadores y vendedores del mundo: Zig Ziglar (venta con integridad y superación de objeciones), Brian Tracy (psicología de la venta), SPIN Selling de Neil Rackham (preguntas de Situación, Problema, Implicación y Necesidad-beneficio), la metodología Challenger Sale (enseñar, adaptar y tomar el control de la conversación), y las técnicas de negociación del Programa de Negociación de Harvard (separar a las personas del problema, centrarse en intereses no en posiciones, generar opciones de beneficio mutuo).

Aplicas también psicología del consumidor, programación neurolingüística (PNL) y comunicación persuasiva para diseñar formaciones de alto impacto, prácticas y accionables para agentes de retención y ventas del sector de alarmas en España.

Generas el contenido de una presentación de PowerPoint, diapositiva por diapositiva, siempre en español, con un tono profesional, cercano y motivador. Cada diapositiva debe aportar valor real y accionable, nunca relleno genérico. Nunca inventes datos concretos (precios, cifras, normativa) que contradigan los que se te faciliten en el mensaje.`;

const INSTRUCCION_LONGITUD =
  "Genera entre 15 y 20 diapositivas en total (incluida una diapositiva de título al principio y una de cierre al final). Varía el campo 'tipo' de cada diapositiva (usa 'cita' para intercalar 1-2 citas de los expertos mencionados, y 'comparativa' cuando aplique) para que la presentación no sea monótona. Usa siempre 'notas' para dar al formador un guion ampliado de qué decir en cada diapositiva.";

const ESQUEMA_FORMACION = {
  type: "object",
  properties: {
    tituloPresentacion: { type: "string", description: "Título principal de la presentación, máximo 8 palabras." },
    subtitulo: { type: "string", description: "Subtítulo breve, una frase." },
    diapositivas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tipo: { type: "string", enum: ["titulo", "contenido", "comparativa", "cita", "cierre"] },
          titulo: { type: "string", description: "Título de la diapositiva, máximo 10 palabras." },
          puntos: {
            type: "array",
            items: { type: "string" },
            description:
              "Puntos/bullets de la diapositiva (guion, argumentos, líneas de diálogo...). En diapositivas 'comparativa' puede ir vacío si se usa 'tabla'. En 'cita' el primer elemento es la cita textual.",
          },
          tabla: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            description:
              "Solo para diapositivas tipo 'comparativa': filas de una tabla, la primera fila es la cabecera. Todas las filas con el mismo número de columnas.",
          },
          autor: { type: "string", description: "Solo para diapositivas tipo 'cita': a quién se atribuye (p.ej. 'Zig Ziglar')." },
          notas: { type: "string", description: "Notas del orador: guion ampliado o contexto adicional para quien presenta." },
        },
        required: ["tipo", "titulo", "puntos"],
        additionalProperties: false,
      },
    },
  },
  required: ["tituloPresentacion", "subtitulo", "diapositivas"],
  additionalProperties: false,
};

/* ================================================================
   2. Llamada a la API de Anthropic (mismo patron que analizarConIA)
   ================================================================ */

async function generarSlidesConIA({ system, mensaje }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new FormacionError("El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.");
  }

  const respuesta = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO_FORMACIONES,
      max_tokens: MAX_TOKENS_FORMACION,
      system,
      messages: [{ role: "user", content: mensaje }],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: ESQUEMA_FORMACION },
      },
    }),
  });

  const datos = await respuesta.json();
  if (!respuesta.ok) {
    const mensajeError =
      (datos && datos.error && datos.error.message) || `Error ${respuesta.status} al llamar a la API de Anthropic.`;
    throw new FormacionError(mensajeError);
  }

  const bloqueTexto = (datos.content || []).find((b) => b.type === "text");
  if (!bloqueTexto) throw new FormacionError("El asistente no ha devuelto una formación interpretable.");

  let resultado;
  try {
    resultado = JSON.parse(bloqueTexto.text);
  } catch (e) {
    throw new FormacionError("No se pudo interpretar la respuesta del asistente.");
  }
  if (!Array.isArray(resultado.diapositivas)) resultado.diapositivas = [];
  return resultado;
}

/* ================================================================
   3. Prompts por tipo de formacion
   ================================================================ */

function promptCompetencia({ empresa, filaComparador, equipo, alianzas }) {
  const datosComparador = filaComparador
    ? `Datos orientativos del Comparador de SegurPanel para ${empresa}: precio desde ${filaComparador.precioMin ?? "—"} €/mes, permanencia mínima ${filaComparador.permanenciaMeses ?? "—"} meses, valoración ${filaComparador.valoracion ?? "—"}/5.`
    : `No hay datos del Comparador disponibles para ${empresa}.`;

  const datosEquipo = equipo
    ? `Equipos que utiliza ${empresa} según ficha técnica interna: marca ${equipo.marca || "no divulgada"}. Conectividad: ${equipo.conectividad || "—"}. Dispositivos: ${(equipo.equipos || []).map((e) => `${e.tipo}: ${e.desc}`).join("; ") || "—"}.`
    : `No hay ficha de equipos disponible para ${empresa}.`;

  const datosAlianzas =
    alianzas && alianzas.length
      ? `Alianzas/acuerdos publicados de ${empresa}: ${alianzas.map((a) => `${a.socio} (${a.sector}${a.tipoAcuerdo ? ", " + a.tipoAcuerdo : ""})`).join("; ")}.`
      : `No hay alianzas publicadas conocidas de ${empresa} en este momento.`;

  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación tipo "battlecard" para el equipo de retención/ventas de Verisure titulada "Conoce a tu competencia: ${empresa}". Debe cubrir en profundidad: quiénes son, qué ofrecen, sus puntos débiles reales, cómo rebatirlos en una llamada, sus alianzas actuales y qué equipos/tecnología usan.

${datosComparador}
${datosEquipo}
${datosAlianzas}

Usa estos datos como base real y no los contradigas; para todo lo demás (posicionamiento de marca, debilidades operativas o comerciales, argumentario de venta frente a ellos) apóyate en tu conocimiento experto del sector español de alarmas. ${INSTRUCCION_LONGITUD}`,
  };
}

function promptTecnicas() {
  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación titulada "Técnicas maestras de retención" con las mejores técnicas de retención de clientes basadas en libros y expertos mundiales de la venta y la negociación. Cubre obligatoriamente: empatía y escucha activa, la técnica del reencuadre (reframing), gestión profesional de objeciones (incluye el ciclo completo de la objeción), la técnica del espejo (mirroring) y el método LAER (Listen, Acknowledge, Explore, Respond) explicado paso a paso con ejemplos aplicados a una llamada de baja de alarmas. ${INSTRUCCION_LONGITUD}`,
  };
}

function promptObjeciones({ motivos }) {
  const lista = motivos && motivos.length ? motivos : MOTIVOS_BAJA_POR_DEFECTO;
  const listaTexto = lista.map((m, i) => `${i + 1}. ${m}`).join("\n");

  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación titulada "Rebate cada motivo de baja" para agentes de retención. Estructura obligatoria: 1 diapositiva de título, 1-2 diapositivas de introducción sobre la psicología de la objeción y las fases para rebatirla, EXACTAMENTE una diapositiva por cada uno de los siguientes motivos de baja (en el mismo orden, sin omitir ninguno, con 'titulo' igual al motivo correspondiente), y termina con 1 diapositiva de cierre motivacional:

${listaTexto}

En cada diapositiva de motivo, los 'puntos' deben incluir el guion exacto en frases cortas y accionables: qué decir (puedes usar el formato "Di: ..." para las frases literales), cómo decirlo (tono, ritmo, actitud) y qué ofrecer como contrapartida.`,
  };
}

function promptNormativa() {
  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación titulada "Normativa que te protege" dirigida a agentes de retención de alarmas en España, explicando cómo usar a su favor, de forma ética y legal, la normativa española aplicable durante una llamada de retención: Ley 5/2014 de Seguridad Privada, Real Decreto Legislativo 1/2007 (LGDCU), Ley 7/1998 de Condiciones Generales de la Contratación, Código Civil español, y RGPD/LOPDGDD. Para cada norma relevante, explica en lenguaje sencillo qué dice, qué implica para el contrato de alarma del cliente (p.ej. plazos de permanencia, derecho de desistimiento, condiciones de cancelación) y cómo el agente puede apoyarse en ella para argumentar la retención, siempre sin faltar a la verdad ni presionar de forma indebida. ${INSTRUCCION_LONGITUD}`,
  };
}

function promptComparativa({ filasComparador, priceData, marginData }) {
  const tablaTexto = (filasComparador || [])
    .map((f) => (Array.isArray(f) ? f.join(" | ") : String(f)))
    .join("\n");
  const preciosTexto = (priceData || []).map((d) => `${d.label}: ${d.value} €/mes`).join("; ");
  const margenesTexto = (marginData || []).map((d) => `${d.label}: ${d.value}`).join("; ");

  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación titulada "Verisure vs competencia" con una comparativa completa y persuasiva a favor de Verisure, usando estos datos reales de SegurPanel (no inventes cifras distintas a estas):

Tabla comparativa del Comparador (Empresa | Instalación | Cuota mensual | Permanencia | Equipos incluidos | Valoración):
${tablaTexto || "(sin datos)"}

Precios medios orientativos de Inteligencia (€/mes): ${preciosTexto || "(sin datos)"}
Datos de margen/posicionamiento de Inteligencia: ${margenesTexto || "(sin datos)"}

Usa varias diapositivas de tipo "comparativa" con el campo 'tabla' (cabecera + filas) para presentar comparativas claras criterio a criterio (precio, permanencia, tecnología, atención al cliente, tiempo de respuesta...), siempre resaltando por qué Verisure gana en valor total aunque no sea la opción más barata. ${INSTRUCCION_LONGITUD}`,
  };
}

function promptCasos() {
  return {
    system: PERSONA_FORMADOR,
    mensaje: `Crea una formación titulada "Casos prácticos" con simulaciones de llamadas reales de retención con los clientes más difíciles (por ejemplo: el cliente enfadado que amenaza con denunciar, el cliente que ya ha firmado con la competencia, el cliente mayor confundido, el cliente que exige hablar con un superior, el cliente que usa el silencio como presión). Para cada caso, incluye una diapositiva con el contexto del cliente y 1-2 diapositivas con el diálogo simulado completo, usando 'puntos' con líneas alternadas con el prefijo "Cliente:" y "Agente:", mostrando cómo el agente aplica correctamente las técnicas de retención. ${INSTRUCCION_LONGITUD}`,
  };
}

/* ================================================================
   4. Dispatcher: tipo -> prompt (+ contexto real de servidor cuando aplica)
   ================================================================ */

async function generarFormacion({ tipo, empresa, contexto }) {
  const ctx = contexto || {};

  switch (tipo) {
    case "competencia": {
      if (!EMPRESAS_COMPETENCIA.includes(empresa)) {
        throw new FormacionError("Empresa no válida.");
      }
      const alianzas = db.listarAlianzasPorEstado("published").filter((a) => a.empresaAlarma === empresa);
      return generarSlidesConIA(
        promptCompetencia({ empresa, filaComparador: ctx.filaComparador, equipo: ctx.equipo, alianzas })
      );
    }
    case "tecnicas":
      return generarSlidesConIA(promptTecnicas());
    case "objeciones":
      return generarSlidesConIA(promptObjeciones({ motivos: ctx.motivos }));
    case "normativa":
      return generarSlidesConIA(promptNormativa());
    case "comparativa":
      return generarSlidesConIA(
        promptComparativa({ filasComparador: ctx.filasComparador, priceData: ctx.priceData, marginData: ctx.marginData })
      );
    case "casos":
      return generarSlidesConIA(promptCasos());
    default:
      throw new FormacionError("Tipo de formación no válido.");
  }
}

/* ================================================================
   5. Construccion del PPTX (marca UIC: rojo Verisure, negro, blanco,
      Fira Sans, logo en cada diapositiva)
   ================================================================ */
//
// pptxgenjs no embebe la fuente en el .pptx, solo referencia el nombre; si
// el ordenador donde se abre no tiene "Fira Sans" instalada, PowerPoint
// sustituye por una fuente por defecto (limitacion del formato/libreria, no
// de esta implementacion).
//
// El logo original pesa ~1.2MB; pptxgenjs no deduplica imagenes repetidas
// entre diapositivas, asi que incrustarlo tal cual en cada una de las 15-20
// diapositivas generaria un .pptx de decenas de MB. Se redimensiona UNA vez
// con sharp (ya es dependencia del proyecto) a un ancho suficiente para
// verse nitido en pantalla/proyector y se cachea en memoria como data URI
// base64, reutilizado en todas las diapositivas de esa generacion.
let logoDataUriCache = null;
async function obtenerLogoDataUri() {
  if (logoDataUriCache !== null) return logoDataUriCache;
  if (!fs.existsSync(LOGO_PATH)) {
    logoDataUriCache = false;
    return false;
  }
  const buffer = await sharp(LOGO_PATH).resize({ width: 360 }).png({ compressionLevel: 9 }).toBuffer();
  logoDataUriCache = "image/png;base64," + buffer.toString("base64");
  return logoDataUriCache;
}

function anadirCabeceraComun(slide, logoDataUri) {
  slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.13, fill: { color: ROJO_UIC }, line: { type: "none" } });
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 8.55, y: 0.22, w: 1.1, h: 0.62 });
  }
}

function anadirPie(slide, numero, total) {
  slide.addText(`SegurPanel · Formación UIC   ·   ${numero}/${total}`, {
    x: 0.4,
    y: 5.32,
    w: 6,
    h: 0.25,
    fontFace: FUENTE_UIC,
    fontSize: 8,
    color: GRIS_UIC,
  });
}

function diapositivaTitulo(pptx, d, numero, total, subtitulo, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: NEGRO_UIC };
  slide.addShape("rect", { x: 0, y: 2.55, w: "100%", h: 0.06, fill: { color: ROJO_UIC }, line: { type: "none" } });
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 4.15, y: 0.55, w: 1.7, h: 0.96 });
  }
  slide.addText(d.titulo, {
    x: 0.6,
    y: 1.9,
    w: 8.8,
    h: 0.9,
    align: "center",
    fontFace: FUENTE_UIC,
    fontSize: 30,
    bold: true,
    color: BLANCO_UIC,
  });
  const sub = (d.puntos && d.puntos[0]) || subtitulo || "";
  if (sub) {
    slide.addText(sub, {
      x: 0.6,
      y: 2.85,
      w: 8.8,
      h: 0.6,
      align: "center",
      fontFace: FUENTE_UIC,
      fontSize: 15,
      color: ROJO_UIC,
    });
  }
  if (d.notas) slide.addNotes(d.notas);
  anadirPie(slide, numero, total);
}

function diapositivaCierre(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: ROJO_UIC };
  slide.addText(d.titulo, {
    x: 0.6,
    y: 1.7,
    w: 8.8,
    h: 0.9,
    align: "center",
    fontFace: FUENTE_UIC,
    fontSize: 28,
    bold: true,
    color: BLANCO_UIC,
  });
  const texto = (d.puntos || []).join("   ·   ");
  if (texto) {
    slide.addText(texto, {
      x: 0.8,
      y: 2.7,
      w: 8.4,
      h: 1.6,
      align: "center",
      fontFace: FUENTE_UIC,
      fontSize: 14,
      color: BLANCO_UIC,
    });
  }
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 4.15, y: 4.3, w: 1.7, h: 0.96 });
  }
  if (d.notas) slide.addNotes(d.notas);
}

function diapositivaCita(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  anadirCabeceraComun(slide, logoDataUri);
  slide.addText('"', { x: 0.4, y: 1.0, w: 1.2, h: 1.2, fontFace: FUENTE_UIC, fontSize: 80, bold: true, color: GRIS_CLARO_UIC });
  const cita = (d.puntos && d.puntos[0]) || d.titulo;
  slide.addText(cita, {
    x: 1.0,
    y: 1.6,
    w: 8.0,
    h: 2.2,
    fontFace: FUENTE_UIC,
    fontSize: 22,
    italic: true,
    color: NEGRO_UIC,
    align: "left",
    valign: "middle",
  });
  slide.addText(`— ${d.autor || "Anónimo"}`, {
    x: 1.0,
    y: 3.9,
    w: 8.0,
    h: 0.5,
    fontFace: FUENTE_UIC,
    fontSize: 14,
    bold: true,
    color: ROJO_UIC,
    align: "right",
  });
  if (d.notas) slide.addNotes(d.notas);
  anadirPie(slide, numero, total);
}

function diapositivaComparativa(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  anadirCabeceraComun(slide, logoDataUri);
  slide.addText(d.titulo, {
    x: 0.4,
    y: 0.32,
    w: 7.9,
    h: 0.55,
    fontFace: FUENTE_UIC,
    fontSize: 20,
    bold: true,
    color: ROJO_UIC,
  });

  if (d.tabla && d.tabla.length > 0) {
    const filas = d.tabla.map((fila, i) =>
      fila.map((celda) => ({
        text: String(celda ?? ""),
        options:
          i === 0
            ? { bold: true, color: BLANCO_UIC, fill: { color: ROJO_UIC }, fontSize: 11 }
            : { color: NEGRO_UIC, fill: { color: i % 2 === 0 ? GRIS_CLARO_UIC : BLANCO_UIC }, fontSize: 10.5 },
      }))
    );
    slide.addTable(filas, {
      x: 0.4,
      y: 1.05,
      w: 9.2,
      fontFace: FUENTE_UIC,
      border: { type: "solid", color: "E5E7EB", pt: 0.5 },
      autoPage: false,
    });
  } else if (d.puntos && d.puntos.length > 0) {
    slide.addText(d.puntos.map((p) => ({ text: p, options: { bullet: true, breakLine: true } })), {
      x: 0.5,
      y: 1.1,
      w: 9.0,
      h: 3.9,
      fontFace: FUENTE_UIC,
      fontSize: 14,
      color: NEGRO_UIC,
    });
  }
  if (d.notas) slide.addNotes(d.notas);
  anadirPie(slide, numero, total);
}

function diapositivaContenido(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  anadirCabeceraComun(slide, logoDataUri);
  slide.addText(d.titulo, {
    x: 0.4,
    y: 0.32,
    w: 7.9,
    h: 0.6,
    fontFace: FUENTE_UIC,
    fontSize: 22,
    bold: true,
    color: ROJO_UIC,
  });
  slide.addShape("rect", { x: 0.42, y: 0.98, w: 1.1, h: 0.05, fill: { color: NEGRO_UIC }, line: { type: "none" } });

  const puntos = d.puntos && d.puntos.length ? d.puntos : ["—"];
  slide.addText(
    puntos.map((p) => ({ text: p, options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 10 } })),
    {
      x: 0.5,
      y: 1.25,
      w: 9.0,
      h: 3.8,
      fontFace: FUENTE_UIC,
      fontSize: 15,
      color: NEGRO_UIC,
      valign: "top",
    }
  );
  if (d.notas) slide.addNotes(d.notas);
  anadirPie(slide, numero, total);
}

async function construirPPTX({ tituloPresentacion, subtitulo, diapositivas }) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = tituloPresentacion || "Formación SegurPanel · UIC";
  pptx.author = "SegurPanel";
  pptx.company = "UIC";

  const logoDataUri = await obtenerLogoDataUri();
  const total = diapositivas.length;
  diapositivas.forEach((d, i) => {
    const numero = i + 1;
    switch (d.tipo) {
      case "titulo":
        diapositivaTitulo(pptx, d, numero, total, subtitulo, logoDataUri);
        break;
      case "cierre":
        diapositivaCierre(pptx, d, numero, total, logoDataUri);
        break;
      case "cita":
        diapositivaCita(pptx, d, numero, total, logoDataUri);
        break;
      case "comparativa":
        diapositivaComparativa(pptx, d, numero, total, logoDataUri);
        break;
      default:
        diapositivaContenido(pptx, d, numero, total, logoDataUri);
    }
  });

  return pptx.write({ outputType: "nodebuffer" });
}

module.exports = {
  generarFormacion,
  construirPPTX,
  FormacionError,
  TIPOS_VALIDOS,
  EMPRESAS_COMPETENCIA,
};
