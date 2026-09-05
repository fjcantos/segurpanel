// push.js
//
// Notificaciones push web (Web Push API, protocolo VAPID): permiten avisar
// al usuario aunque no tenga SegurPanel abierto en el navegador. Se usan
// para dos casos (ver server.js):
//   - Alianzas nuevas pendientes de revisar -> solo super_admin y admin.
//   - Analisis de un contrato terminado -> el usuario que lo subio.
//
// Las claves VAPID (el par publica/privada que identifica a este servidor
// ante los navegadores, sin depender de un servicio de terceros como
// Firebase) se autogeneran la primera vez y se guardan en
// DIR_DATOS/.vapid-keys.json, con el mismo criterio que el secreto JWT en
// auth.js: sobreviven a reinicios sin invalidar las suscripciones ya
// guardadas. En un despliegue con varias instancias detras de un balanceador
// hay que fijar VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY como variables de
// entorno para que todas compartan el mismo par de claves.

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const db = require("./db");

function obtenerClavesVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }

  const rutaClaves = path.join(db.DIR_DATOS, ".vapid-keys.json");
  try {
    return JSON.parse(fs.readFileSync(rutaClaves, "utf8"));
  } catch (e) {
    const claves = webpush.generateVAPIDKeys();
    fs.mkdirSync(path.dirname(rutaClaves), { recursive: true });
    fs.writeFileSync(rutaClaves, JSON.stringify(claves), { mode: 0o600 });
    return claves;
  }
}

const VAPID_KEYS = obtenerClavesVapid();
webpush.setVapidDetails("mailto:fjose.cantos@verisure.es", VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

async function enviarASuscripcion(fila, payloadJSON) {
  const suscripcion = {
    endpoint: fila.endpoint,
    keys: { p256dh: fila.p256dh, auth: fila.auth },
  };
  try {
    await webpush.sendNotification(suscripcion, payloadJSON);
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      db.borrarSuscripcionPush(fila.endpoint);
    } else {
      console.error("Error enviando notificación push:", e.statusCode || e.message);
    }
  }
}

// datos: { titulo, cuerpo, etiqueta, url } -> lo interpreta sw.js en el
// evento 'push' (ver ese fichero).
async function enviarNotificacionAUsuario(userId, datos) {
  const suscripciones = db.listarSuscripcionesPorUsuario(userId);
  if (suscripciones.length === 0) return;
  const payloadJSON = JSON.stringify(datos);
  await Promise.all(suscripciones.map((s) => enviarASuscripcion(s, payloadJSON)));
}

async function enviarNotificacionARoles(roles, datos) {
  const suscripciones = db.listarSuscripcionesPorRoles(roles);
  if (suscripciones.length === 0) return;
  const payloadJSON = JSON.stringify(datos);
  await Promise.all(suscripciones.map((s) => enviarASuscripcion(s, payloadJSON)));
}

module.exports = {
  clavePublicaVapid: VAPID_KEYS.publicKey,
  enviarNotificacionAUsuario,
  enviarNotificacionARoles,
};
