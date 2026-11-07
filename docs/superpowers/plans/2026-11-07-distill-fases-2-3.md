# Distill fases 2 y 3 (CLI, MCP y hooks) — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans para ejecutar este plan tarea por tarea. Los pasos usan checkboxes (`- [ ]`).

**Objetivo:** que un agente o una terminal conviertan documentos con distill sin abrir la web: `distillmd convert`, `distillmd mcp` (stdio y HTTP) y `distillmd hooks install --claude|--opencode`, que hacen que Claude Code y OpenCode lean el Markdown destilado en vez del binario.

**Arquitectura:** un módulo nuevo `src/node/distill.ts` junta lo que hoy hace el servidor por partes (detectar tipo, chequear LibreOffice, parsear, boosters, LLMLingua opcional y contar tokens) en una sola función `distillFile`. La CLI (`src/cli/convert.ts`), el servidor MCP (`src/mcp/`) y los hooks (`src/hooks/`) solo consumen ese módulo. Los hooks agregan una caché en disco por hash de contenido en `~/.cache/distillmd/out/`.

**Stack:** lo de la fase 1 más `@modelcontextprotocol/sdk` 1.32.2 y `zod` ^4 (peer del SDK).

**Spec:** `docs/superpowers/specs/2026-11-06-distill-design.md`, §7 y §8 (léela completa antes de empezar).

## Restricciones globales

- Las mismas de la fase 1: sin comentarios inline, sin configuración por ambiente en el código, sin `Co-Authored-By`, textos en inglés, Node ≥ 20, ESM, imports sin extensión.
- Ningún comando escribe en stdout otra cosa que su salida documentada. En `mcp` por stdio y en `hook claude`, stdout es el protocolo: todo log va a stderr.
- Orden de boosters fijo (`dedupe → media → tables → ws`), y `lingua` al final. Ids válidos en `--boosters`: `dedupe`, `media`, `tables`, `ws`.
- Caché: `~/.cache/distillmd` (la misma de la fase 1). Conversiones de los hooks en `out/`.
- Los hooks **nunca** bloquean una lectura: ante cualquier error, timeout o tipo no soportado, dejan pasar la entrada original sin tocarla y salen con código 0.
- Los hooks solo convierten PDF, DOCX, PPTX, XLSX y ODF. Las imágenes no se tocan: Claude y OpenCode las leen como imagen, y el OCR perdería información visual.
- `hooks install` nunca escribe sin mostrar el cambio y pedir confirmación (o `--yes`). Si el JSON existente no es válido, aborta sin tocarlo.
- MCP por HTTP: escucha en `127.0.0.1` por defecto y reusa las guardas de host y origen del servidor web (loopback, `--allowed-hosts`, cross-site). Solo lee archivos dentro de las raíces `--root` (repetible; por defecto el cwd). Por stdio no hay restricción de raíz: es el mismo usuario que lanzó el agente.
- No se publica nada (npm, ghcr, release) sin aprobación explícita del usuario.

## Review Focus

1. **Ruta relativa en MCP o en el hook.** Se resuelve contra el cwd del proceso (MCP) o contra `cwd` del payload (hook), no contra el directorio de distill. → Task 3 y 5.
2. **Dos archivos con el mismo nombre en `convert --out`.** `a/report.pdf` y `b/report.pdf` no se pisan: el segundo sale como `report-2.md`. → Task 2.
3. **Archivo cambiado después de convertirlo.** La caché es por hash del contenido más versión y boosters, así que una edición produce un `.md` nuevo y no se sirve uno viejo. → Task 4.
4. **`settings.json` con otros hooks o comentarios inválidos.** Se conservan todas las claves y hooks ajenos; instalar dos veces no duplica la entrada; si el JSON no parsea, aborta. → Task 6.
5. **Path traversal en MCP HTTP** (`../../etc/passwd`, symlink que sale de la raíz). Se rechaza con error de herramienta, comparando rutas reales (`realpath`). → Task 3.

---

### Task 1: núcleo `distillFile`

**Archivos:**
- Crear: `src/node/distill.ts`
- Crear: `src/core/booster-list.ts`
- Modificar: `src/core/types.ts` (agregar `DistillResult`)
- Test: `tests/node/distill.test.ts`, `tests/core/booster-list.test.ts`

