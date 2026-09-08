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
// 15-20 diapositivas con titulo+puntos+notas por diapositiva es bastante mas
// contenido que un informe de analisis avanzado por clausulas; con 8000 el
// JSON se cortaba a mitad de generacion (stop_reason "max_tokens") y
// JSON.parse fallaba con "No se pudo interpretar la respuesta del
// asistente" aunque la llamada a la API fuese correcta. 16000 iguala el
// presupuesto ya usado en analisis.js (MAX_TOKENS_ANALISIS_AVANZADO) para
// generaciones estructuradas igual de largas.
const MAX_TOKENS_FORMACION = 16000;
// La formacion "completa" por compañia (25-30 diapositivas, con notas de
// moderador de 4 campos en cada una: guion, preguntas, timing y consejo
// pedagogico) es mas del doble de contenido estructurado que el resto de
// tipos; con MAX_TOKENS_FORMACION se cortaba a mitad de los modulos finales
// (roleplays/ejercicios). Se dobla el presupuesto solo para este tipo.
const MAX_TOKENS_FORMACION_COMPLETA = 32000;

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

const TIPOS_VALIDOS = ["competencia", "tecnicas", "objeciones", "normativa", "comparativa", "casos", "completa"];

// Catalogo cerrado de temas de busqueda en Unsplash (en ingles, mejor
// resultado en su buscador): la IA elige el que mejor encaje por
// diapositiva en vez de escribir texto libre, para que las consultas sean
// siempre relevantes y, sobre todo, para que la cache de obtenerImagenUnsplash
// (ver mas abajo) tenga muchas menos combinaciones distintas que descargar.
const TEMAS_UNSPLASH = [
  "cybersecurity",
  "home alarm security system",
  "business negotiation meeting",
  "customer service call center",
  "handshake business deal",
  "modern office team",
  "legal law book",
  "success achievement mountain",
  "smartphone technology network",
  "modern house exterior",
  "money finance euro",
  "security camera surveillance",
];

// Iconos de Heroicons v2 (outline, MIT, Tailwind Labs) - solo el <path>
// interior, descargado y verificado desde
// raw.githubusercontent.com/tailwindlabs/heroicons antes de implementar
// esto (ninguna ruta inventada). Se envuelven en un <svg> propio en
// iconoDataUri() con el color y el grosor de trazo que haga falta.
const ICONOS_SVG = {
  "shield-check": '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"/>',
  "lock-closed": '<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/>',
  "bell-alert": '<path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0M3.124 7.5A8.969 8.969 0 0 1 5.292 3m13.416 0a8.969 8.969 0 0 1 2.168 4.5"/>',
  phone: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"/>',
  "chat-bubble-left-right": '<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/>',
  "chart-bar": '<path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"/>',
  users: '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"/>',
  "light-bulb": '<path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/>',
  "exclamation-triangle": '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/>',
  "check-circle": '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>',
  scale: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z"/>',
  home: '<path stroke-linecap="round" stroke-linejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"/>',
  "building-office-2": '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z"/>',
  "academic-cap": '<path stroke-linecap="round" stroke-linejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5"/>',
  star: '<path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>',
  megaphone: '<path stroke-linecap="round" stroke-linejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102.069a18.03 18.03 0 0 1-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 0 1 8.835 2.535M10.34 6.66a23.847 23.847 0 0 0 8.835-2.535m0 0A23.74 23.74 0 0 0 18.795 3m.38 1.125a23.91 23.91 0 0 1 1.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 0 0 1.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 0 1 0 3.46"/>',
  banknotes: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z"/>',
  "arrow-trending-up": '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18 9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941"/>',
  clock: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>',
  "document-text": '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/>',
  "hand-raised": '<path stroke-linecap="round" stroke-linejoin="round" d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m.002 0h-.002"/>',
  wifi: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"/>',
  "cpu-chip": '<path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z"/>',
  "video-camera": '<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>',
  trophy: '<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0"/>',
};

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
  "Genera entre 15 y 20 diapositivas en total (incluida una diapositiva de título al principio y una de cierre al final). Varía el campo 'tipo' de cada diapositiva (usa 'cita' para intercalar 1-2 citas de los expertos mencionados, y 'comparativa' cuando aplique) para que la presentación no sea monótona. Sé conciso en cada diapositiva: 'puntos' con 3-5 bullets cortos (máximo una frase cada uno) y 'notas' con un guion breve de 2-4 frases, no un párrafo largo — es una presentación de alto impacto, no un documento denso. En cada diapositiva (salvo las de tipo 'comparativa'), elige el valor de 'tema' cuyo significado en inglés mejor ilustre el contenido de esa diapositiva concreta (no repitas siempre el mismo) y el valor de 'icono' que mejor represente su idea principal.";

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
          tipo: {
            type: "string",
            enum: ["titulo", "contenido", "comparativa", "cita", "cierre", "roleplay", "ejercicio", "infografia"],
          },
          titulo: { type: "string", description: "Título de la diapositiva, máximo 10 palabras." },
          puntos: {
            type: "array",
            items: { type: "string" },
            description:
              "Puntos/bullets de la diapositiva (guion, argumentos...). En diapositivas 'comparativa' puede ir vacío si se usa 'tabla'. En 'cita' el primer elemento es la cita textual. En 'roleplay' cada elemento es una línea de diálogo con el prefijo literal 'Cliente:' o 'Agente:'. En 'ejercicio' puede ir vacío (el contenido va en 'pregunta'/'respuesta'). En 'infografia' son EXACTAMENTE 5 elementos con el formato 'Título corto: explicación breve (máximo 12 palabras)'.",
          },
          tabla: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            description:
              "Solo para diapositivas tipo 'comparativa': filas de una tabla, la primera fila es la cabecera. Todas las filas con el mismo número de columnas.",
          },
          autor: { type: "string", description: "Solo para diapositivas tipo 'cita': a quién se atribuye (p.ej. 'Zig Ziglar')." },
          pregunta: { type: "string", description: "Solo para diapositivas tipo 'ejercicio': enunciado del caso o dilema práctico." },
          respuesta: { type: "string", description: "Solo para diapositivas tipo 'ejercicio': respuesta modelo/correcta, breve y accionable." },
          notas: { type: "string", description: "Notas del orador: guion detallado de qué decir exactamente en esta diapositiva." },
          notasPreguntas: {
            type: "array",
            items: { type: "string" },
            description: "1-2 preguntas para lanzar al grupo durante esta diapositiva, para fomentar la participación.",
          },
          notasTiming: { type: "string", description: "Timing sugerido para esta diapositiva, p.ej. '3 minutos'." },
          notasConsejo: {
            type: "string",
            description: "Consejo pedagógico breve para quien presenta (cómo dinamizarla, qué evitar, cómo reconducir al grupo).",
          },
          tema: {
            type: "string",
            enum: TEMAS_UNSPLASH,
            description:
              "Tema de la foto de fondo (en inglés, para buscar en Unsplash) que mejor ilustre esta diapositiva. No se usa en diapositivas tipo 'comparativa', 'ejercicio' ni 'infografia'.",
          },
          icono: {
            type: "string",
            enum: Object.keys(ICONOS_SVG),
            description: "Icono que mejor represente la idea principal de esta diapositiva.",
          },
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

