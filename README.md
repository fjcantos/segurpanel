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

## App instalable (PWA) para móvil y tablet

SegurPanel es una **Progressive Web App**: se instala en la pantalla de inicio
del móvil o la tablet y, una vez visitada, **abre y funciona sin conexión**.

Archivos que lo hacen posible:

| Archivo | Función |
| --- | --- |
| `manifest.json` | Nombre, descripción, colores UIC (azul oscuro `#0b2545`), iconos y accesos directos. |
| `sw.js` | Service worker: cachea la app para el modo sin conexión. |
| `icons/` | Iconos PNG (32, 180, 192 y 512 px), incluidos los *maskable* de Android. |
| `tools/generate-icons.js` | Regenera los iconos (`npm run icons`). No necesita dependencias. |

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