**Interfaces:**
- Produce:
  - `parseBoosterList(value: string): Set<LocalBoosterId>` — separa por coma, recorta espacios, ignora vacíos; un id desconocido lanza `Error('Unknown booster: <id>. Valid: dedupe, media, tables, ws')`.
  - `interface DistillOptions { boosters?: ReadonlySet<LocalBoosterId>; lingua?: boolean; rate?: number }` — `boosters` por defecto `DEFAULT_ACTIVE`; `rate` por defecto `0.5`.
  - `interface DistillResult { path: string; name: string; kind: FileKind; pages: number; markdown: string; tokens: { raw: number; out: number }; ms: number }`
  - `interface Distiller { distillFile(path: string, opts?: DistillOptions): Promise<DistillResult>; close(): void }`
  - `createDistiller(deps: { parser: Parser; lingua?: Lingua; libreoffice: boolean; maxBytes?: number }): Distiller`
  - `openDistiller(): Promise<Distiller>` — arma parser, `exposeLibreOffice()` y lingua (sin instalar nada) como `startServer`; `maxBytes` por defecto 100 MB.
- Errores (`DistillError`): `not_found` si la ruta no existe o es carpeta; `unsupported_type`; `too_large`; `needs_libreoffice`; `lingua_unavailable` si `lingua: true` y el runtime no está instalado (mensaje: `LLMLingua-2 is not installed. Install it once from the web app (npx distillmd).`). Los de LiteParse pasan por `mapError`.

- [ ] **Paso 1:** tests de `parseBoosterList`: `'ws, tables'` → `{ws, tables}`; `''` → set vacío; `'ws,foo'` lanza con el mensaje exacto.
- [ ] **Paso 2:** tests de `createDistiller` con un `Parser` falso: devuelve `tokens.raw === countTokens(raw)` y `tokens.out === countTokens(runBoosters(raw, boosters))`; `boosters: new Set()` deja `markdown === raw`; ruta inexistente → `not_found`; `.txt` → `unsupported_type`; `.docx` con `libreoffice: false` → `needs_libreoffice`; `lingua: true` con un `Lingua` falso cuyo `status().installed === false` → `lingua_unavailable`; con `installed: true` llama a `compress(text, { rate })` después de los boosters.
- [ ] **Paso 3:** un test de integración con el PDF de `tests/fixtures/make-pdf.ts` y el parser real (límite de 30 s, como en la fase 1).
- [ ] **Paso 4:** implementar; correr `./node_modules/.bin/vitest run tests/node/distill.test.ts tests/core/booster-list.test.ts > $TMP/t.log 2>&1` → PASS.
- [ ] **Paso 5:** refactor mínimo: `startServer` sigue igual (no tocar el servidor en esta tarea). Commit `feat(core): add distillFile shared by cli, mcp and hooks`.

### Task 2: `distillmd convert`

**Archivos:**
- Crear: `src/cli/convert.ts`
- Modificar: `src/cli/run.ts` (registrar el comando; inyectar `openDistiller` por `CliDeps`)
- Test: `tests/cli/convert.test.ts`

**Interfaces:**
- Consume: `openDistiller`, `parseBoosterList`, `DistillResult` (Tarea 1); `formatTokens` de `src/core/format.ts` si ya formatea `38.9k`.
- Produce: `CliDeps.openDistiller?: () => Promise<Distiller>`.

Comando: `distillmd convert <files...> [--out <dir>] [--no-optimize] [--boosters <list>] [--lingua] [--rate <0..1>] [--json] [--stdout]`.
- Escribe `<base>.md` junto al archivo, o en `--out` (lo crea si falta). Si dos entradas producen el mismo destino en la misma corrida, la segunda es `<base>-2.md`, la tercera `-3`. Sobrescribe un `.md` que ya existía antes de la corrida.
- `--no-optimize` = ningún booster. `--boosters` y `--no-optimize` juntos → error de uso.
- `--stdout`: con un solo archivo, imprime el Markdown y no escribe nada; con más de uno, error de uso.
- Resumen por archivo a stdout: `report.pdf → report.md  38.9k → 27.1k tokens (−30%)`. Fallo: `report.pdf  error: <code>: <message>` a stderr, sigue con los demás.
- `--json`: imprime un único arreglo JSON `[{ input, output, tokens: { raw, out }, pages, ms } | { input, error: { code, message } }]` y nada más.
- Código de salida: 0 si todos salieron bien, 1 si alguno falló. Cierra el distiller al final siempre.
- Hasta 4 archivos en paralelo.

