# Distill — spec de diseño

- **Fecha:** 2026-11-06
- **Estado:** borrador, en revisión
- **Paquete npm:** `distillmd` (la marca visible es "distill")
- **Diseño visual aprobado:** https://claude.ai/artifact/5ZWVqWk1YpbiWn7rnwwtne (artboard "A · Midnight Lime" y "Detailed view")

## 1. Qué es y para qué

Distill es una app open source que convierte documentos (PDF, Office, imágenes) en Markdown listo para LLMs, usando [LiteParse](https://github.com/run-llama/liteparse) de LlamaIndex como motor local, y que además reduce los tokens del resultado con una cadena de "boosters".

Tiene tres caras sobre el mismo núcleo:

1. **Web**: arrastras archivos, ves el Markdown, copias o descargas. Público general.
2. **Tool para agentes**: servidor MCP y CLI para que cualquier agente convierta documentos.
3. **Hooks**: integraciones que hacen que Claude Code y OpenCode lean el Markdown destilado en vez del binario.

**Éxito significa:**
- `npx distillmd` abre la web en un solo comando, sin configurar nada, y un PDF se convierte en segundos.
- El ahorro de tokens se ve claro y es real: se mide con un tokenizer real, no se estima.
- Todo corre en la máquina del usuario: ningún archivo sale de ella y no hay telemetría. Las únicas descargas son de datos, nunca de documentos: el runtime de LLMLingua-2 desde npm y su modelo, solo si el usuario lo activa, y los datos de Tesseract en inglés (~15 MB, desde GitHub) la primera vez que se hace OCR, salvo que ya existan en local (§4.1). El README lo dice tal cual.
- La UI es compacta por defecto, con los detalles a un clic, y se ve bien en una captura para X.

## 2. Fases

| Fase | Entrega | Publicable |
|------|---------|------------|
| 1 | Núcleo (parse + boosters + tokens), web y app de escritorio | Sí: `npx distillmd`, imagen Docker, instaladores Electron *lite* y *full* |
| 2 | `distillmd mcp` (stdio y HTTP) y `distillmd convert` (CLI) | Sí |
| 3 | `distillmd hooks install --claude \| --opencode` | Sí |

Esta spec detalla la fase 1 y fija las interfaces de las fases 2 y 3. Cada fase tendrá su propio plan de implementación.

**Estado (2026-11-07):** las fases 2 y 3 están implementadas (`distillmd convert`, `distillmd mcp`, `distillmd hook claude|convert`, `distillmd hooks install|uninstall`). Ver las decisiones de implementación al final de la sección 8.

## 3. Arquitectura

Es un solo paquete npm en TypeScript (Node ≥ 20, ESM). Un proceso de Node sirve la API y la SPA ya compilada.

```
distillmd/
├── src/
│   ├── core/                 sin dependencias de servidor; se usa en Node y en el navegador
│   │   ├── boosters/         una función pura por booster + pipeline
│   │   ├── tokens.ts         conteo con gpt-tokenizer (o200k_base)
│   │   └── types.ts          contratos compartidos
│   ├── node/                 solo en Node
│   │   ├── parse.ts          wrapper de LiteParse (pool, timeout, detección de LibreOffice)
│   │   ├── lingua.ts         LLMLingua-2 con @atjsh/llmlingua-2 (carga perezosa desde raíces)
│   │   ├── lingua-install.ts instalación bajo demanda del runtime (npm ci en la caché)
│   │   └── capabilities.ts   qué está disponible (LibreOffice, modelo descargado)
│   ├── server/               Hono + @hono/node-server: API y archivos estáticos
│   ├── cli/                  entrada `distillmd` (commander): web | convert | mcp | hooks
│   ├── mcp/                  (fase 2)
│   └── hooks/                (fase 3)
└── web/                      SPA con Vite + React; usa src/core directamente
```

**Decisión clave:** los boosters y el conteo de tokens son funciones puras en `core/` y también corren en el navegador. El servidor parsea cada archivo una sola vez y regresa el Markdown crudo; prender o apagar un booster en la UI recalcula al instante en el cliente, sin volver a pedir nada. Solo LLMLingua-2 corre en el servidor, porque necesita el modelo ONNX.

### Flujo de datos (web)

```
soltar archivo → POST /api/parse (multipart)
              → LiteParse (outputFormat: markdown) → { markdown crudo, json con bboxes, páginas }
              ← respuesta
cliente: pipeline(boosters activos)(markdown crudo) → markdown destilado
cliente: count(crudo), count(destilado) → "38.9k → 27.1k −30%"
si LLMLingua-2 está activo: POST /api/compress { text, rate } ← texto comprimido (se aplica al final)
```

## 4. Núcleo

### 4.1 Parseo (LiteParse)

- Paquete: `@llamaindex/liteparse` (2.18.x, Apache-2.0). Trae binarios nativos por plataforma (darwin, linux gnu/musl, win32).
- Se usa una instancia con `outputFormat: 'markdown'`, `imageMode: 'placeholder'`, `extractLinks: true`, `keepHeadersFooters: false`, `ocrEnabled: true`, `poolSize` = min(4, CPUs) y `parseTimeoutMs` = 120 000 (configurable).
- La vista JSON + boxes requiere una segunda pasada con `outputFormat: 'json'`, que se pide bajo demanda (`GET /api/files/:id/json`) y nunca en la conversión normal.
- **Formatos:** PDF e imágenes (PNG, JPG, TIFF, WebP) funcionan sin nada más. DOCX, PPTX, XLSX y ODF **requieren LibreOffice**. Al arrancar se detecta `soffice` en el PATH. Si falta, la UI acepta el archivo, lo marca con error "Office files need LibreOffice" y muestra cómo instalarlo; no falla en silencio. La imagen Docker incluye LibreOffice.
- PDF con contraseña: se muestra un error claro. Pedir la contraseña queda fuera de la v1.
- **OCR y tessdata (agregado el 2026-11-06):** LiteParse trae Tesseract dentro de su binario. Si no se le pasa `tessdataPath` ni existe `TESSDATA_PREFIX`, la primera vez que hace OCR descarga `eng.traineddata` (~15 MB) de `github.com/tesseract-ocr/tessdata_best`. Distill lee `DISTILL_TESSDATA` (→ `tessdataPath`) y `DISTILL_OCR_LANG` (→ `ocrLanguage`, por defecto `eng`). La imagen Docker apunta las dos al tessdata del sistema, así que no descarga nada. La app de escritorio trae `eng.traineddata` incluido (descargado una sola vez al construir, con SHA-256 fijo) y apunta `DISTILL_TESSDATA` a él, así que tampoco descarga nada.

### 4.2 Boosters

Cada booster es `(md: string) => string`: puro, determinista e idempotente (`b(b(x)) === b(x)`). La pipeline aplica los boosters activos en este orden fijo:

| # | id | Nombre en UI | Qué hace | Pérdida |
|---|----|--------------|----------|---------|
| 1 | `dedupe` | Drop repeated boilerplate | Elimina encabezados y pies repetidos: líneas no estructurales (no son títulos, filas de tabla ni ítems de lista) idénticas, de ≤ 120 caracteres, con al menos 4 palabras y 25 caracteres, que aparecen 3 o más veces (la firma es la línea tal cual, recortada solo en los extremos), y las líneas que son solo un indicador de página (`Page 3 of 12`, `p. 3/12`, `3 of 12 pages`, `- 3 -`, `Página 3 de 12`); conserva la primera aparición. Las líneas que difieren en un enlace, un número de página, una referencia o los espacios se conservan. Las líneas cortas repetidas (`Yes`, `N/A`, `Score: 3/4`) nunca se eliminan | Ninguna de información |
| 2 | `media` | Slim images and links | `![alt](ruta)` → `[alt]` (se borra si alt está vacío); `[texto](url)` → `texto` | Se pierden las rutas y las URLs |
| 3 | `tables` | Compact tables | Quita el relleno de alineación de las tablas GFM: `\| a \| b \|` → `\|a\|b\|`, y el separador queda `\|-\|-\|` | Ninguna |
| 4 | `ws` | Collapse whitespace | Convierte varias líneas en blanco en una, quita espacios al final y colapsa espacios dobles fuera de bloques de código | Ninguna |
| 5 | `lingua` | LLMLingua-2 | Compresión con modelo (servidor), al final de la pipeline | **Con pérdida** (marcado en la UI) |

Reglas comunes: ningún booster toca bloques de código delimitados (```) ni front-matter. `ws` se aplica al final para limpiar lo que dejan los demás.

**Invariante que se prueba:** con los boosters 1 a 4, todas las palabras alfanuméricas del texto crudo siguen apareciendo en el resultado, salvo las de URLs o rutas que `media` quita y las repeticiones que `dedupe` elimina. Esto es lo que justifica llamarlos "sin pérdida".

Valores por defecto: 1 a 4 activos, `lingua` apagado. El switch maestro "Optimize for LLMs" va prendido.

### 4.3 LLMLingua-2

- Usa `@atjsh/llmlingua-2` (MIT) con los peers `@huggingface/transformers` y `js-tiktoken`, en `device: 'cpu'` y `dtype: 'fp32'`.
- El modelo por defecto es TinyBERT (`atjsh/llmlingua-2-js-tinybert-meetingbank`, unos 57 MB). En Detailed se puede elegir MobileBERT (99 MB) o XLM-RoBERTa (2.2 GB).
- El modelo se descarga la primera vez que se activa, a la caché de transformers.js en `~/.cache/distillmd/models`. La UI muestra el progreso de la descarga. Después corre sin red.
- `rate` (fracción de tokens que se conserva) vale 0.6 por defecto, se ajusta en Detailed entre 0.3 y 0.9 y se aplica por fragmentos de unos 512 tokens.
- **Instalación bajo demanda (decisión del usuario, 2026-11-06).** `@atjsh/llmlingua-2`, `@huggingface/transformers` y `js-tiktoken` ya no son dependencias de `distillmd`: `npx distillmd` no baja los ~520 MB (en disco) de onnxruntime y compañía ni el postinstall que en Linux x64 trae CUDA desde NuGet. Las tres viven en `lingua-runtime/` (`package.json` con versiones exactas y `package-lock.json` con integridad, ambos dentro del tarball de npm) y se instalan cuando el usuario lo pide.
- **Raíces de carga**, en este orden; se usa la primera donde las tres resuelven y su ruta real queda dentro de la raíz, sin buscar nunca en directorios ancestros:
  1. el `node_modules` propio de distill (desarrollo);
  2. `process.resourcesPath/lingua/node_modules` (app de escritorio full);
  3. `~/.cache/distillmd/lingua/node_modules` (instalación bajo demanda).
  El `import()` usa la ruta ESM resuelta con el mapa `exports` (condiciones `node`, `import`, `default`), de modo que `@atjsh/llmlingua-2` y la configuración de `env.cacheDir` comparten la misma instancia de transformers.
- **Instalación.** `POST /api/lingua/install` (con el guard de loopback/Origin) es idempotente y de una sola ejecución a la vez: copia `lingua-runtime/package.json` y `package-lock.json` a un directorio temporal junto a `~/.cache/distillmd/lingua`, corre `npm ci --omit=dev --include=peer --ignore-scripts --no-audit --no-fund` ahí (sin shell, con timeout de 10 min), verifica que los tres paquetes existan y recién entonces cambia el directorio: mueve el `lingua` anterior a `lingua.old-<hex>`, renombra el temporal a `lingua` y borra el anterior (si el segundo renombrado falla, devuelve el anterior; los renombrados se reintentan hasta 5 veces con espera ante `EPERM`/`EBUSY`). Al arrancar una instalación solo se borran los temporales `lingua.installing-*` y `lingua.old-*` con más antigüedad que el timeout, para no pisar otra instalación en curso. Si se vence el timeout, se mata npm y se espera a que cierre antes de limpiar. Un fallo borra el temporal y deja `install_failed` con un código (`npm_missing`, `npm_failed`, `timeout`, `verify_failed`, `filesystem`) y el mensaje de npm recortado y sin rutas del usuario. `--ignore-scripts` omite el postinstall de onnxruntime-node (que solo agrega CUDA en Linux x64; los binarios CPU vienen en el tarball) y sharp usa sus paquetes `@img/sharp-*` precompilados.
- **`installable`.** Es `true` cuando se encuentra `npm` (el `npm-cli.js` de `npm_execpath`, el que trae Node junto al ejecutable, o `npm` en el PATH fuera de Windows) y responde a `--version`; es siempre `false` dentro de Electron. Por eso en la app lite la fila dice "Available in distill full" con un link al release, y en npx, la CLI y Docker dice "Install (~520 MB)".
- La app de escritorio *full* empaqueta el mismo `lingua-runtime` (`npm ci --omit=dev --include=peer --ignore-scripts` en `build/lingua`) en `Resources/lingua/` con un hook `afterPack` (electron-builder quita `node_modules` de `extraResources`); en Docker se instala bajo demanda en el volumen de caché.

### 4.4 Conteo de tokens

- Se usa `gpt-tokenizer` (JS puro) con la codificación `o200k_base`, que se carga de forma perezosa en el cliente.
- La UI lo etiqueta como "o200k". Otros modelos (Claude, Gemini) tokenizan distinto; el porcentaje de ahorro es comparable entre ellos, pero los conteos absolutos son aproximados. Así se dice en un tooltip, sin prometer exactitud.

## 5. API HTTP

Por defecto escucha solo en `127.0.0.1:4321` (`--port`, `--host`). No tiene autenticación porque es local; exponerlo en `0.0.0.0` exige pasar `--host` explícitamente.

| Método y ruta | Entrada | Salida |
|---------------|---------|--------|
| `GET /api/health` | — | `{ version, liteparseVersion, maxBytes, libreoffice: bool, lingua: { installed, installable, model, state: idle\|downloading\|ready\|error\|installing\|install_failed, progress: 0–1, installError?: { code, message } } }` |
| `POST /api/parse` | multipart: `file` | `{ id, name, kind, pages, markdown, ms }`, o un error `{ code, message }` |
| `GET /api/files/:id/json` | — | JSON de LiteParse con bboxes |
| `DELETE /api/files/:id` | — | `204`, también si el id no existe. Es la única ruta de borrado: «Clear» borra id por id los que el cliente conoce, no hay borrado comodín |
| `POST /api/lingua/install` | — | `202` con el estado de `lingua` mientras instala (`200` si ya está instalado, `503 lingua_unavailable` si no se puede instalar aquí) |
| `POST /api/compress` | `{ text, rate, model? }` | `{ text }` (puede tardar; responde 503 si el modelo no está listo) |
| `GET /*` | — | SPA |

- Los archivos subidos van a un directorio temporal y se borran al terminar el parseo. Los bytes originales y el resultado quedan en memoria (LRU, 50 archivos o 200 MB) solo para pedir el JSON después: esa segunda pasada vuelve a escribir un temporal y lo borra al terminar.
- Límite por archivo: 100 MB (`--max-size`, `maxBytes`); el cuerpo de `/api/parse` admite además 1 MB de sobrecarga multipart, y el de `/api/compress` hasta 5 000 000 de caracteres de texto.
- Códigos de error `{ code, message }` y su estado HTTP: `bad_request` 400, `unsupported_type` 400, `forbidden` 403, `not_found` 404, `too_large` 413, `needs_libreoffice` 422, `password_protected` 422, `parse_failed` 422 (500 con «Unexpected server error» ante fallos no previstos), `lingua_unavailable` 503, `timeout` 504.
- `499` sin cuerpo: el cliente abortó la petición (parseo o compresión) y el servidor no guarda el resultado.
- Toda respuesta de `/api/*`, errores incluidos, lleva `Cache-Control: no-store`.
- Con el servidor ligado a loopback, se rechaza con `403 forbidden` cualquier petición cuyo `Host` no sea loopback y cualquier petición no segura con un `Origin` que no lo sea.
- Sin importar el host de enlace (también `0.0.0.0` y Docker), toda petición no segura (`POST`, `PUT`, `PATCH`, `DELETE`) a `/api/*` se rechaza con `403 forbidden` si `Sec-Fetch-Site` es `cross-site` o si trae un `Origin` cuyo host:puerto difiere del encabezado `Host`. Las peticiones sin `Origin` (curl, clientes MCP) pasan. Un proxy inverso debe conservar el `Host` original; si lo reescribe, el navegador queda bloqueado. Un puerto por defecto explícito en `Host` (`:80` con `http`, `:443` con `https`) cuenta como el mismo origen.
- Si el host de enlace no es loopback, toda petición (también `GET`) cuyo `Host` no sea un nombre loopback, una IP literal o un nombre de `--allowed-hosts` / `DISTILL_ALLOWED_HOSTS` (lista separada por comas; un punto inicial admite subdominios) recibe `403 forbidden`. Esto corta el DNS rebinding.
- Concurrencia: el cliente sube en paralelo; el servidor pone en cola según el `poolSize` de LiteParse.

## 6. UI (fase 1)

El diseño aprobado es el del canvas: tema **Midnight Lime**, columna de 520 px y densidad compacta.

**Tokens de color:** fondo `#0B0B10`, superficie `#15151C`, borde `#26262F`, texto `#F3F3F6`, texto secundario `#A0A0AE`, acento `#C8F53C` (texto sobre acento `#0B0B10`), con pérdida `#FFB86B`. Tipos de archivo: PDF `#FF8A8A`, DOCX `#86BEFF`, PPTX `#FFB86B`, IMG `#CFA6FF`, cada uno sobre un fondo de su color al 14%.

**Tipografía:** Space Grotesk 700 para la marca, la tagline y el % de ahorro; Inter para la UI; JetBrains Mono para conteos y código. Las fuentes van incluidas en el paquete con `@fontsource`; no se usa ningún CDN.

**Vista Compact (por defecto):**
- Encabezado: logo, `distill`, el switch Compact/Detailed y dos íconos (conectar agente y GitHub).
- Tagline: "Documents in. **Fewer tokens** out."
- Dropzone en franja. Acepta soltar archivos y carpetas, clic para elegir y pegar con ⌘V/Ctrl+V.
- Switch "Optimize for LLMs" con un resumen ("4 boosters") que despliega la lista de boosters.
- Una fila de 34 px por archivo: etiqueta de tipo con color, nombre, `38.9k → 27.1k`, `−30%`, copiar y descargar. Al dar clic se despliega una vista previa de 120 px.
- Pie: el % total grande, el resumen de tokens y "Download all" (un ZIP armado en el cliente con `fflate`).

**Vista Detailed (opt-in, se recuerda en localStorage):** boosters con su explicación, selector de modelo y `rate` de LLMLingua-2, una barra de ahorro por archivo, pestañas Markdown / JSON + boxes y una vista previa de 260 px.

**Estados de cada archivo:** en cola, parseando (indeterminado: LiteParse no reporta el % por página en `parse()`, así que el "64%" del mockup queda como una barra animada sin número), OCR (cuando no hay texto embebido) y error (mensaje en una línea, con acción cuando aplica).

**Pantalla "Connect your agent":** es un panel lateral con los snippets para Claude Code, Claude Desktop, OpenCode, Codex y ChatGPT. En la fase 1 explica lo que llega en las fases 2 y 3.

**Accesibilidad:** contraste ≥ 4.5:1 (verificado con los tokens de arriba), switches con `role="switch"`, navegación completa con teclado, `prefers-reduced-motion` respetado y áreas táctiles de 44 px en pantallas de 640 px o menos, aunque se vean igual de compactas.

Los textos de la UI van en inglés y centralizados en un módulo, para poder traducirlos después. El español queda fuera de la v1.

## 7. Fase 2 — MCP y CLI (interfaces)

- `distillmd convert <archivos…> [--out dir] [--no-optimize] [--boosters ws,tables,…] [--lingua] [--json]` escribe `.md` junto al archivo o en `--out` e imprime el resumen de tokens.
- `distillmd mcp [--http --port]` expone el servidor MCP (`@modelcontextprotocol/sdk`) con:
  - `distill_file({ path, boosters?, lingua? })` → `{ markdown, tokens: { raw, out } }`
  - `distill_files({ paths, … })` → lo mismo, por lote
  - `distill_capabilities()` → igual que `/api/health`
- ChatGPT no tiene hooks: se integra como conector MCP remoto (`--http`). La UI y el README explican los pasos y la necesidad de un túnel HTTPS cuando no es local.

## 8. Fase 3 — Hooks (interfaces)

- **Claude Code:** un hook `PreToolUse` con matcher `Read`. Si `file_path` termina en una extensión soportada, convierte el archivo a `~/.cache/distillmd/out/<hash>.md` y devuelve `updatedInput.file_path` apuntando a ese Markdown. Las conversiones se guardan en caché por hash del contenido. `hooks install --claude` lo agrega a `~/.claude/settings.json` (o al del proyecto con `--project`) después de mostrar el diff y pedir confirmación.
- **OpenCode:** un plugin con `tool.execute.before` sobre la tool `read`, con la misma lógica.
- Codex y otros clientes se integran por MCP. Si tienen hooks, se agregan en una versión posterior.
- Se verificará la API exacta de cada cliente al planear la fase 3; esta sección fija la intención, no la firma final.

### Decisiones de implementación (fases 2 y 3) — 2026-11-07

- **MCP HTTP:** transporte stateless (un servidor y un transporte por petición). Confina las lecturas a `--root` (por defecto, el cwd) resolviendo symlinks; una ruta fuera devuelve `forbidden`. Aplica las mismas guardas de host y origen que el servidor web. Stdio solo usa el cwd y no escribe nada en stdout fuera de JSON-RPC.
- **Hooks de Claude:** nunca bloquean. Salen con código 0, no emiten `permissionDecision` y, ante cualquier fallo, dejan pasar la lectura original. `updatedInput` reemplaza la entrada completa, así que se copian `offset` y `limit`. El instalador agrega también la regla `allow` para `~/.cache/distillmd/out/**`, para que la lectura del Markdown no pida permiso.
- **Formatos:** solo se convierten PDF y Office/ODF. Las imágenes y el CSV se dejan pasar sin tocar, porque convertirlos no ahorra tokens.
- **Caché:** direccionada por contenido (hash del archivo y de las opciones). Un acierto no vuelve a parsear.
- **OpenCode:** el plugin reescribe `filePath`, `file_path` o `path` según la tool y rechaza rutas riesgosas en Windows.
- **Instalador:** conserva symlinks y modos de archivo, rechaza symlinks del proyecto que escapen del cwd y enmascara los valores en el diff antes de pedir confirmación.
- **Pruebas:** el humo de punta a punta vive en `tests/e2e-cli/` (`npm run test:smoke`), corre sobre `dist/cli.js` con un `HOME` temporal y está fuera de `npm test`.

## 9. Distribución

- npm: `distillmd`, con los bins `distillmd` y `distill`. `npx distillmd` equivale a `distillmd web --open`.
- Repositorio: `github.com/nievesjesus/distill`.
- Docker: `ghcr.io/nievesjesus/distill`, basada en `node:22-bookworm-slim` con LibreOffice (writer, calc, impress) y los datos de tesseract en inglés (`tesseract-ocr-eng`; otros idiomas se piden con `DISTILL_OCR_LANG` y datos propios en `DISTILL_TESSDATA`). Se ejecuta con `docker run -p 4321:4321`, y dentro del contenedor escucha en `0.0.0.0`.
- Licencia: Apache-2.0, compatible con LiteParse.

### 9.1 App de escritorio (Electron) — agregado el 2026-11-06

El usuario pidió un binario que se descarga y se ejecuta. Un ejecutable de un solo archivo (Node SEA, `bun --compile`, `pkg`) no sirve: LiteParse carga un addon nativo (`liteparse.<plataforma>.node` + `libpdfium`) que tiene que existir como archivo en disco, y su pool hace `fork()` de `pool-worker.js`, así que necesita un runtime de Node. Por eso la app de escritorio usa Electron, que trae Node integrado.

- **Proceso principal:** importa `startServer` del mismo paquete, levanta el servidor en `127.0.0.1` con puerto 0 (libre) y abre una `BrowserWindow` que carga esa URL. Usa el mismo servidor y la misma UI que `npx distillmd`; no hay un segundo código de UI.
- **Ventana:** 640×780 por defecto, mínimo 440×520, título "distill" y fondo `#0B0B10` desde el primer frame (sin destello blanco). La barra de título está integrada: en macOS `hiddenInset` con los semáforos a 16 px del borde y centrados en una barra de 40 px; en Windows `hidden` con `titleBarOverlay` de 40 px; en Linux la barra del sistema. Tamaño y posición se recuerdan en `window-state.json`. Instancia única: abrir la app de nuevo enfoca la ventana existente. Al cerrar la ventana, o con Cmd+Q, se detiene el servidor (con un tope de 2 s) y la app sale, también en macOS.
- **Seguridad:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `spellcheck: false` y un preload mínimo en sandbox que expone solo `window.distillDesktop` con `onSaved(callback)` y `reveal(id)`. Los canales IPC (`distill:saved`, `distill:reveal`) validan el remitente y `reveal` recibe un id que el proceso principal traduce a una ruta guardada, nunca una ruta del renderer. Guardar usa el diálogo nativo y recuerda la última carpeta en `desktop-prefs.json`. La ventana no puede navegar fuera de su origen: los links externos (GitHub, LibreOffice) se abren en el navegador del sistema con `shell.openExternal`, y solo si son `https:`. `setWindowOpenHandler` deniega las ventanas nuevas.
- **LiteParse dentro de Electron:** el `fork()` del pool debe arrancar el binario de Electron en modo Node (`ELECTRON_RUN_AS_NODE`). Los archivos nativos y `pool-worker.js` van fuera del asar (`asarUnpack`). Una prueba de humo en la app empaquetada lo valida.
- **Variantes:**
  - *lite* no trae `lingua/` en `resources`; la UI muestra "Available in distill full".
  - *full* trae `resources/lingua/node_modules` con el runtime de `lingua-runtime/` (fuera del asar, para que cargue el binario de onnxruntime); `scripts/check-variant.mjs` lo verifica.
  - Artefactos: `Distill-<lite|full>-<versión>-<os>-<arch>.<dmg|exe|AppImage>`.
- **Plataformas:** macOS arm64 y x64 (`.dmg`), Windows x64 (instalador NSIS `.exe`), Linux x64 (`.AppImage`).
- **Firma:** la v0.1 sale sin Developer ID ni notarización. En macOS lleva firma *ad hoc* (`identity: "-"`), porque sin ninguna firma Apple Silicon la reporta como "dañada". El README explica cómo abrirla la primera vez: en macOS 15+, Configuración del Sistema → Privacidad y seguridad → "Abrir de todas formas"; en macOS 14 o anterior, clic derecho → Abrir; si macOS dice "dañada", `xattr -dr com.apple.quarantine`. En Windows, "Más información → Ejecutar de todas formas". La firma con Developer ID y la notarización quedan para cuando existan las cuentas.
- **Publicación:** un workflow de GitHub Actions que corre al empujar un tag `v*` construye la matriz y sube los instaladores a un GitHub Release en borrador. Nada se publica sin que el usuario lo revise.
- **Sin auto-update en la v0.1** (fuera de alcance).
- LibreOffice no va incluido. La app lo detecta igual que la web y explica cómo instalarlo.
- El README va en inglés e incluye un GIF de 10 segundos (soltar archivo → −30%) para el lanzamiento.

## 10. Pruebas

- **Unitarias (vitest):** cada booster con fixtures de entrada y salida esperada, idempotencia, el invariante de palabras de §4.2 y que no se toquen los bloques de código.
- **Integración:** `/api/parse` con un PDF de muestra generado en el repo (sin documentos de terceros), errores `unsupported_type` y `too_large`, y el error `needs_libreoffice` simulado.
- **E2E (Playwright, un flujo):** soltar un PDF → aparece la fila con el ahorro → copiar → apagar "Optimize" → los conteos se igualan.
- CI en GitHub Actions: lint, typecheck, pruebas unitarias y de integración en Linux y macOS.

## 11. Fuera de alcance (v1)

Auto-update de la app de escritorio; firma y notarización de los instaladores; LibreOffice incluido en la app.
Subir a la nube o tener cuentas; editar el Markdown; procesar URLs remotas; contraseñas de PDF; traducir la UI; pedir el `%` de progreso por página; tokenizers específicos de cada proveedor.

## 12. Riesgos

- **LibreOffice** pesa (~500 MB). Por eso no se pide para PDF e imágenes y va incluido en Docker.
- **Calidad de LiteParse** en tablas densas y escaneos complejos: la limita el motor. El README lo dice con honestidad.
- **LLMLingua-2 JS** está marcado como "experimental" por su autor. Por eso es opcional, va apagado por defecto y está marcado como con pérdida.
- **Nombre:** "distill" es genérico. El paquete `distillmd` y el repo `distill` evitan el choque en npm; se revisará si hay conflicto de marca antes del lanzamiento.
