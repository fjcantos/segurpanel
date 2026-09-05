// sw.js — Service worker de SegurPanel.
//
// Objetivo: que la app siga abriendose y funcionando sin conexion una vez
// visitada. Estrategias:
//   - Navegaciones (abrir la app): red primero, con index.html cacheado como
//     respaldo -> siempre arranca, haya o no cobertura.
//   - Recursos estaticos del shell (iconos, manifest): cache primero.
//   - /api/*: solo red, nunca cache (el chat necesita respuesta real; si no
//     hay conexion se devuelve un JSON de error que la UI sabe mostrar).
//
// Al cambiar cualquier archivo cacheado hay que subir VERSION: eso crea una
// cache nueva y borra la anterior en el evento activate.

const VERSION = "v4";
const CACHE = `segurpanel-${VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./login.html",
  "./manifest.json",
  "./icons/icon-32.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll es todo-o-nada: si un icono fallara, no se instalaria el SW.
      // Se cachea uno a uno para que un fallo aislado no rompa la instalacion.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[SW] No se pudo cachear", url, err);
          })
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const nombres = await caches.keys();
      await Promise.all(
        nombres
          .filter((n) => n.startsWith("segurpanel-") && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

// Permite que la pagina active de inmediato una version nueva del SW.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function esApi(url) {
  return url.pathname.startsWith("/api/");
}

async function respuestaSinConexion(request) {
  const cache = await caches.open(CACHE);
  const guardada =
    (await cache.match(request)) ||
    (await cache.match("./index.html")) ||
    (await cache.match("./"));
  if (guardada) return guardada;
  return new Response("Sin conexión y sin copia en caché.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Red primero: intenta la red, guarda una copia y cae a la cache si falla.
async function redPrimero(event) {
  const cache = await caches.open(CACHE);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const respuesta = preload || (await fetch(event.request));
    if (respuesta && respuesta.ok && respuesta.type === "basic") {
      cache.put(event.request, respuesta.clone());
    }
    return respuesta;
  } catch (err) {
    return respuestaSinConexion(event.request);
  }
}

// Cache primero: sirve lo guardado y refresca en segundo plano.
async function cachePrimero(event) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(event.request);
  if (guardada) {
    event.waitUntil(
      (async () => {
        try {
          const fresca = await fetch(event.request);
          if (fresca && fresca.ok && fresca.type === "basic") {
            await cache.put(event.request, fresca.clone());
          }
        } catch (err) {
          /* sin conexion: se conserva la copia cacheada */
        }
      })()
    );
    return guardada;
  }
  try {
    const respuesta = await fetch(event.request);
    if (respuesta && respuesta.ok && respuesta.type === "basic") {
      cache.put(event.request, respuesta.clone());
    }
    return respuesta;
  } catch (err) {
    return respuestaSinConexion(event.request);
  }
}

// ---------- Notificaciones push (ver push.js y /api/push/* en server.js) ----------
//
// El payload lo manda el servidor como JSON: { titulo, cuerpo, etiqueta, url }.
// `etiqueta` (tag) hace que una segunda notificacion del mismo tipo (p.ej.
// dos avisos seguidos de "alianzas-pendientes") reemplace a la anterior en
// vez de amontonarse.
self.addEventListener("push", (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch (e) {
    datos = { titulo: "SegurPanel", cuerpo: event.data ? event.data.text() : "" };
  }

  const titulo = datos.titulo || "SegurPanel";
  const opciones = {
    body: datos.cuerpo || "",
    tag: datos.etiqueta || "segurpanel",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: datos.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

// Al hacer clic en la notificacion: si ya hay una pestana de SegurPanel
// abierta, la enfoca en vez de abrir una nueva.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    (async () => {
      const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const cliente of clientes) {
        if (new URL(cliente.url).origin === self.location.origin) {
          cliente.focus();
          if ("navigate" in cliente) cliente.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // POST /api/chat va siempre a la red

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // recursos de terceros
  if (esApi(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(redPrimero(event));
    return;
  }
  event.respondWith(cachePrimero(event));
});