- [ ] **Paso 1:** tests con un distiller falso: destino junto al archivo; `--out`; colisión → `report-2.md`; `--json` produce JSON válido y solo eso; un fallo da salida 1 y no frena a los demás; `--stdout` con dos archivos es error; `--boosters ws --no-optimize` es error; `--boosters foo` muestra el mensaje de `parseBoosterList`.
- [ ] **Paso 2:** implementar y correr el test → PASS. Correr `tests/cli/*.test.ts` completo para confirmar que `web` sigue siendo el comando por defecto.
- [ ] **Paso 3:** commit `feat(cli): add distillmd convert`.

### Task 3: servidor MCP (`distillmd mcp`)

**Archivos:**
- Crear: `src/mcp/server.ts`, `src/mcp/roots.ts`, `src/mcp/http.ts`
- Modificar: `src/cli/run.ts`, `package.json` (deps `@modelcontextprotocol/sdk` `1.32.2` exacta y `zod` `^4`), `tsup.config.ts` solo si hace falta
- Test: `tests/mcp/server.test.ts`, `tests/mcp/roots.test.ts`, `tests/mcp/http.test.ts`

**Interfaces:**
- Consume: `Distiller`, `DistillOptions` (Tarea 1); `isAllowedHost`, `isLoopbackHost` y la guarda cross-site del servidor web (extraerlas de `src/server/app.ts` a `src/server/guards.ts` si no se pueden importar tal cual, sin cambiar su comportamiento).
- Produce:
  - `createMcpServer(deps: { distiller: Distiller; health: () => Health; resolvePath: (p: string) => Promise<string> }): McpServer`
  - `rootResolver(roots: string[], cwd: string): (p: string) => Promise<string>` — resuelve contra `cwd`, aplica `realpath` a ruta y raíces, y lanza `DistillError('forbidden', 'Path is outside the allowed roots')` si no queda dentro de alguna.
  - `serveMcpHttp(opts: { port: number; host: string; allowedHosts: string[]; createServer: () => McpServer }): Promise<{ url: string; close(): Promise<void> }>` — Streamable HTTP en `/mcp`, sin sesión (`sessionIdGenerator: undefined`), un `McpServer` por petición.

Herramientas (nombres y campos exactos de la spec §7):
- `distill_file({ path: string, boosters?: LocalBoosterId[], lingua?: boolean })` → texto = el Markdown; `structuredContent = { markdown, tokens: { raw, out }, pages, kind }`.
- `distill_files({ paths: string[], boosters?, lingua? })` → `structuredContent = { results: Array<{ path, markdown, tokens } | { path, error: { code, message } }> }`; el texto concatena cada archivo bajo un encabezado `# <nombre>`. Un archivo fallido no hace fallar la llamada. Máximo 20 rutas.
- `distill_capabilities()` → el mismo objeto `Health` de `/api/health`.
- Un `DistillError` en `distill_file` devuelve `isError: true` con `"<code>: <message>"`.

CLI: `distillmd mcp [--http] [--port 4322] [--host 127.0.0.1] [--root <dir>]... [--allowed-hosts <list>]`. Por stdio, `resolvePath` solo resuelve contra el cwd (sin raíces). Por HTTP, imprime `distill MCP at http://127.0.0.1:4322/mcp` en stderr y aplica `rootResolver(roots ?? [cwd])`.

- [ ] **Paso 1:** tests de `rootResolver`: dentro → ok; `../` fuera → `forbidden`; symlink dentro de la raíz que apunta afuera → `forbidden`; relativa resuelta contra `cwd`.
- [ ] **Paso 2:** tests de `createMcpServer` con `InMemoryTransport` del SDK y un `Client`: `listTools` devuelve las tres herramientas; `distill_file` devuelve `structuredContent.tokens`; un error devuelve `isError: true`; `distill_files` con una ruta mala y una buena devuelve dos resultados.
- [ ] **Paso 3:** tests de `serveMcpHttp` en puerto 0: `initialize` por POST funciona con `Host: 127.0.0.1`; `Host: evil.example` → 403; `Origin: https://evil.example` → 403.
- [ ] **Paso 4:** test de `run(['mcp'])` con deps falsas: no escribe nada en stdout.
- [ ] **Paso 5:** implementar, correr `tests/mcp` y `tests/server` → PASS; `npm run typecheck` limpio. Commit `feat(mcp): add distillmd mcp over stdio and http`.

### Task 4: caché de conversiones