async function generarSlidesConIA({ system, mensaje, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new FormacionError("El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.");
  }
  const presupuestoTokens = maxTokens || MAX_TOKENS_FORMACION;

  const respuesta = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO_FORMACIONES,
      max_tokens: presupuestoTokens,
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

  // Si la respuesta se corta por limite de tokens, bloqueTexto.text es JSON
  // incompleto y JSON.parse falla mas abajo: se detecta aqui explicitamente
  // para dar un mensaje claro (en vez de "no se pudo interpretar") y para
  // que quede registrado en el log del servidor cual fue la causa real.
  if (datos.stop_reason === "max_tokens") {
    console.error(
      `Formaciones: respuesta de Anthropic truncada por max_tokens (${presupuestoTokens}). Texto recibido: ${bloqueTexto.text.length} caracteres.`
    );
    throw new FormacionError(
      "La formación generada era demasiado larga y se ha cortado antes de terminar. Inténtalo de nuevo; si se repite, prueba con una formación más corta."
    );
  }

  // output_config.format:"json_schema" deberia garantizar JSON puro sin
  // markdown, pero se limpia por si acaso el modelo lo envuelve en un bloque
  // de codigo ```json ... ``` (visto ocasionalmente en otras integraciones):
  // barato de comprobar y evita un falso "no se pudo interpretar".
  let textoJSON = bloqueTexto.text.trim();
  if (textoJSON.startsWith("```")) {
    textoJSON = textoJSON.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  let resultado;
  try {
    resultado = JSON.parse(textoJSON);
  } catch (e) {
    console.error(
      `Formaciones: JSON.parse falló (${e.message}). stop_reason=${datos.stop_reason}. Fin del texto recibido: ${textoJSON.slice(-300)}`
    );
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

En cada diapositiva de motivo, los 'puntos' deben incluir el guion exacto en 3-5 bullets cortos y accionables (máximo una frase cada uno): qué decir (puedes usar el formato "Di: ..." para la frase literal), cómo decirlo (tono, ritmo, actitud) y qué ofrecer como contrapartida. Sé conciso: 'notas' con un guion breve de 2-3 frases, no un párrafo largo. Elige también 'tema' (para la foto de fondo) e 'icono' que mejor encajen con cada motivo de baja.`,
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

function promptFormacionCompleta({ empresa, filaComparador, equipo, alianzas }) {
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
    maxTokens: MAX_TOKENS_FORMACION_COMPLETA,
    mensaje: `Crea la formación interna COMPLETA para el equipo de retención/ventas de Verisure sobre "${empresa}", pensada para impartirse en sesión presencial u online con un formador y un grupo de agentes. Debe ser exhaustiva y 100% accionable, no un resumen.

${datosComparador}
${datosEquipo}
${datosAlianzas}

Usa estos datos como base real y no los contradigas; para todo lo demás (historia, posicionamiento de marca, debilidades operativas o comerciales, argumentario) apóyate en tu conocimiento experto del sector español de alarmas.

Genera EXACTAMENTE entre 25 y 30 diapositivas en total, organizadas estrictamente en este orden:

1. Una diapositiva tipo 'titulo' de portada, con "${empresa}" en el título o subtítulo.
2. MÓDULO 1 — Quiénes son: 3-4 diapositivas tipo 'contenido' (historia y fundación, presencia territorial y volumen de mercado en España, posicionamiento de marca).
3. MÓDULO 2 — Su oferta comercial: 3-4 diapositivas tipo 'contenido' o 'comparativa' (precios orientativos, gama de equipos/tecnología, condiciones de permanencia y cancelación).
4. MÓDULO 3 — Sus puntos fuertes y débiles: 2-3 diapositivas tipo 'contenido' que separen con claridad fortalezas reales de debilidades explotables en una llamada.
5. MÓDULO 4 — Cómo rebatirles en una llamada de retención: 3-4 diapositivas tipo 'contenido' con argumentario específico y frases concretas frente a esta empresa.
6. MÓDULO 5 — RolePlays interactivos: EXACTAMENTE 3 escenarios distintos entre sí con un cliente difícil (por ejemplo: cliente que ya ha firmado con ${empresa}, cliente que solo compara precio y amenaza con irse, cliente enfadado que exige la baja inmediata). Cada escenario ocupa 2 diapositivas seguidas: primero una 'contenido' con el contexto del cliente, su actitud y el objetivo del roleplay; después una 'roleplay' con el diálogo completo en 'puntos', alternando líneas con el prefijo literal "Cliente:" y "Agente:", mostrando cómo el agente aplica correctamente técnicas de retención.
7. MÓDULO 6 — Ejercicios prácticos con respuestas: 2-3 diapositivas tipo 'ejercicio', cada una con 'pregunta' (un caso o dilema realista sobre ${empresa}) y 'respuesta' (la respuesta modelo correcta, breve y accionable).
8. Cierra con UNA última diapositiva tipo 'infografia': título "Ficha resumen: ${empresa}", y en 'puntos' EXACTAMENTE 5 elementos con el formato "Título corto: explicación breve (máximo 12 palabras)" con los 5 datos que un agente debe recordar de memoria sobre ${empresa} en mitad de una llamada. No incluyas 'notas' extensas en esta diapositiva (es una ficha para imprimir y repartir, no se presenta con guion oral).

NOTAS DEL MODERADOR (obligatorias en TODAS las diapositivas salvo la 'infografia' final): el campo 'notas' debe ser un guion detallado de qué decir exactamente en esa diapositiva (frases que el formador pueda leer o parafrasear en voz alta, no un resumen esquemático). Añade además 'notasPreguntas' con 1-2 preguntas concretas para lanzar al grupo y fomentar el debate, 'notasTiming' con el tiempo sugerido para esa diapositiva (p.ej. "3 minutos"), y 'notasConsejo' con un consejo pedagógico breve y práctico (cómo dinamizarla, qué evitar, cómo reconducir si el grupo se dispersa o si sale un caso real distinto al planteado).

Elige en cada diapositiva de 'contenido', 'roleplay' y 'cita' el valor de 'tema' (foto de fondo) y 'icono' que mejor la representen, variando entre diapositivas.`,
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
    case "completa": {
      if (!EMPRESAS_COMPETENCIA.includes(empresa)) {
        throw new FormacionError("Empresa no válida.");
      }
      const alianzas = db.listarAlianzasPorEstado("published").filter((a) => a.empresaAlarma === empresa);
      return generarSlidesConIA(
        promptFormacionCompleta({ empresa, filaComparador: ctx.filaComparador, equipo: ctx.equipo, alianzas })
      );
    }
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

// Envuelve el <path> de un icono de Heroicons (ver ICONOS_SVG) en un <svg>
// propio con el color de trazo que haga falta, y lo pasa a base64 para
// addImage. Sin red, sin sharp: es SVG puro. pptxgenjs ya rasteriza el SVG a
// PNG de respaldo por si acaso (comprobado en pruebas antes de implementar
// esto), asi que se ve bien tambien en PowerPoint mas antiguos.
function iconoDataUri(nombre, colorHex) {
  const pathInterior = ICONOS_SVG[nombre];
  if (!pathInterior) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#${colorHex}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${pathInterior}</svg>`;
  return "image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// Insignia circular (fondo de color + icono blanco encima) junto al titulo
// de una diapositiva, para "destacar puntos clave". Si el tipo de icono no
// esta en ICONOS_SVG (o la IA no lo ha rellenado), no dibuja nada: nunca
// debe romper la generacion por un campo opcional ausente.
function dibujarIconoBadge(slide, icono, x, y, diametro, colorFondo) {
  if (!icono || !ICONOS_SVG[icono]) return;
  slide.addShape("ellipse", { x, y, w: diametro, h: diametro, fill: { color: colorFondo }, line: { type: "none" } });
  const dataUri = iconoDataUri(icono, "FFFFFF");
  const inset = diametro * 0.24;
  slide.addImage({ data: dataUri, x: x + inset, y: y + inset, w: diametro - inset * 2, h: diametro - inset * 2 });
}

/* ================================================================
   5b. Imagenes de fondo (API publica de Unsplash)
   ================================================================ */
//
// Catalogo cerrado de temas (TEMAS_UNSPLASH): la IA elige uno por
// diapositiva y aqui se resuelve a una imagen real. Cache en memoria por
// tema, viva mientras el proceso este arrancado - con 12 temas fijos, en el
// peor de los casos son 12 descargas por arranque del servidor, no por
// presentacion generada (importante: el plan gratuito de Unsplash limita a
// 50 peticiones/hora). Sin UNSPLASH_ACCESS_KEY, o si Unsplash falla por
// cualquier motivo, se devuelve null y la diapositiva se genera igual pero
// sin foto de fondo (nunca debe romper la generacion completa).

const UNSPLASH_API_URL = "https://api.unsplash.com/photos/random";
const cacheImagenesUnsplash = new Map();
let avisoUnsplashMostrado = false;

async function obtenerImagenUnsplash(tema) {
  if (!tema) return null;
  if (cacheImagenesUnsplash.has(tema)) return cacheImagenesUnsplash.get(tema);

  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    if (!avisoUnsplashMostrado) {
      console.warn(
        "AVISO: UNSPLASH_ACCESS_KEY no está configurada. Las formaciones se generarán sin imágenes de fondo hasta que la definas."
      );
      avisoUnsplashMostrado = true;
    }
    return null;
  }

  try {
    const url = `${UNSPLASH_API_URL}?query=${encodeURIComponent(tema)}&orientation=landscape&client_id=${accessKey}`;
    const respuesta = await fetch(url);
    if (!respuesta.ok) {
      const cuerpoError = await respuesta.text().catch(() => "");
      console.error(
        `Unsplash: error ${respuesta.status} buscando imagen para "${tema}".${cuerpoError ? " Respuesta: " + cuerpoError : ""}`
      );
      return null;
    }
    const foto = await respuesta.json();
    const urlImagen = foto && foto.urls && (foto.urls.regular || foto.urls.small);
    if (!urlImagen) return null;

    const respuestaImagen = await fetch(urlImagen);
    if (!respuestaImagen.ok) return null;
    const bufferOriginal = Buffer.from(await respuestaImagen.arrayBuffer());
    // Igual que con el logo: sin redimensionar/comprimir, 15-20 fotos a
    // resolucion original inflarian el .pptx a decenas de MB.
    const bufferOptimizado = await sharp(bufferOriginal).resize({ width: 1000 }).jpeg({ quality: 72 }).toBuffer();

    const resultado = {
      dataUri: "image/jpeg;base64," + bufferOptimizado.toString("base64"),
      autor: (foto.user && foto.user.name) || null,
    };
    cacheImagenesUnsplash.set(tema, resultado);

    // Condiciones de uso de Unsplash: notificar el "download" cuando la foto
    // se usa realmente (no solo al listarla). Fire-and-forget: nunca debe
    // bloquear ni poder romper la generacion de la formacion.
    const urlTracking = foto.links && foto.links.download_location;
    if (urlTracking) {
      const separador = urlTracking.includes("?") ? "&" : "?";
      fetch(`${urlTracking}${separador}client_id=${accessKey}`).catch(() => {});
    }

    return resultado;
  } catch (e) {
    console.error(`Unsplash: error buscando/descargando imagen para "${tema}":`, e.message || e);
    return null;
  }
}

// Imagen de fondo a pantalla completa + overlay oscuro (30% de opacidad,
// transparency:70 en pptxgenjs) + un panel algo mas opaco (60%) detras del
// bloque de texto, para que el texto sea legible incluso sobre fotos claras
// sin oscurecer toda la imagen. colorOverlay permite un lavado de color de
// marca (rojo en cierre, negro en titulo) en vez de gris neutro.
function pintarFondoConImagen(slide, imagenFondo, colorOverlay, transparenciaGlobal) {
  slide.addImage({
    data: imagenFondo.dataUri,
    x: 0,
    y: 0,
    w: 10,
    h: 5.625,
    sizing: { type: "cover", w: 10, h: 5.625 },
  });
  slide.addShape("rect", {
    x: 0,
    y: 0,
    w: "100%",
    h: "100%",
    fill: { color: colorOverlay, transparency: transparenciaGlobal },
    line: { type: "none" },
  });
}

function pintarPanelTexto(slide, x, y, w, h) {
  slide.addShape("rect", { x, y, w, h, fill: { color: NEGRO_UIC, transparency: 40 }, line: { type: "none" } });
}

function pintarCreditoUnsplash(slide, imagenFondo, colorTexto) {
  if (!imagenFondo || !imagenFondo.autor) return;
  slide.addText(`Foto: ${imagenFondo.autor} · Unsplash`, {
    x: 0.3,
    y: 5.34,
    w: 5,
    h: 0.2,
    fontFace: FUENTE_UIC,
    fontSize: 6.5,
    italic: true,
    color: colorTexto,
  });
}

function anadirCabeceraComun(slide, logoDataUri) {
  slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.13, fill: { color: ROJO_UIC }, line: { type: "none" } });
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 8.55, y: 0.22, w: 1.1, h: 0.62 });
  }
}

