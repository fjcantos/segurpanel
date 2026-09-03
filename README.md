# segurpanel
SegurPanel - App portátil para alarmas

## IA Assistant (API real de Anthropic)

El chat de la pestaña "IA Assistant" está conectado a la API real de Anthropic
(modelo `claude-haiku-4-5-20251001`) a través de un pequeño servidor local
(`server.js`) que mantiene la clave de API fuera del navegador.

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
chat mostrará un aviso pidiendo que la configures.

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
| `data/` | Base de datos y secretos locales. **No se sube a git** (ver `.gitignore`). |

### Primer arranque: Super Admin inicial

Al arrancar el servidor por primera vez (`data/segurpanel.db` no existe
todavía) se crea automáticamente la cuenta **Super Admin**
(`fjose.cantos@verisure.es`) con una **clave temporal aleatoria**, que se
imprime una sola vez por consola y se guarda en
`data/SUPER_ADMIN_INICIAL.txt`:

```
============================================================
 Super Admin inicial creado
 Correo:         fjose.cantos@verisure.es
 Clave temporal: xxxxxxxxxxxx
 ...
============================================================
```

Inicia sesión con esa clave temporal; la app te obligará a cambiarla antes de
dejarte entrar. Borra `data/SUPER_ADMIN_INICIAL.txt` después de usarla.

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
| **Retención** | Todas las pestañas en **solo lectura**: no puede Armar/Desarmar ni analizar contratos (los controles aparecen bloqueados con un aviso). Sí puede usar el IA Assistant. |

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
