# segurpanel
SegurPanel - App portátil para alarmas

## IA Assistant y Análisis Avanzado (API real de Anthropic)

El chat de la pestaña "IA Assistant" (modelo `claude-haiku-4-5-20251001`) y el
análisis legal cláusula por cláusula de la pestaña "Análisis Avanzado"
(modelo `claude-opus-5`) están conectados a la API real de Anthropic a través
de un pequeño servidor local (`server.js`) que mantiene la clave de API fuera
del navegador. El Análisis Avanzado se dispara automáticamente al subir un
contrato en la pestaña "Análisis": el asistente actúa como un abogado experto
en contratos de seguridad privada y derecho del consumidor español, y genera
un informe PDF UIC con el detalle de cada cláusula (explicación en lenguaje
sencillo, base legal aplicable y nivel de riesgo).

**1. Configura tu clave de API** (una sola vez; la clave nunca se guarda en
este repositorio ni se envía al navegador):

```
setx ANTHROPIC_API_KEY "sk-ant-tu-clave-aqui"
```

Abre una terminal nueva después de ejecutar `setx` para que la variable esté
disponible.

**2. Arranca el servidor:**

```
node server.js
```

o, equivalentemente:

```
npm start
```

**3. Abre la app** en `http://localhost:3000/` (no abras `index.html`
directamente con doble clic: el chat necesita hablar con `server.js`).

Si `ANTHROPIC_API_KEY` no está configurada, la app sigue funcionando pero el
chat y el Análisis Avanzado mostrarán un aviso pidiendo que la configures.

## Autenticación y gestión de usuarios

SegurPanel exige iniciar sesión antes de ver nada de la app. Solo se admiten
correos **@verisure.es**.

Archivos que lo implementan:

| Archivo | Función |
| --- | --- |
| `db.js` | Acceso a SQLite (`node:sqlite`, incorporado en Node — no requiere instalar ni compilar nada aparte). Tablas `users`, `access_requests`, `sessions`. |
| `auth.js` | Contraseñas (`bcryptjs`), sesiones JWT (`jsonwebtoken`), cookies, reglas de dominio/rol, bloqueo por intentos fallidos. |
| `login.html` | Pantalla de login + solicitud de acceso + cambio de contraseña obligatorio. |
| `admin.html` | Panel de gestión de usuarios (solo Super Admin). |
| `data/` (o `DATA_DIR`) | Base de datos y secretos locales. **No se sube a git** (ver `.gitignore`). |

### Persistencia de datos en Render (o cualquier PaaS de filesystem efímero)

Por defecto, la base de datos SQLite, el secreto JWT y el aviso del Super
Admin inicial se guardan en `./data`, dentro del propio directorio del
proyecto. En Render (y plataformas similares) ese directorio **se recrea en
cada despliegue**, así que sin más configuración perderías usuarios, sesiones
y solicitudes cada vez que despliegues.

Para evitarlo:

1. Monta un **disco persistente** en Render con punto de montaje `/data`.
2. Define la variable de entorno `DATA_DIR=/data`.

Con `DATA_DIR` definida, `db.js` y `auth.js` guardan ahí `segurpanel.db`,
`.jwt-secret` y `SUPER_ADMIN_INICIAL.txt`, y esos datos sobreviven a
despliegues y reinicios. Sin `DATA_DIR`, todo sigue funcionando igual que
antes usando `./data` local (uso en desarrollo).

### Primer arranque: Super Admin inicial

Al arrancar el servidor por primera vez (no existe todavía
`segurpanel.db` en `data/` o en `DATA_DIR`) se crea automáticamente la cuenta
**Super Admin** (`fjose.cantos@verisure.es`) con una **clave temporal
aleatoria**, que se imprime una sola vez por consola y se guarda en
`SUPER_ADMIN_INICIAL.txt` (dentro de `data/` o de `DATA_DIR`):

```
============================================================
 Super Admin inicial creado
 Correo:         fjose.cantos@verisure.es
 Clave temporal: xxxxxxxxxxxx
 ...
============================================================
```

Inicia sesión con esa clave temporal; la app te obligará a cambiarla antes de
dejarte entrar. Borra `SUPER_ADMIN_INICIAL.txt` después de usarla.

### Solicitud de acceso y aprobación

1. Cualquiera con un correo @verisure.es puede pedir acceso desde la pantalla
   de login (**"¿No tienes acceso? Solicítalo aquí"**).