function anadirPie(slide, numero, total, colorTexto) {
  slide.addText(`SegurPanel · Formación UIC   ·   ${numero}/${total}`, {
    x: 0.4,
    y: 5.32,
    w: 6,
    h: 0.25,
    fontFace: FUENTE_UIC,
    fontSize: 8,
    color: colorTexto || GRIS_UIC,
  });
}

// Junta 'notas' (guion) con los 3 campos opcionales de la formacion
// "completa" (preguntas al grupo, timing, consejo pedagogico) en un unico
// texto para las notas del orador del .pptx. En los demas tipos de
// formacion esos 3 campos vienen vacios y el resultado es igual a d.notas.
function notasCompletas(d) {
  const partes = [];
  if (d.notas) partes.push(d.notas.trim());
  if (d.notasPreguntas && d.notasPreguntas.length) {
    partes.push("Preguntas para el grupo:\n" + d.notasPreguntas.map((p) => `- ${p}`).join("\n"));
  }
  if (d.notasTiming) partes.push(`Timing sugerido: ${d.notasTiming}`);
  if (d.notasConsejo) partes.push(`Consejo pedagógico: ${d.notasConsejo}`);
  return partes.join("\n\n");
}

function anadirNotas(slide, d) {
  const texto = notasCompletas(d);
  if (texto) slide.addNotes(texto);
}

