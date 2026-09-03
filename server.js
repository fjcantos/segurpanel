// server.js
//
// Servidor local para SegurPanel. Hace tres cosas:
//   1. Sirve index.html (la SPA) en http://localhost:PORT/
//   2. Sirve los estaticos de la PWA (manifest.json, sw.js e iconos), con los
//      tipos MIME y cabeceras que exige el navegador para instalarla.
//   3. Expone POST /api/chat, que reenvia la conversacion a la API real de
//      Anthropic usando la clave ANTHROPIC_API_KEY leida del entorno del
//      servidor. La clave NUNCA se envia al navegador ni se escribe en el
//      HTML: el navegador solo habla con este servidor local, y es este
//      servidor el que habla con Anthropic.
//
// Uso:
//   setx ANTHROPIC_API_KEY "sk-ant-..."   (una vez, y abrir una terminal nueva)
//   node server.js
//   -> abrir http://localhost:3000/ en el navegador
//
// No requiere "npm install": usa solo el modulo http y el fetch global de
// Node (Node 18+).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const INDEX_HTML_PATH = path.join(__dirname, "index.html");
const MAX_TURNOS_HISTORIAL = 12; // limita el contexto que se reenvia a la API
const MAX_LONGITUD_MENSAJE = 4000;

const SYSTEM_PROMPT = `Eres el asistente virtual de SegurPanel, una herramienta de comparación de alarmas y seguridad para el mercado español.

Tu ámbito de conocimiento es exclusivamente:
- Sistemas de alarma y seguridad para el hogar/negocio.
- Normativa española aplicable (Ley 5/2014 de Seguridad Privada, RD 195/2023, normas técnicas UNE-EN 50131 intrusión y UNE-EN 50136 transmisión, y RGPD/LOPDGDD cuando el sistema trata datos personales como vídeo o biometría).
- Equipos y ecosistemas Ajax y Jablotron (centrales, sensores, autonomía de batería, grados de seguridad EN 50131, conectividad).
- Argumentos de retención de clientes de Verisure: cómo evaluar ofertas de permanencia, descuentos de retención, y cómo un cliente puede negociar su continuidad o su baja.
- Comparativa de competencia en el sector de alarmas en España (Verisure, Sector Alarm, Sicor, Segurma, ADT, Seguridad 3D, Grupo Control, Trablisa, MPA/Prosegur): precios, permanencia, valoraciones y posicionamiento.

Responde siempre en español, de forma clara, concisa y práctica (evita párrafos largos; usa listas cuando ayude a la claridad). Si te preguntan algo fuera de este ámbito, indícalo brevemente y redirige la conversación hacia lo que sí puedes ayudar. No inventes precios, normativas o datos concretos que no conozcas con certeza: si no tienes el dato exacto, dilo explícitamente en vez de inventarlo.`;

function servirIndexHtml(res) {
  fs.readFile(INDEX_HTML_PATH, (err, contenido) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No se pudo leer index.html: " + err.message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(contenido);
  });
}

/* ---------- Estaticos de la PWA ---------- */

const TIPOS_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Solo estos archivos son publicos: evita exponer server.js, .git, etc.
const ESTATICOS_PERMITIDOS = new Set([
  "/manifest.json",
  "/sw.js",
  "/icons/icon-32.png",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
]);

function servirEstatico(rutaUrl, res) {
  const rutaArchivo = path.join(__dirname, rutaUrl);

  // Defensa adicional frente a path traversal.
  if (!rutaArchivo.startsWith(__dirname + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Prohibido");
    return;
  }

  fs.readFile(rutaArchivo, (err, contenido) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No encontrado");
      return;
    }

    const cabeceras = {
      "Content-Type": TIPOS_MIME[path.extname(rutaArchivo).toLowerCase()] || "application/octet-stream",
    };

    if (rutaUrl === "/sw.js") {
      // El service worker nunca se cachea: asi el navegador detecta versiones
      // nuevas. La cabecera Service-Worker-Allowed permite ampliar su ambito.
      cabeceras["Cache-Control"] = "no-cache, no-store, must-revalidate";
      cabeceras["Service-Worker-Allowed"] = "/";
    } else {
      cabeceras["Cache-Control"] = "no-cache";
    }

    res.writeHead(200, cabeceras);
    res.end(contenido);
  });
}

function leerCuerpoJSON(req) {
  return new Promise((resolve, reject) => {
    let datos = "";
    req.on("data", (chunk) => {
      datos += chunk;
      if (datos.length > 1e6) {
        reject(new Error("Cuerpo de la petición demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(datos ? JSON.parse(datos) : {});
      } catch (e) {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function sanearHistorial(mensajes) {
  if (!Array.isArray(mensajes)) return [];
  const limpio = mensajes
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_LONGITUD_MENSAJE),
    }));
  return limpio.slice(-MAX_TURNOS_HISTORIAL);
}

async function manejarChat(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  const mensajes = sanearHistorial(cuerpo.messages);
  if (mensajes.length === 0 || mensajes[mensajes.length - 1].role !== "user") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Falta el mensaje del usuario." }));
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error:
          "El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.",
      })
    );
    return;
  }

  try {
    const respuestaAnthropic = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: mensajes,
      }),
    });

    const datos = await respuestaAnthropic.json();

    if (!respuestaAnthropic.ok) {
      const mensajeError =
        (datos && datos.error && datos.error.message) ||
        `Error ${respuestaAnthropic.status} al llamar a la API de Anthropic.`;
      res.writeHead(respuestaAnthropic.status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: mensajeError }));
      return;
    }

    const texto = (datos.content || [])
      .filter((bloque) => bloque.type === "text")
      .map((bloque) => bloque.text)
      .join("\n")
      .trim();

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ reply: texto || "(Sin respuesta del modelo)" }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "No se pudo contactar con la API de Anthropic: " + e.message,
      })
    );
  }
}

const servidor = http.createServer((req, res) => {
  // Node descarta automaticamente el cuerpo en las respuestas a HEAD.
  const esLectura = req.method === "GET" || req.method === "HEAD";

  if (esLectura) {
    // Se ignora la query: los accesos directos del manifest usan /?tab=...
    const ruta = new URL(req.url, "http://localhost").pathname;
    if (ruta === "/" || ruta === "/index.html") {
      servirIndexHtml(res);
      return;
    }
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    manejarChat(req, res);
    return;
  }
  if (esLectura) {
    const rutaUrl = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (ESTATICOS_PERMITIDOS.has(rutaUrl)) {
      servirEstatico(rutaUrl, res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("No encontrado");
});

servidor.listen(PORT, () => {
  console.log(`SegurPanel escuchando en http://localhost:${PORT}/`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "AVISO: ANTHROPIC_API_KEY no está configurada. El IA Assistant no podrá responder hasta que la definas (setx ANTHROPIC_API_KEY \"sk-ant-...\") y reinicies este servidor."
    );
  }
});