2. El Super Admin ve la solicitud en `/admin`, elige un **rol** y aprueba: la
   app genera una **clave temporal** (o puedes escribir una a mano) que debes
   compartir con la persona por un canal seguro.
3. Esa persona inicia sesión con la clave temporal y la app le obliga a
   cambiarla en el primer acceso (mínimo 10 caracteres, con letra y número).

### Roles

| Rol | Acceso |
| --- | --- |
| **Super Admin** | Todo + gestión de usuarios (`/admin`): aprobar/rechazar solicitudes, cambiar roles, dar de alta/baja, asignar claves temporales. |
| **Admin** | Todo lo mismo que Super Admin **excepto** `/admin` (gestión de usuarios). |
| **Retención** | No tiene acceso a las pestañas de Análisis / Análisis Avanzado. El resto de pestañas, en **solo lectura** (los controles aparecen bloqueados con un aviso). Sí puede usar el IA Assistant. |

`/admin` solo es accesible para Super Admin; cualquier otra sesión que
intente entrar es redirigida a `/`.

### Sesiones y seguridad

- **Sesiones JWT** firmadas (HS256) guardadas en una cookie `httpOnly`,
  `SameSite=Lax` (y `Secure` automáticamente si la conexión es HTTPS). Cada
  sesión también se registra en la tabla `sessions` de SQLite para poder
  **revocarla** (logout, desactivar usuario, resetear contraseña) aunque el
  JWT en sí siga sin caducar.
- **Contraseñas con bcrypt** (`bcryptjs`, implementación en JS puro — sin
  compilar nada nativo).
- **Bloqueo por fuerza bruta**: 5 intentos fallidos bloquean la cuenta 15
  minutos.
- El secreto JWT se toma de la variable de entorno `JWT_SECRET`; si no está
  definida, se genera uno aleatorio la primera vez y se guarda en
  `data/.jwt-secret` para que las sesiones sobrevivan a reinicios del
  servidor. **En producción, define `JWT_SECRET` explícitamente.**

### HTTPS en producción

En local, `http://localhost` es válido (los navegadores tratan `localhost`
como contexto seguro). En producción **debes** servir SegurPanel por HTTPS:

- Opción A — certificados propios: define `HTTPS_CERT_FILE` y
  `HTTPS_KEY_FILE` (rutas a los ficheros `.pem`) y `server.js` levantará un
  servidor HTTPS directamente.
- Opción B (recomendada) — un proxy inverso (Nginx, Caddy, Cloudflare
  Tunnel...) que termine TLS delante de `node server.js`.

Si arrancas con `NODE_ENV=production` sin ninguna de las dos opciones
configuradas, el servidor lo avisa por consola al arrancar.

## App instalable (PWA) para móvil y tablet

SegurPanel es una **Progressive Web App**: se instala en la pantalla de inicio
del móvil o la tablet y, una vez visitada, **abre y funciona sin conexión**.

Archivos que lo hacen posible:

| Archivo | Función |
| --- | --- |
| `manifest.json` | Nombre, descripción, colores UIC (azul oscuro `#0b2545`), iconos y accesos directos. |
| `sw.js` | Service worker: cachea la app para el modo sin conexión. |
| `assets/LOGO_UIC_limpio.png` | Logo original (sello UIC). Fuente de todos los iconos. |
| `icons/` | Iconos PNG generados a partir del logo (32, 180, 192, 512 px, más las variantes *maskable* de Android en 192 y 512 con fondo navy). |
| `tools/generate-icons.js` | Regenera los iconos a partir del logo (`npm run icons`). Decodifica/recodifica PNG a mano — no necesita dependencias. |

### Cómo instalarla

1. Arranca el servidor (`npm start`) y abre la app en el móvil.
2. **Android / Chrome / Edge:** aparece automáticamente el botón verde
   **«Instalar app»** en la parte inferior. También sirve el menú
   *⋮ → Instalar aplicación*.
3. **iPhone / iPad (Safari):** Safari no permite el diálogo automático, así que
   la app muestra un aviso con los pasos: **Compartir → Añadir a pantalla de
   inicio**.

Una vez instalada, el botón deja de aparecer.

### Importante: probarla desde el móvil

Los service workers solo funcionan en un **contexto seguro**: `localhost` o
`https://`. Si abres la app desde el móvil por la IP local
(`http://192.168.x.x:3000`), la app se verá bien pero **no se registrará el
service worker ni se ofrecerá la instalación**.