**Archivos:**
- Crear: `src/hooks/cache.ts`
- Test: `tests/hooks/cache.test.ts`

**Interfaces:**
- Consume: `Distiller` (Tarea 1).
- Produce: `convertCached(path: string, deps: { distiller: Distiller; cacheDir: string; version: string }): Promise<{ mdPath: string; tokens: { raw: number; out: number } | null; cached: boolean }>`.
  - Clave: sha256 de `version + '\0' + boosters por defecto + '\0' + bytes del archivo`, en hex, primeros 32 caracteres.
  - Archivo: `<cacheDir>/out/<clave>.md`. Si existe, `cached: true` y `tokens: null` sin parsear.
  - Escritura atómica: `<clave>.md.tmp-<pid>-<random>` + `rename`.
  - El `.md` empieza con una línea `<!-- distill: <nombre original> · <raw> → <out> tokens -->` y una línea en blanco.

- [ ] **Paso 1:** tests: segunda llamada con el mismo contenido → `cached: true` y el distiller se llamó una vez; cambiar un byte → otra clave; cambiar `version` → otra clave; no quedan `.tmp-` tras un error del distiller.
- [ ] **Paso 2:** implementar, correr → PASS. Commit `feat(hooks): add content-addressed conversion cache`.

### Task 5: hooks en tiempo de ejecución (`distillmd hook claude` y `distillmd hook convert`)

**Archivos:**
- Crear: `src/hooks/claude.ts`, `src/hooks/supported.ts`
- Modificar: `src/cli/run.ts`
- Test: `tests/hooks/claude.test.ts`, `tests/hooks/supported.test.ts`

**Interfaces:**
- Consume: `convertCached` (Tarea 4), `openDistiller` (Tarea 1), `detectKind`.
- Produce:
  - `isHookConvertible(path: string): boolean` — `true` solo para PDF, DOCX, PPTX, XLSX y ODF según `detectKind`.
  - `handleClaudePreToolUse(payload: unknown, convert: (absPath: string) => Promise<string>): Promise<object | null>` — `null` = dejar pasar (sin salida).