function diapositivaTitulo(pptx, d, numero, total, subtitulo, logoDataUri, imagenFondo) {
  const slide = pptx.addSlide();
  if (imagenFondo) {
    // Lavado de color de marca (negro) mas fuerte que en las diapositivas de
    // contenido: aqui la foto es un fondo de impacto, no algo sobre lo que
    // hay que leer un bloque largo de texto.
    pintarFondoConImagen(slide, imagenFondo, NEGRO_UIC, 35);
  } else {
    slide.background = { color: NEGRO_UIC };
  }
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
  anadirNotas(slide, d);
  pintarCreditoUnsplash(slide, imagenFondo, "D1D5DB");
  anadirPie(slide, numero, total, imagenFondo ? "D1D5DB" : GRIS_UIC);
}

function diapositivaCierre(pptx, d, numero, total, logoDataUri, imagenFondo) {
  const slide = pptx.addSlide();
  if (imagenFondo) {
    pintarFondoConImagen(slide, imagenFondo, ROJO_UIC, 35);
  } else {
    slide.background = { color: ROJO_UIC };
  }
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
  anadirNotas(slide, d);
  pintarCreditoUnsplash(slide, imagenFondo, "FBD5D5");
}

function diapositivaCita(pptx, d, numero, total, logoDataUri, imagenFondo) {
  const slide = pptx.addSlide();
  const colorTexto = imagenFondo ? BLANCO_UIC : NEGRO_UIC;
  const colorAutor = imagenFondo ? BLANCO_UIC : ROJO_UIC;

  if (imagenFondo) {
    pintarFondoConImagen(slide, imagenFondo, NEGRO_UIC, 70);
    pintarPanelTexto(slide, 0.5, 0.9, 9.0, 3.5);
  } else {
    slide.background = { color: BLANCO_UIC };
  }
  anadirCabeceraComun(slide, logoDataUri);
  slide.addText('"', {
    x: 0.4,
    y: 1.0,
    w: 1.2,
    h: 1.2,
    fontFace: FUENTE_UIC,
    fontSize: 80,
    bold: true,
    color: imagenFondo ? ROJO_UIC : GRIS_CLARO_UIC,
  });
  const cita = (d.puntos && d.puntos[0]) || d.titulo;
  slide.addText(cita, {
    x: 1.0,
    y: 1.6,
    w: 8.0,
    h: 2.0,
    fontFace: FUENTE_UIC,
    fontSize: 22,
    italic: true,
    color: colorTexto,
    align: "left",
    valign: "middle",
  });
  slide.addText(`— ${d.autor || "Anónimo"}`, {
    x: 1.0,
    y: 3.7,
    w: 8.0,
    h: 0.5,
    fontFace: FUENTE_UIC,
    fontSize: 14,
    bold: true,
    color: colorAutor,
    align: "right",
  });
  anadirNotas(slide, d);
  pintarCreditoUnsplash(slide, imagenFondo, "D1D5DB");
  anadirPie(slide, numero, total, imagenFondo ? "D1D5DB" : GRIS_UIC);
}