Para probarla en un móvil real, expón el servidor por HTTPS con un túnel:

```
npm start
npx localtunnel --port 3000
```

y abre en el móvil la URL `https://...` que te devuelva.

### Modo sin conexión

- La interfaz, las pestañas, el comparador, ofertas, equipos y normativa
  funcionan **sin conexión**.
- El **IA Assistant necesita internet** (habla con la API de Anthropic a través
  de `server.js`); sin conexión avisa explícitamente en el chat.

Al modificar `index.html` o los iconos, sube `VERSION` en `sw.js` para que los
navegadores descarten la caché antigua.

## Alianzas: detección de acuerdos entre empresas de alarmas y otros sectores

La pestaña **"Alianzas"** muestra acuerdos y colaboraciones detectados entre
las empresas de alarmas comparadas en la app y compañías de otros sectores
(móviles, grandes superficies, seguros, inmobiliarias, suministros de luz/gas/
agua). Igual que en el Comparador y en Ofertas, la empresa de alarmas solo se
identifica por su **círculo de color corporativo**; el nombre solo aparece en
la leyenda privada, visible únicamente para el rol **Super Admin**.

### Flujo de moderación (pendiente → publicado)

1. `scraper_alianzas.py` (ver más abajo) detecta acuerdos y los envía a
   `POST /api/alianzas/sync`.
2. Cada alianza nueva entra en SQLite con estado `pending`. Solo el
   **Super Admin** la ve, en la sección "Pendientes de revisar" de la pestaña
   Alianzas, junto con un **punto rojo** en la propia pestaña.
3. El Super Admin decide, alianza por alianza:
   - **Publicar**: pasa a `published` y todos los roles la ven.
   - **Descartar**: pasa a `discarded` y desaparece definitivamente (no
     vuelve a proponerse aunque el scraper la detecte de nuevo).
4. El resto de roles (Admin, Retención) solo ven las alianzas ya publicadas;
   nunca ven el contenido pendiente ni el punto de notificación.

### Scraper en la Raspberry Pi (`scraper_alianzas.py`)

Script en Python (solo librería estándar, sin `pip install`) pensado para
ejecutarse a diario en una Raspberry Pi u otro equipo con cron:

- Busca en **Google News** (RSS público) menciones conjuntas de cada empresa
  de alarmas con compañías de los sectores vigilados (Movistar, Vodafone,
  Orange, MásMóvil · Carrefour, Leroy Merlin, El Corte Inglés, MediaMarkt ·
  Mapfre, AXA, Allianz, Generali · idealista, Fotocasa, pisos.com · Endesa,
  Iberdrola, Naturgy, Repsol).
- Opcionalmente también revisa **webs oficiales / salas de prensa** que
  configures en el diccionario `SALAS_PRENSA` dentro del script (vacío por
  defecto: añade ahí las URLs reales que quieras vigilar).
- Guarda en un fichero de cache local (`alianzas_cache.json`, junto al
  script) lo que ya detectó en ejecuciones anteriores, para enviar solo lo
  que cambia de un día a otro.
- Si hay alianzas nuevas, las envía a SegurPanel vía `POST
  /api/alianzas/sync`, autenticado con un secreto compartido (no con sesión
  de usuario, porque quien llama no es un navegador).

**Configuración en el servidor (SegurPanel):**

```
setx SCRAPER_TOKEN "un-secreto-largo-y-aleatorio"
```

**Configuración en la Raspberry Pi** (variables de entorno para el cron, con
el mismo valor de `SCRAPER_TOKEN`):

```
SEGURPANEL_SYNC_URL=https://tu-app.onrender.com/api/alianzas/sync
SEGURPANEL_SCRAPER_TOKEN=un-secreto-largo-y-aleatorio
```

**Cron a las 07:00 todos los días** (`crontab -e`):

```
0 7 * * * SEGURPANEL_SYNC_URL="https://tu-app.onrender.com/api/alianzas/sync" SEGURPANEL_SCRAPER_TOKEN="un-secreto-largo-y-aleatorio" /usr/bin/python3 /home/pi/segurpanel/scraper_alianzas.py >> /home/pi/segurpanel/scraper_alianzas.log 2>&1
```

Sin `SCRAPER_TOKEN` definida en el servidor, `POST /api/alianzas/sync`
responde `503` y rechaza cualquier envío (evita dejar el endpoint abierto por
descuido).