Contrato de Claude Code (verificado el 2026-11-07 en https://code.claude.com/docs/en/hooks; si el implementador encuentra otra cosa, para y avisa):
- Entrada por stdin: `{ session_id, cwd, hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path, offset?, limit?, pages? }, tool_use_id }`. La doc dice que `file_path` llega absoluto; igual se resuelve contra `cwd` si no lo es.
- Si `tool_name !== 'Read'`, si `tool_input.pages` existe, si la ruta no es convertible o si `DISTILL_HOOK=off` → `null`.
- Salida: `{ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool_input, file_path: mdPath }, additionalContext: 'distill converted <nombre> to Markdown to save tokens. Original file: <ruta original>.' } }` en stdout, código 0. `updatedInput` **reemplaza** el input completo, por eso se copia `tool_input` entero. **No** se manda `permissionDecision`: el flujo normal de permisos sigue decidiendo (las reglas `deny` del usuario se respetan); la Tarea 6 agrega la regla `allow` para leer la caché.
- Cualquier excepción o JSON inválido → sin salida, código 0, un aviso de una línea en stderr. Nunca código 2 (bloquearía el Read).

`distillmd hook convert <file>` imprime `{"path":"<mdPath>"}` y sale 0, o sale 1 sin stdout si no se puede. Lo usa el plugin de OpenCode.

- [ ] **Paso 1:** tests de `handleClaudePreToolUse` con `convert` falso: Read de `/a/b.pdf` → `updatedInput.file_path === mdPath` y conserva `offset`/`limit`; `Read` con `pages` → `null`; `.png` → `null`; `Bash` → `null`; ruta relativa con `cwd: '/w'` → `convert('/w/x.pdf')`; `convert` que lanza → `null`; payload basura → `null`.
- [ ] **Paso 2:** test de `run(['hook','claude'])` con stdin falso: stdout tiene exactamente un JSON o nada, y la salida es 0 en ambos casos.
- [ ] **Paso 3:** implementar, correr → PASS. Commit `feat(hooks): add claude PreToolUse handler and hook convert`.

### Task 6: `distillmd hooks install|uninstall --claude|--opencode`

**Archivos:**
- Crear: `src/hooks/install-claude.ts`, `src/hooks/install-opencode.ts`, `src/hooks/opencode-plugin.ts`, `src/hooks/command.ts`
- Modificar: `src/cli/run.ts`
- Test: `tests/hooks/install-claude.test.ts`, `tests/hooks/install-opencode.test.ts`

**Interfaces:**
- Produce:
  - `hookCommand(deps: { which: (bin: string) => string | null; version: string }): string` — `'distillmd'` si `distillmd` está en el PATH; si no, `` `npx -y distillmd@${version}` ``.
  - `planClaudeInstall(current: string | null, command: string): { next: string; changed: boolean }` y `planClaudeUninstall(current: string, ...)`, puras sobre el texto del JSON.
  - `opencodePluginSource(command: string): string` — fuente JS del plugin.
- Claude: archivo `~/.claude/settings.json` o, con `--project`, `<cwd>/.claude/settings.json`. Agrega a `hooks.PreToolUse` `{ matcher: 'Read', hooks: [{ type: 'command', command: '<cmd> hook claude', timeout: 120 }] }` (timeout en segundos) y a `permissions.allow` la regla `Read(~/.cache/distillmd/out/**)`, para que leer el Markdown convertido no pida permiso cada vez; `uninstall` quita ambas. Reconoce una entrada propia por `command` que termina en `hook claude` y contiene `distillmd`; si ya existe, `changed: false` y no escribe. Conserva todo lo demás. Indentación de 2 espacios y salto de línea final.
- OpenCode: escribe `~/.config/opencode/plugins/distill.js` o, con `--project`, `<cwd>/.opencode/plugins/distill.js`. El plugin exporta `export const DistillPlugin = async () => ({ 'tool.execute.before': async (input, output) => { ... } })`: si `input.tool === 'read'` y `output.args.filePath` tiene extensión convertible, corre `<cmd> hook convert <ruta>` con `execFile` (timeout 120 s) y, si sale 0, reemplaza `output.args.filePath` por `path` del JSON. Cualquier error deja la ruta original. La lista de extensiones se genera desde `isHookConvertible`.
- Flujo de la CLI: muestra un diff legible (líneas `+`/`-`) y la ruta; pregunta `Apply? [y/N]` por readline; con `--yes` no pregunta; sin TTY y sin `--yes`, aborta con `Refusing to write without confirmation. Re-run with --yes.` y sale 1. JSON inválido → `Could not parse <ruta>: <motivo>. Nothing was changed.` y sale 1. Escritura atómica.
- `uninstall` quita solo la entrada propia (y `PreToolUse`/`hooks` si quedan vacíos) o borra el archivo del plugin.

- [ ] **Paso 1:** tests de `planClaudeInstall`: `null` → crea `{ hooks: { PreToolUse: [...] } }`; con otros hooks y claves → los conserva; segunda instalación → `changed: false`; JSON inválido → lanza. Tests de `planClaudeUninstall` simétricos.
- [ ] **Paso 2:** test de `opencodePluginSource`: el texto se importa como módulo (escribirlo en un tmp e `import()`), y con un `execFile` simulado reemplaza `filePath` solo para `.pdf` y no para `.ts`.
- [ ] **Paso 3:** tests de la CLI con `HOME` falso en tmp: sin TTY ni `--yes` sale 1 y no escribe; con `--yes` escribe; `--project` escribe en el cwd.
- [ ] **Paso 4:** implementar, correr → PASS. Commit `feat(hooks): install and uninstall claude code and opencode hooks`.

### Task 7: humo de punta a punta y docs

**Archivos:**
- Modificar: `README.md` (secciones CLI, MCP, Hooks; la hace el hilo de README del lanzamiento si ya está en curso), `docs/superpowers/specs/2026-11-06-distill-design.md` (marcar fases 2 y 3 como implementadas y anotar las decisiones de este plan).
- Test: `tests/e2e-cli/smoke.test.ts` (vitest, sobre `dist/cli.js` ya compilado).

- [ ] **Paso 1:** `npm run build`; test que corre `node dist/cli.js convert <pdf de fixture> --json` y valida el JSON; otro que manda a `node dist/cli.js hook claude` un payload Read de ese PDF con `HOME` en tmp y valida que `updatedInput.file_path` existe y termina en `.md`; otro que levanta `node dist/cli.js mcp`, hace `initialize` + `tools/call distill_file` por stdio con el `Client` del SDK y compara los tokens.
- [ ] **Paso 2:** suite completa: `npm run typecheck`, `npm test`, `npm run check:deps`, `npm run test:e2e` → todo en verde. Commit `test: smoke cli, mcp and hooks end to end`.