function diapositivaComparativa(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  anadirCabeceraComun(slide, logoDataUri);
  const tieneIcono = d.icono && ICONOS_SVG[d.icono];
  dibujarIconoBadge(slide, d.icono, 0.4, 0.26, 0.5, ROJO_UIC);
  slide.addText(d.titulo, {
    x: tieneIcono ? 1.05 : 0.4,
    y: 0.32,
    w: tieneIcono ? 8.55 : 7.9,
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
  anadirNotas(slide, d);
  anadirPie(slide, numero, total);
}

function diapositivaContenido(pptx, d, numero, total, logoDataUri, imagenFondo) {
  const slide = pptx.addSlide();
  const modoFoto = !!imagenFondo;
  const colorTitulo = modoFoto ? BLANCO_UIC : ROJO_UIC;
  const colorTexto = modoFoto ? BLANCO_UIC : NEGRO_UIC;

  if (modoFoto) {
    pintarFondoConImagen(slide, imagenFondo, NEGRO_UIC, 70);
    pintarPanelTexto(slide, 0.3, 0.95, 9.4, 4.05);
  } else {
    slide.background = { color: BLANCO_UIC };
  }
  anadirCabeceraComun(slide, logoDataUri);

  const tieneIcono = d.icono && ICONOS_SVG[d.icono];
  const tituloX = tieneIcono ? 1.05 : 0.4;
  dibujarIconoBadge(slide, d.icono, 0.4, modoFoto ? 1.1 : 0.28, 0.5, ROJO_UIC);

  slide.addText(d.titulo, {
    x: tituloX,
    y: modoFoto ? 1.15 : 0.32,
    w: 10 - tituloX - 0.4,
    h: 0.6,
    fontFace: FUENTE_UIC,
    fontSize: 22,
    bold: true,
    color: colorTitulo,
  });
  if (!modoFoto) {
    slide.addShape("rect", { x: 0.42, y: 0.98, w: 1.1, h: 0.05, fill: { color: NEGRO_UIC }, line: { type: "none" } });
  }

  const puntos = d.puntos && d.puntos.length ? d.puntos : ["—"];
  slide.addText(
    puntos.map((p) => ({ text: p, options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 10 } })),
    {
      x: 0.5,
      y: modoFoto ? 1.9 : 1.25,
      w: 9.0,
      h: modoFoto ? 3.0 : 3.8,
      fontFace: FUENTE_UIC,
      fontSize: 15,
      color: colorTexto,
      valign: "top",
    }
  );
  anadirNotas(slide, d);
  pintarCreditoUnsplash(slide, imagenFondo, "D1D5DB");
  anadirPie(slide, numero, total, modoFoto ? "D1D5DB" : GRIS_UIC);
}

// Diapositiva de dialogo simulado (Modulo 5, "completa"): mismo layout que
// diapositivaContenido pero coloreando cada linea segun su prefijo literal
// "Cliente:"/"Agente:" (ver promptFormacionCompleta), para que el dialogo se
// lea como una conversacion real y no como una lista de bullets neutra.
function diapositivaRoleplay(pptx, d, numero, total, logoDataUri, imagenFondo) {
  const slide = pptx.addSlide();
  const modoFoto = !!imagenFondo;
  const colorTitulo = modoFoto ? BLANCO_UIC : ROJO_UIC;

  if (modoFoto) {
    pintarFondoConImagen(slide, imagenFondo, NEGRO_UIC, 75);
    pintarPanelTexto(slide, 0.3, 0.95, 9.4, 4.05);
  } else {
    slide.background = { color: BLANCO_UIC };
  }
  anadirCabeceraComun(slide, logoDataUri);
  dibujarIconoBadge(slide, d.icono || "chat-bubble-left-right", 0.4, modoFoto ? 1.1 : 0.28, 0.5, ROJO_UIC);

  slide.addText(d.titulo, {
    x: 1.05,
    y: modoFoto ? 1.15 : 0.32,
    w: 8.55,
    h: 0.6,
    fontFace: FUENTE_UIC,
    fontSize: 22,
    bold: true,
    color: colorTitulo,
  });
  if (!modoFoto) {
    slide.addShape("rect", { x: 0.42, y: 0.98, w: 1.1, h: 0.05, fill: { color: NEGRO_UIC }, line: { type: "none" } });
  }

  const lineas = d.puntos && d.puntos.length ? d.puntos : ["—"];
  const colorCliente = modoFoto ? BLANCO_UIC : GRIS_UIC;
  const colorAgente = modoFoto ? "FBD5D5" : ROJO_UIC;
  slide.addText(
    lineas.map((linea) => {
      const esAgente = /^agente:/i.test(linea.trim());
      return {
        text: linea,
        options: {
          color: esAgente ? colorAgente : colorCliente,
          bold: esAgente,
          breakLine: true,
          paraSpaceAfter: 9,
        },
      };
    }),
    {
      x: 0.5,
      y: modoFoto ? 1.9 : 1.25,
      w: 9.0,
      h: modoFoto ? 3.0 : 3.8,
      fontFace: FUENTE_UIC,
      fontSize: 13.5,
      valign: "top",
    }
  );
  anadirNotas(slide, d);
  pintarCreditoUnsplash(slide, imagenFondo, "D1D5DB");
  anadirPie(slide, numero, total, modoFoto ? "D1D5DB" : GRIS_UIC);
}

// Diapositiva de ejercicio con respuesta (Modulo 6, "completa"): pregunta
// arriba, respuesta modelo destacada en un panel aparte debajo (para que el
// formador pueda taparla/revelarla en pantalla si presenta en vivo). Sin
// foto de fondo: aqui prima la legibilidad del enunciado y la respuesta.
function diapositivaEjercicio(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  anadirCabeceraComun(slide, logoDataUri);
  dibujarIconoBadge(slide, d.icono || "light-bulb", 0.4, 0.28, 0.5, ROJO_UIC);
  slide.addText(d.titulo, {
    x: 1.05,
    y: 0.32,
    w: 8.55,
    h: 0.55,
    fontFace: FUENTE_UIC,
    fontSize: 20,
    bold: true,
    color: ROJO_UIC,
  });
  slide.addShape("rect", { x: 0.42, y: 0.98, w: 1.1, h: 0.05, fill: { color: NEGRO_UIC }, line: { type: "none" } });

  slide.addText("EJERCICIO", {
    x: 0.5, y: 1.15, w: 9.0, h: 0.3, fontFace: FUENTE_UIC, fontSize: 11, bold: true, color: GRIS_UIC,
  });
  slide.addText(d.pregunta || (d.puntos && d.puntos[0]) || "—", {
    x: 0.5, y: 1.45, w: 9.0, h: 1.4, fontFace: FUENTE_UIC, fontSize: 16, color: NEGRO_UIC, valign: "top",
  });

  slide.addShape("rect", { x: 0.5, y: 3.0, w: 9.0, h: 1.9, fill: { color: GRIS_CLARO_UIC }, line: { color: ROJO_UIC, width: 1 } });
  slide.addText("RESPUESTA MODELO", {
    x: 0.7, y: 3.15, w: 8.6, h: 0.3, fontFace: FUENTE_UIC, fontSize: 11, bold: true, color: ROJO_UIC,
  });
  slide.addText(d.respuesta || "—", {
    x: 0.7, y: 3.45, w: 8.6, h: 1.3, fontFace: FUENTE_UIC, fontSize: 13.5, color: NEGRO_UIC, valign: "top",
  });

  anadirNotas(slide, d);
  anadirPie(slide, numero, total);
}

// Infografia final (ultima diapositiva de "completa"): ficha de una sola
// pagina pensada para imprimirse y repartirse, con los 5 puntos clave en
// formato "Titulo: detalle" (ver promptFormacionCompleta) como tarjetas
// numeradas. Sin foto de fondo ni panel semitransparente: debe imprimirse
// nitida en blanco y negro si hace falta.
function diapositivaInfografia(pptx, d, numero, total, logoDataUri) {
  const slide = pptx.addSlide();
  slide.background = { color: BLANCO_UIC };
  slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.9, fill: { color: ROJO_UIC }, line: { type: "none" } });
  if (logoDataUri) slide.addImage({ data: logoDataUri, x: 8.55, y: 0.14, w: 1.1, h: 0.62 });
  slide.addText(d.titulo, {
    x: 0.4, y: 0.1, w: 7.9, h: 0.45, fontFace: FUENTE_UIC, fontSize: 20, bold: true, color: BLANCO_UIC,
  });
  slide.addText("Ficha imprimible · Reparte esta diapositiva al equipo", {
    x: 0.4, y: 0.52, w: 7.9, h: 0.3, fontFace: FUENTE_UIC, fontSize: 11, italic: true, color: "FBD5D5",
  });

  const puntos = (d.puntos && d.puntos.length ? d.puntos : []).slice(0, 5);
  const yInicio = 1.15;
  const alturaFila = 0.85;
  puntos.forEach((punto, i) => {
    const y = yInicio + i * alturaFila;
    const idx = punto.indexOf(":");
    const tituloPunto = idx > -1 ? punto.slice(0, idx).trim() : `Punto ${i + 1}`;
    const detalle = idx > -1 ? punto.slice(idx + 1).trim() : punto;

    slide.addShape("ellipse", { x: 0.5, y: y + 0.05, w: 0.55, h: 0.55, fill: { color: ROJO_UIC }, line: { type: "none" } });
    slide.addText(String(i + 1), {
      x: 0.5, y: y + 0.05, w: 0.55, h: 0.55, align: "center", valign: "middle",
      fontFace: FUENTE_UIC, fontSize: 20, bold: true, color: BLANCO_UIC,
    });
    slide.addText(tituloPunto, {
      x: 1.25, y, w: 8.15, h: 0.32, fontFace: FUENTE_UIC, fontSize: 14, bold: true, color: NEGRO_UIC,
    });
    slide.addText(detalle, {
      x: 1.25, y: y + 0.32, w: 8.15, h: 0.45, fontFace: FUENTE_UIC, fontSize: 12, color: GRIS_UIC, valign: "top",
    });
  });

  anadirNotas(slide, d);
}

async function construirPPTX({ tituloPresentacion, subtitulo, diapositivas }) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = tituloPresentacion || "Formación SegurPanel · UIC";
  pptx.author = "SegurPanel";
  pptx.company = "UIC";

  const logoDataUri = await obtenerLogoDataUri();

  // Resuelve en paralelo solo los TEMAS UNICOS presentes en esta
  // presentacion concreta (catalogo cerrado de 12, ver TEMAS_UNSPLASH):
  // nunca una peticion a Unsplash por diapositiva.
  const temasUnicos = [...new Set(diapositivas.map((d) => d.tema).filter(Boolean))];
  const entradasImagenes = await Promise.all(
    temasUnicos.map(async (tema) => [tema, await obtenerImagenUnsplash(tema)])
  );
  const imagenesPorTema = new Map(entradasImagenes);

  const total = diapositivas.length;
  diapositivas.forEach((d, i) => {
    const numero = i + 1;
    const imagenFondo = d.tema ? imagenesPorTema.get(d.tema) || null : null;
    switch (d.tipo) {
      case "titulo":
        diapositivaTitulo(pptx, d, numero, total, subtitulo, logoDataUri, imagenFondo);
        break;
      case "cierre":
        diapositivaCierre(pptx, d, numero, total, logoDataUri, imagenFondo);
        break;
      case "cita":
        diapositivaCita(pptx, d, numero, total, logoDataUri, imagenFondo);
        break;
      case "comparativa":
        diapositivaComparativa(pptx, d, numero, total, logoDataUri);
        break;
      case "roleplay":
        diapositivaRoleplay(pptx, d, numero, total, logoDataUri, imagenFondo);
        break;
      case "ejercicio":
        diapositivaEjercicio(pptx, d, numero, total, logoDataUri);
        break;
      case "infografia":
        diapositivaInfografia(pptx, d, numero, total, logoDataUri);
        break;
      default:
        diapositivaContenido(pptx, d, numero, total, logoDataUri, imagenFondo);
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
