# Distill fase 1 (núcleo + web) — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans para ejecutar este plan tarea por tarea. Los pasos usan checkboxes (`- [ ]`).

**Objetivo:** que `npx distillmd` levante una web local donde sueltas documentos, LiteParse los convierte a Markdown y los boosters reducen los tokens, con la UI compacta Midnight Lime ya aprobada.

**Arquitectura:** es un paquete npm en TypeScript ESM. `src/core` tiene funciones puras (boosters, tokens, formato) que usan tanto Node como el navegador. `src/node` envuelve LiteParse y LLMLingua-2. `src/server` es una app Hono que sirve la API y la SPA. `web/` es la SPA (Vite + React), que corre los boosters y cuenta tokens en un Web Worker, así que prender o apagar un booster responde al instante.

**Stack:** Node ≥ 20, TypeScript, Hono + `@hono/node-server`, commander, `@llamaindex/liteparse` ^2.18.0, `gpt-tokenizer` ^4.1.0, `@atjsh/llmlingua-2` ^3.0.0 + `@huggingface/transformers` ^4.2.0 + `js-tiktoken` (opcionales), Vite + React, `fflate`, `@fontsource/*`, vitest, @testing-library/react, Playwright, tsup.

**Spec:** `docs/superpowers/specs/2026-11-06-distill-design.md` (léela completa antes de empezar)

**Diseño visual:** https://claude.ai/artifact/5ZWVqWk1YpbiWn7rnwwtne — artboards "A · Midnight Lime (compact)" y "Detailed view". Es la referencia de medidas, copy y comportamiento de la UI.

## Restricciones globales

- Paquete `distillmd`, bins `distillmd` y `distill`, licencia Apache-2.0, `"type": "module"` y `engines.node` `>=20`.
- **Nada de comentarios inline** en el código: ni dentro de funciones ni `//` al final de una línea. El código se explica solo.
- El servidor escucha por defecto en `127.0.0.1:4321`. Límite por archivo de 100 MB (`--max-size`). LRU de 50 archivos o 200 MB. `parseTimeoutMs` de 120 000 y `poolSize` de `Math.min(4, os.availableParallelism())`.
- Caché en `~/.cache/distillmd` (modelos en `models/`).
- No hay telemetría ni se pide nada a la red, salvo la descarga del modelo de LLMLingua cuando el usuario la activa. Las fuentes van con `@fontsource` y no se usa ningún CDN.
- El orden de los boosters es fijo: `dedupe → media → tables → ws`, y `lingua` va al final, en el servidor. Ningún booster toca bloques de código delimitados (``` o ~~~) ni el front-matter `---` inicial.
- Los textos de la UI van en inglés y viven en `web/src/strings.ts`.
- Tokens de color (copiar tal cual): `--bg #0B0B10`, `--surface #15151C`, `--seg-on #2A2A35`, `--border #26262F`, `--border-soft #1B1B23`, `--text #F3F3F6`, `--muted #A0A0AE`, `--code #D9D9E0`, `--accent #C8F53C`, `--on-accent #0B0B10`, `--lossy #FFB86B`, `--off-track #3A3A46`, `--drop-border #4A4A58`, `--drop-bg #101016`. Tipos de archivo (texto / fondo): PDF `#FF8A8A`/`rgba(255,138,138,.14)`, DOCX `#86BEFF`/`rgba(134,190,255,.14)`, PPTX y XLSX `#FFB86B`/`rgba(255,184,107,.14)`, IMG `#CFA6FF`/`rgba(207,166,255,.14)`.
- Tipografía: Space Grotesk 700 para marca, tagline y el % del pie; Inter 400–700 para la UI; JetBrains Mono para conteos y código. Medidas: columna `max-width: 520px`, texto base de 13px, filas de 34px y controles de 24–28px. Con `max-width: 640px`, las áreas táctiles pasan a ser de al menos 44px.
- Commits: no se hace ninguno hasta que el usuario confirme con qué identidad de git. Los pasos "Commit" usan `git -c user.email=<confirmado>` y no llevan trailer `Co-Authored-By`.

## Review Focus

Estos son los riesgos que la spec implica pero que ninguna prueba "feliz" cubre. A cada uno se le agregó una prueba en la tarea que se indica:

1. **Fences de código con barras o `~~~` dentro del Markdown.** Una tabla dentro de un bloque de código no debe compactarse ni deduplicarse. → Tarea 1, `segments.test.ts`.
2. **Archivo de más de 100 MB o tipo no soportado.** Debe aparecer una fila con su error sin tumbar la cola, y el cliente lo rechaza antes de subirlo. → Tareas 6 y 9.
3. **El mismo archivo soltado dos veces, o dos archivos con el mismo nombre.** Deben aparecer dos filas con ids distintos, y el ZIP debe usar `name (2).md`. → Tareas 9 y 10.
4. **Documento enorme (1 000 páginas, unos 2 M de caracteres).** La UI no debe congelarse al cambiar boosters, porque el trabajo corre en el worker. → Tarea 8, prueba de rendimiento del pipeline (< 1.5 s para 2 M de caracteres).
5. **Timeout o crash de LiteParse en un archivo de un lote.** Ese archivo muestra `timeout` o `parse_failed` y los demás terminan. → Tareas 4 y 6.
6. **Nombres con acentos, espacios o emoji.** Deben conservarse en la fila, en el `.md` descargado y en el ZIP. → Tarea 10.

---

## Estructura de archivos

```
package.json · tsconfig.json · tsup.config.ts · vitest.config.ts · .gitignore · LICENSE · README.md · Dockerfile
.github/workflows/ci.yml
src/core/types.ts            contratos compartidos
src/core/boosters/segments.ts  mapProse (protege fences y front-matter)
src/core/boosters/{dedupe,media,tables,ws}.ts
src/core/boosters/pipeline.ts  BOOSTERS (metadatos) y runBoosters
src/core/tokens.ts           countTokens (o200k)
src/core/format.ts           shortCount, savedPercent
src/core/kind.ts             detectKind y needsLibreOffice
src/node/errors.ts           DistillError
src/node/capabilities.ts     hasLibreOffice
src/node/parse.ts            createParser (LiteParse)
src/node/lingua.ts           createLingua (LLMLingua-2 opcional)
src/server/store.ts          LRU
src/server/app.ts            createApp (rutas Hono)
src/server/start.ts          startServer
src/cli/index.ts             bin
tests/fixtures/make-pdf.ts   generador de PDF de muestra
tests/**                     pruebas de core, node y server
web/index.html · web/vite.config.ts
web/src/{main.tsx,App.tsx,theme.css,strings.ts,api.ts}
web/src/worker/{distill.worker.ts,client.ts}
web/src/state/{settings.ts,files.ts}
web/src/components/{Header,Dropzone,OptimizeBar,FileList,FileRow,Preview,Footer,ConnectPanel}.tsx
web/src/lib/{download.ts,names.ts}
web/tests/**                 pruebas de componentes (jsdom)
e2e/distill.spec.ts          Playwright
```

---

### Tarea 1: Base del repo y `mapProse`

**Archivos:**
- Crear: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` (Apache-2.0, titular "Jesus Nieves"), `src/core/types.ts`, `src/core/boosters/segments.ts`
- Prueba: `tests/core/segments.test.ts`

**Interfaces:**
- Produce: los tipos de `src/core/types.ts`:
  ```ts
  export type LocalBoosterId = 'dedupe' | 'media' | 'tables' | 'ws';
  export type BoosterId = LocalBoosterId | 'lingua';
  export interface BoosterMeta { id: BoosterId; name: string; hint: string; lossy: boolean; estimate: number }
  export type FileKind = 'PDF' | 'DOCX' | 'PPTX' | 'XLSX' | 'ODF' | 'IMG';
  export type ErrorCode = 'unsupported_type' | 'needs_libreoffice' | 'too_large' | 'password_protected' | 'timeout' | 'parse_failed';
  export interface ApiError { code: ErrorCode; message: string }
  export interface ParseResponse { id: string; name: string; kind: FileKind; pages: number; markdown: string; ms: number }
  export type LinguaModel = 'tinybert' | 'mobilebert' | 'xlm-roberta';
  export interface LinguaStatus { installed: boolean; model: LinguaModel; state: 'idle' | 'downloading' | 'ready' | 'error'; progress: number }
  export interface Health { version: string; liteparseVersion: string; libreoffice: boolean; lingua: LinguaStatus }
  ```
- Produce: `mapProse(md: string, fn: (prose: string) => string): string`. Aplica `fn` solo a los tramos fuera de fences (``` o ~~~, de 3 o más caracteres, que cierran con el mismo carácter y una longitud igual o mayor) y fuera del front-matter inicial (`---` en la línea 1 hasta el siguiente `---`). Un fence sin cerrar protege todo lo que queda hasta el final.

- [ ] **Paso 1:** crea `package.json` con `name: "distillmd"`, `type: "module"`, `engines.node: ">=20"`, `bin: { distillmd: "dist/cli.js", distill: "dist/cli.js" }`, `files: ["dist"]` y los scripts `test` (vitest run), `typecheck` (`tsc --noEmit`), `build` (`vite build && tsup`) y `dev:web` (`vite`). Instala `typescript vitest` como dev. `tsconfig` con `strict`, `module`/`moduleResolution: "NodeNext"`, `target: "ES2022"`, `lib` con `DOM` y `WebWorker`, y el alias `@core/*` → `src/core/*`.
- [ ] **Paso 2: escribe las pruebas que fallan** en `tests/core/segments.test.ts`:
  ```ts
  const up = (s: string) => s.toUpperCase();
  it('transforms prose only', () => expect(mapProse('a\n```\nb\n```\nc', up)).toBe('A\n```\nb\n```\nC'));
  it('protects tilde fences and longer fences', () => expect(mapProse('x\n~~~~\n| a  |\n~~~~\ny', up)).toBe('X\n~~~~\n| a  |\n~~~~\nY'));
  it('protects leading front-matter', () => expect(mapProse('---\ntitle: t\n---\nbody', up)).toBe('---\ntitle: t\n---\nBODY'));
  it('treats an unclosed fence as code to the end', () => expect(mapProse('a\n```\nb', up)).toBe('A\n```\nb'));
  it('is identity with identity fn', () => expect(mapProse(sample, (s) => s)).toBe(sample));
  ```
- [ ] **Paso 3:** corre `npx vitest run tests/core/segments.test.ts`. Esperado: FALLA (`mapProse` no existe).
- [ ] **Paso 4:** implementa `types.ts` y `mapProse` recorriendo las líneas con un estado `inFence`/`fenceChar`/`fenceLen`, acumulando tramos de prosa y de código, y aplicando `fn` a cada tramo de prosa unido con `\n`.
- [ ] **Paso 5:** corre las pruebas y `npm run typecheck`. Esperado: todo PASA.
- [ ] **Paso 6: Commit** con `chore: scaffold distillmd and add mapProse`.

### Tarea 2: Boosters `ws` y `tables`

**Archivos:**
- Crear: `src/core/boosters/ws.ts`, `src/core/boosters/tables.ts`
- Prueba: `tests/core/ws.test.ts`, `tests/core/tables.test.ts`

**Interfaces:**
- Consume: `mapProse` (Tarea 1).
- Produce: `collapseWhitespace(md: string): string` y `compactTables(md: string): string`.

- [ ] **Paso 1: pruebas que fallan.**
  ```ts
  expect(collapseWhitespace('# A\n\n\n\nB  \nC   D')).toBe('# A\n\nB\nC D');
  expect(collapseWhitespace('a\n```\nx    y\n\n\n\n```')).toBe('a\n```\nx    y\n\n\n\n```');
  expect(collapseWhitespace('- item\n    - nested')).toBe('- item\n    - nested');
  expect(compactTables('| Metric        | 2024   |\n|---------------|:------:|\n| Revenue       | $12.4M |'))
    .toBe('|Metric|2024|\n|-|:-:|\n|Revenue|$12.4M|');
  expect(compactTables('not | a table')).toBe('not | a table');
  expect(compactTables('|a|b|\n|-|-|')).toBe('|a|b|\n|-|-|');
  ```
  Agrega también, para los dos boosters, `it('is idempotent')` sobre un fixture mixto `tests/fixtures/mixed.md` (títulos, tabla, lista anidada, fence, imagen y link) que creas en este paso.
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa los dos sobre `mapProse`. En `ws`: varias líneas en blanco pasan a ser una, se quitan los espacios al final y las secuencias de 2 o más espacios *después* del primer carácter que no es espacio pasan a ser uno; la sangría inicial se conserva. En `tables`: un bloque de 2 o más líneas consecutivas que empiezan y terminan con `|`, donde la segunda es un separador `^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$`. Se recortan las celdas y cada separador queda en `-`, `:-`, `-:` o `:-:` según los dos puntos que tenía.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(core): whitespace and table boosters`.

### Tarea 3: Boosters `media` y `dedupe`, pipeline, tokens y formato

**Archivos:**
- Crear: `src/core/boosters/media.ts`, `src/core/boosters/dedupe.ts`, `src/core/boosters/pipeline.ts`, `src/core/tokens.ts`, `src/core/format.ts`
- Prueba: `tests/core/media.test.ts`, `tests/core/dedupe.test.ts`, `tests/core/pipeline.test.ts`, `tests/core/format.test.ts`

**Interfaces:**
- Consume: `mapProse`, `collapseWhitespace` y `compactTables`.
- Produce:
  - `slimMedia(md: string): string`
  - `dropRepeatedBoilerplate(md: string): string`
  - `BOOSTERS: readonly BoosterMeta[]`, en este orden, con estos textos exactos: `dedupe` "Drop repeated boilerplate" / "running headers, page numbers"; `media` "Slim images and links" / "keep alt and link text"; `tables` "Compact tables" / "strip alignment padding"; `ws` "Collapse whitespace" / "blank lines, padding"; `lingua` "LLMLingua-2" / "lossy, local model" con `lossy: true`. `estimate` (fracción orientativa que se muestra como −X%): dedupe 0.09, media 0.05, tables 0.14, ws 0.06, lingua 0.45.
  - `BOOSTER_ORDER: readonly LocalBoosterId[] = ['dedupe','media','tables','ws']`
  - `DEFAULT_ACTIVE: ReadonlySet<LocalBoosterId>` con los cuatro.
  - `runBoosters(md: string, active: ReadonlySet<LocalBoosterId>): string`
  - `countTokens(text: string): number` (importa `countTokens` de `gpt-tokenizer/encoding/o200k_base`)
  - `shortCount(n: number): string` y `savedPercent(raw: number, out: number): number`

- [ ] **Paso 1: pruebas que fallan.**
  ```ts
  expect(slimMedia('![Figure 3: Revenue](./img/p14.png)')).toBe('[Figure 3: Revenue]');
  expect(slimMedia('a ![](./bg.png) b')).toBe('a  b');
  expect(slimMedia('see [Exhibit A](https://x.com/a?id=1).')).toBe('see Exhibit A.');
  expect(slimMedia('```\n![x](y)\n```')).toBe('```\n![x](y)\n```');
  const doc = ['Example Co. — Report   Page 1 of 3', 'Alpha', 'Example Co. — Report   Page 2 of 3', 'Beta', 'Example Co. — Report   Page 3 of 3', 'Gamma'].join('\n');
  expect(dropRepeatedBoilerplate('X\nCONFIDENTIAL\nA\nCONFIDENTIAL\nB\nCONFIDENTIAL')).toBe('X\nCONFIDENTIAL\nA\nB');
  expect(dropRepeatedBoilerplate(doc)).toBe('Example Co. — Report   Page 1 of 3\nAlpha\nBeta\nGamma');
  expect(dropRepeatedBoilerplate('## H\n## H\n## H')).toBe('## H\n## H\n## H');
  expect(dropRepeatedBoilerplate('- a\n- a\n- a')).toBe('- a\n- a\n- a');
  expect(dropRepeatedBoilerplate('|a|\n|a|\n|a|')).toBe('|a|\n|a|\n|a|');
  expect(shortCount(38914)).toBe('38.9k'); expect(shortCount(412)).toBe('412'); expect(shortCount(2_400_000)).toBe('2.4M');
  expect(savedPercent(100, 70)).toBe(30); expect(savedPercent(0, 0)).toBe(0);
  expect(runBoosters(md, new Set())).toBe(md);
  expect(countTokens('hello world')).toBeGreaterThan(0);
  ```
  La firma de comparación de `dedupe` normaliza los dígitos (`\d+` → `#`) y los espacios, y por eso "Page 1 of 3" y "Page 2 of 3" cuentan como la misma línea. Pruebas del pipeline sobre `tests/fixtures/mixed.md`:
  - `it('applies boosters in fixed order regardless of Set order')`: los resultados con `new Set(['ws','dedupe'])` y `new Set(['dedupe','ws'])` son iguales.
  - `it('is idempotent with all boosters')`.
  - `it('keeps every alphanumeric word except URLs/paths and repeats')`: es el invariante de la spec §4.2. Compara el conjunto de palabras `\p{L}[\p{L}\p{N}]*` del crudo, sin las que vienen de URLs y rutas de `](…)`, contra el conjunto del resultado.
  - `it('runs 2M chars under 1500ms')`: el fixture se genera repitiendo `mixed.md`.
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa. En `dedupe`, solo cuentan las líneas de prosa de longitud ≤ 120 tras `trim` que no empiezan con `#`, `|`, `-`, `*`, `+`, `>` ni `\d+.`. Si una firma aparece 3 o más veces, se conserva la primera línea y se quitan las demás. `runBoosters` recorre `BOOSTER_ORDER` y aplica los que están en `active`.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN, incluida la de rendimiento.
- [ ] **Paso 5: Commit** con `feat(core): media/dedupe boosters, pipeline, token counting`.

### Tarea 4: Parser LiteParse y detección de capacidades

**Archivos:**
- Crear: `src/node/errors.ts`, `src/core/kind.ts` (puro; también lo usa el cliente), `src/node/capabilities.ts`, `src/node/parse.ts`, `tests/fixtures/make-pdf.ts`
- Prueba: `tests/core/kind.test.ts`, `tests/node/parse.test.ts`

**Interfaces:**
- Produce:
  - `class DistillError extends Error { constructor(readonly code: ErrorCode, message: string) }`
  - `detectKind(filename: string): FileKind | null`. Las extensiones se comparan sin importar mayúsculas: `.pdf`→PDF; `.docx/.doc`→DOCX; `.pptx/.ppt`→PPTX; `.xlsx/.xls/.csv`→XLSX; `.odt/.ods/.odp`→ODF; `.png/.jpg/.jpeg/.tif/.tiff/.webp`→IMG.
  - `needsLibreOffice(kind: FileKind): boolean`, que es verdadero para DOCX, PPTX, XLSX y ODF.
  - `hasLibreOffice(): Promise<boolean>`: busca `soffice` o `libreoffice` en el PATH, y en macOS también `/Applications/LibreOffice.app/Contents/MacOS/soffice`.
  - `interface Parser { toMarkdown(path: string): Promise<{ markdown: string; pages: number }>; toJson(path: string): Promise<unknown>; close(): void }`
  - `createParser(opts?: { poolSize?: number; timeoutMs?: number }): Parser`
  - `makeSamplePdf(lines: string[]): Buffer`, en `tests/fixtures/make-pdf.ts`: escribe a mano un PDF 1.4 válido con una página y texto Helvetica, sin dependencias.

- [ ] **Paso 1: pruebas que fallan.**
  ```ts
  expect(detectKind('Report.PDF')).toBe('PDF'); expect(detectKind('a.tar.gz')).toBeNull(); expect(detectKind('noext')).toBeNull();
  const parser = createParser({ poolSize: 1 });
  it('parses a sample pdf to markdown', async () => {
    const p = await writeTmp('sample.pdf', makeSamplePdf(['Quarterly Report', 'Revenue grew']));
    const r = await parser.toMarkdown(p);
    expect(r.pages).toBe(1); expect(r.markdown).toContain('Quarterly Report');
  });
  it('maps corrupt input to parse_failed', async () => {
    await expect(parser.toMarkdown(await writeTmp('bad.pdf', Buffer.from('%PDF-1.4 garbage')))).rejects.toMatchObject({ code: 'parse_failed' });
  });
  it('maps timeouts to timeout', async () => {
    const slow = createParser({ poolSize: 1, timeoutMs: 1 });
    await expect(slow.toMarkdown(bigPdfPath)).rejects.toMatchObject({ code: 'timeout' });
  });
  ```
  `bigPdfPath` es un `makeSamplePdf` de 5 000 líneas. Cierra los parsers en `afterAll`.
- [ ] **Paso 2:** instala `@llamaindex/liteparse@^2.18.0` y corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa `createParser` con una instancia `new LiteParse({ outputFormat: 'markdown', imageMode: 'placeholder', extractLinks: true, keepHeadersFooters: false, ocrEnabled: true, quiet: true, poolSize, parseTimeoutMs: timeoutMs ?? 120_000 })` y otra igual pero con `outputFormat: 'json'`, que se crea la primera vez que se pide. Mapeo de errores: `ParseTimeoutError` → `timeout`; un mensaje que contiene `password` o `encrypted` (sin importar mayúsculas) → `password_protected`; cualquier otro → `parse_failed`, con el mensaje original recortado a 200 caracteres. `pages` es `result.totalPages`.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(node): LiteParse wrapper, kind detection, capabilities`.

### Tarea 5: LLMLingua-2 opcional

**Archivos:**
- Crear: `src/node/lingua.ts`
- Prueba: `tests/node/lingua.test.ts`

**Interfaces:**
- Produce: `interface Lingua { status(): LinguaStatus; compress(text: string, opts: { rate: number; model?: LinguaModel }): Promise<string> }` y `createLingua(opts: { cacheDir: string; load?: () => Promise<unknown> }): Lingua`. `load` permite inyectar el módulo en las pruebas; por defecto es `() => import('@atjsh/llmlingua-2')`.
- Ids de modelo (copiar tal cual): `tinybert` → `atjsh/llmlingua-2-js-tinybert-meetingbank`; `mobilebert` → `atjsh/llmlingua-2-js-mobilebert-meetingbank`; `xlm-roberta` → `atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank` (este con `modelSpecificOptions.use_external_data_format: { "model.onnx": 1 }`).

- [ ] **Paso 1: pruebas que fallan** (con un `load` falso):
  ```ts
  it('reports not installed when import fails', () => {
    const l = createLingua({ cacheDir: tmp, load: () => Promise.reject(new Error('missing')) });
    return l.compress('x', { rate: 0.6 }).catch(() => expect(l.status()).toMatchObject({ installed: false, state: 'error' }));
  });
  it('starts idle with tinybert', () => expect(createLingua({ cacheDir: tmp, load: fakeOk }).status()).toEqual({ installed: true, model: 'tinybert', state: 'idle', progress: 0 }));
  it('moves to ready and compresses by chunks', async () => {
    const l = createLingua({ cacheDir: tmp, load: fakeOk });
    const out = await l.compress(longText, { rate: 0.5 });
    expect(l.status().state).toBe('ready'); expect(fakeCompressor.calls.length).toBeGreaterThan(1); expect(out.length).toBeLessThan(longText.length);
  });
  it('rejects rate outside 0.3..0.9', () => expect(createLingua({ cacheDir: tmp, load: fakeOk }).compress('x', { rate: 0.1 })).rejects.toThrow());
  ```
  `installed` empieza en `true` y pasa a `false` solo si falla el import.
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa. Primero revisa la factory en https://llmlingua-2-js-typedoc.vercel.app/modules/LLMLingua2.html y pásale `transformerJSConfig: { device: 'cpu', dtype: 'fp32' }`. Asigna `env.cacheDir` de transformers.js a `${cacheDir}/models` y conecta `progress_callback` a `progress` mientras `state` está en `'downloading'`. Divide el texto en fragmentos de unos 512 tokens por párrafos (con `countTokens` de core) y comprime cada uno con `rate`. Agrega los tres paquetes en `optionalDependencies` del `package.json`.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(node): optional LLMLingua-2 compression`.

### Tarea 6: Servidor Hono

**Archivos:**
- Crear: `src/server/store.ts`, `src/server/app.ts`, `src/server/start.ts`
- Prueba: `tests/server/app.test.ts`, `tests/server/store.test.ts`

**Interfaces:**
- Consume: `Parser`, `Lingua`, `detectKind`, `needsLibreOffice`, `DistillError`, `hasLibreOffice`.
- Produce:
  - `createStore(opts: { maxFiles: number; maxBytes: number }): Store`, con `Store { put(e: StoredFile): void; get(id: string): StoredFile | undefined }` y `StoredFile { id: string; name: string; kind: FileKind; bytes: Uint8Array; markdown: string }`. Desaloja al menos usado cuando se pasa de archivos o de bytes.
  - `createApp(deps: { parser: Parser; lingua: Lingua; store: Store; maxBytes: number; libreoffice: boolean; version: string; liteparseVersion: string; webRoot?: string }): Hono`
  - `startServer(opts: { port: number; host: string; maxBytes: number }): Promise<{ url: string; close(): Promise<void> }>`
- Rutas y códigos: los de la spec §5. Respuestas de error: 400 `unsupported_type`; 413 `too_large`; 422 `needs_libreoffice`, `password_protected` y `parse_failed`; 504 `timeout`; 503 en `/api/compress` si `lingua.status().installed` es `false`. El cuerpo siempre es `ApiError`.

- [ ] **Paso 1: pruebas que fallan**, con `app.request()` y un `Parser` y un `Lingua` falsos:
  ```ts
  it('GET /api/health returns capabilities', ...)                    // { version, liteparseVersion, libreoffice:false, lingua:{...} }
  it('POST /api/parse returns markdown and stores bytes', ...)       // 200, body.markdown, body.kind 'PDF', store.get(body.id) defined
  it('rejects unknown extension with 400 unsupported_type', ...)
  it('rejects > maxBytes with 413 too_large', ...)                   // maxBytes: 10, archivo de 11 bytes
  it('returns 422 needs_libreoffice for .docx when libreoffice=false', ...)
  it('maps parser timeout to 504 timeout', ...)
  it('deletes the temp file after parsing, even on error', ...)      // el Parser falso guarda la ruta; tras responder, fs.existsSync(path) === false
  it('GET /api/files/:id/json re-parses stored bytes; 404 for unknown id', ...)
  it('POST /api/compress returns 503 when lingua not installed', ...)
  it('serves index.html for unknown non-api paths when webRoot set', ...)
  ```
  Y en el store: `it('evicts least recently used past maxFiles')` y `it('evicts past maxBytes')`.
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa. Para cada subida: `mkdtemp(os.tmpdir()/distill-)`, escribir el archivo con su extensión original y borrar con `rm -rf` en un `finally`. El `id` es `crypto.randomUUID()`. Valida el tamaño con `Content-Length` y con el tamaño del archivo. Los estáticos van con `serveStatic` de `@hono/node-server`, y una ruta de respaldo devuelve `index.html`. `startServer` crea el parser, el lingua (`cacheDir: ~/.cache/distillmd`) y el store (50 archivos / 200 MB), llama a `hasLibreOffice` una sola vez al arrancar, toma la `version` del `package.json` y la `liteparseVersion` del `package.json` de `@llamaindex/liteparse`.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(server): Hono API for parse, json, compress, health`.

### Tarea 7: CLI y build

**Archivos:**
- Crear: `src/cli/index.ts`, `tsup.config.ts`
- Prueba: `tests/cli/cli.test.ts`

**Interfaces:**
- Consume: `startServer`.
- Produce: el bin `distillmd`, con el comando por defecto `web` y las opciones `--port <n>` (4321), `--host <h>` (127.0.0.1), `--max-size <mb>` (100) y `--no-open`. Al arrancar imprime `distill running at http://127.0.0.1:4321` y abre el navegador con `open` (mac), `xdg-open` (linux) o `start` (win), salvo que se pase `--no-open`.

- [ ] **Paso 1: prueba que falla.** Lanza `node dist/cli.js --port 0 --no-open`, lee la URL de stdout, hace `GET /api/health` y espera `200` y `version` igual a la del `package.json`. Después mata el proceso.
- [ ] **Paso 2:** `tsup.config.ts` con la entrada `src/cli/index.ts` → `dist/cli.js` (ESM, banner `#!/usr/bin/env node`, `@llamaindex/liteparse` y los paquetes de lingua como `external`). El servidor sirve `dist/web` como `webRoot`, resuelto relativo a `import.meta.url`.
- [ ] **Paso 3:** implementa el CLI con commander. Si el puerto está ocupado, termina con el código 1 y el mensaje `Port 4321 is in use. Try --port 4322`.
- [ ] **Paso 4:** corre `npm run build && npx vitest run tests/cli`. Esperado: PASA.
- [ ] **Paso 5: Commit** con `feat(cli): distillmd web command`.

### Tarea 8: Esqueleto de la SPA, tema y worker

**Archivos:**
- Crear: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/theme.css`, `web/src/strings.ts`, `web/src/api.ts`, `web/src/worker/distill.worker.ts`, `web/src/worker/client.ts`, `web/src/components/Header.tsx`, `web/src/components/Dropzone.tsx`
- Prueba: `web/tests/worker.test.ts`, `web/tests/header.test.tsx`

**Interfaces:**
- Consume: `runBoosters`, `countTokens` y los tipos de core (alias `@core`).
- Produce:
  - `api.ts`: `getHealth(): Promise<Health>`; `parseFile(file: File, signal?: AbortSignal): Promise<ParseResponse>`, que lanza `ApiError` si la respuesta no es ok; `getJson(id: string): Promise<unknown>`; `compress(text: string, rate: number, model: LinguaModel): Promise<string>`.
  - `worker/client.ts`: `distill(raw: string, active: LocalBoosterId[]): Promise<{ out: string; rawTokens: number; outTokens: number }>`, que corre en un Worker (Vite `?worker`) y guarda en caché por `raw` el conteo de tokens del crudo.
  - `strings.ts`: `S` con los textos del diseño: `tagline: ['Documents in. ', 'Fewer tokens', ' out.']`, `drop: 'Drop files here'`, `or: 'or'`, `browse: 'browse'`, `formats: 'PDF · DOCX · PPTX · XLSX · images · parsed locally'`, `optimize: 'Optimize for LLMs'`, `compact: 'Compact'`, `detailed: 'Detailed'`, `downloadAll: 'Download all'`, `copy: 'Copy Markdown'`, `copied: 'Copied'`, `download: 'Download Markdown'`, `connect: 'Connect your agent'`, `github: 'Source on GitHub'`, `lossyNote: 'Lossy: a local model removes low-value words. Downloads once, then runs offline.'` y los mensajes de error por `ErrorCode` (Tarea 11).
- Vite: `root: 'web'`, `build.outDir: '../dist/web'`, proxy de `/api` a `http://127.0.0.1:4321`. Fuentes: `@fontsource/inter` (400, 500, 600, 700), `@fontsource/space-grotesk` (700) y `@fontsource/jetbrains-mono` (400, 700).

- [ ] **Paso 1: pruebas que fallan.** Del worker: llamar directamente al handler del worker con el `mixed.md` y `['ws','tables']` devuelve `outTokens < rawTokens` y `out === runBoosters(...)`. Del header: renderiza la marca "distill", los botones Compact/Detailed con `aria-pressed` y los dos links con `aria-label`.
- [ ] **Paso 2:** corre `npx vitest run web/tests` (en `vitest.config.ts`, el `environment` es `jsdom` para `web/**`). Esperado: FALLAN.
- [ ] **Paso 3:** implementa `theme.css` con los tokens de las restricciones globales como variables en `:root`, `body { background: var(--bg) }`, la regla `@media (max-width: 640px)` de las áreas táctiles y `@media (prefers-reduced-motion: reduce)`, que apaga todas las transiciones y animaciones. Implementa también `Header`, `Dropzone` (todavía sin lógica: solo props `onFiles(files: File[])`) y `App`, que monta Header + tagline + Dropzone. Usa como medidas las del artboard Midnight Lime.
- [ ] **Paso 4:** corre las pruebas y `npx vite build`. Esperado: PASAN y se genera `dist/web/index.html`.
- [ ] **Paso 5: Commit** con `feat(web): app shell, theme, distill worker`.

### Tarea 9: Cola de archivos, ajustes y Optimize

**Archivos:**
- Crear: `web/src/state/files.ts`, `web/src/state/settings.ts`, `web/src/components/OptimizeBar.tsx`, `web/src/components/FileList.tsx`, `web/src/components/FileRow.tsx`, `web/src/components/Footer.tsx`
- Modificar: `web/src/components/Dropzone.tsx`, `web/src/App.tsx`
- Prueba: `web/tests/files.test.ts`, `web/tests/app.test.tsx`

**Interfaces:**
- Consume: `parseFile`, `distill`, `BOOSTERS` (con `estimate`), `DEFAULT_ACTIVE`, `shortCount`, `savedPercent` y `detectKind` (de `src/core/kind.ts`).
- Produce:
  - `FileEntry { localId: string; name: string; size: number; kind: FileKind | null; status: 'queued' | 'parsing' | 'done' | 'error'; error?: ApiError; serverId?: string; raw?: string; out?: string; rawTokens?: number; outTokens?: number }`
  - `useFiles(settings: Settings): { files: FileEntry[]; add(files: File[]): void }`. Mantiene como máximo 3 subidas simultáneas. Si `size > maxBytes` o `kind === null`, marca el error en el cliente sin subir. Cuando cambian los ajustes, vuelve a correr `distill` sobre cada `raw`.
  - `Settings { optimize: boolean; active: LocalBoosterId[]; detailed: boolean; optionsOpen: boolean; lingua: { on: boolean; model: LinguaModel; rate: number } }`. `useSettings()` guarda en `localStorage['distill:settings']` y, si el valor está corrupto o el storage falla (con try/catch), usa los valores por defecto: optimize true, los cuatro activos, detailed false, lingua apagado, tinybert y 0.6.
- Dropzone: acepta soltar archivos y carpetas (`webkitGetAsEntry`, recursivo), `<input type=file multiple>` y pegar (`paste` en `window` con `clipboardData.files`).

- [ ] **Paso 1: pruebas que fallan** (con `fetch` y `distill` simulados):
  ```ts
  it('rejects files over max size client-side without uploading', ...)            // error.code 'too_large', fetch not called
  it('marks unknown extensions unsupported_type client-side', ...)
  it('keeps two rows for the same file dropped twice', ...)                        // ids distintos
  it('limits concurrent uploads to 3', ...)                                        // 6 archivos, nunca más de 3 en 'parsing'
  it('one failing file does not stop the rest', ...)                               // fetch responde 504 timeout a uno; los demás quedan en 'done'
  it('toggling a booster recomputes out without refetching', ...)
  it('optimize off shows equal raw and out counts', ...)                           // en App: el pie muestra '0%'
  it('settings survive reload and ignore corrupt localStorage', ...)
  ```
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa los hooks y componentes según el artboard compacto:
  - **OptimizeBar:** el switch con `role="switch"` y el resumen "N boosters" con chevron y `aria-expanded`, que despliega checkboxes con `role="switch"` y el `−X%` de cada booster tomado de `BOOSTERS[].estimate`.
  - **FileRow:** etiqueta de tipo con su color, nombre con elipsis y `rawTokens → outTokens` en `shortCount`. El `−X%` va en `--accent` y en negrita. En estado `parsing` muestra una barra indeterminada y "OCR" si `kind === 'IMG'`.
  - **Footer:** el % total en Space Grotesk 26px, más `tokens · 55.2k → 38.6k · 3/4 files`.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(web): upload queue, settings, optimize toggles`.

### Tarea 10: Vista previa, copiar, descargar y ZIP

**Archivos:**
- Crear: `web/src/components/Preview.tsx`, `web/src/lib/download.ts`, `web/src/lib/names.ts`
- Modificar: `web/src/components/FileRow.tsx`, `web/src/components/Footer.tsx`
- Prueba: `web/tests/names.test.ts`, `web/tests/preview.test.tsx`

**Interfaces:**
- Produce:
  - `mdName(original: string): string`: cambia la extensión por `.md` y conserva Unicode.
  - `uniqueNames(names: string[]): string[]`: agrega ` (2)`, ` (3)`… antes de `.md`.
  - `downloadText(name: string, text: string): void` y `downloadZip(entries: { name: string; text: string }[]): Promise<void>`, con `fflate` `zipSync` y `strToU8`. El nombre del ZIP es `distill-YYYY-MM-DD.zip`.

- [ ] **Paso 1: pruebas que fallan.**
  ```ts
  expect(mdName('Informe Año 2025 📊.pdf')).toBe('Informe Año 2025 📊.md');
  expect(mdName('noext')).toBe('noext.md');
  expect(uniqueNames(['a.md', 'a.md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md']);
  it('expands one row at a time and shows out text', ...)          // por defecto se abre la primera fila 'done'
  it('copy writes out to clipboard and flips aria-label to Copied', ...)
  it('Download all includes only done files', ...)
  ```
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa. La vista previa es un `<pre>` con `max-height: 120px` (en Detailed, 260px) y el fondo `--surface`. Copiar usa `navigator.clipboard.writeText` y vuelve a "Copy Markdown" a los 1.5 s.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(web): preview, copy, download and zip`.

### Tarea 11: Vista Detailed, LLMLingua-2 en la UI, errores y panel de agentes

**Archivos:**
- Crear: `web/src/components/ConnectPanel.tsx`
- Modificar: `web/src/components/{Header,OptimizeBar,FileRow,Preview}.tsx`, `web/src/state/files.ts`, `web/src/strings.ts`
- Prueba: `web/tests/detailed.test.tsx`, `web/tests/errors.test.tsx`

**Interfaces:**
- Consume: `getHealth`, `getJson` y `compress`.
- Produce: `S.errors: Record<ErrorCode, string>`:
  - `unsupported_type`: 'Unsupported file type'
  - `needs_libreoffice`: 'Office files need LibreOffice — install it and restart distill'
  - `too_large`: 'File is larger than the size limit'
  - `password_protected`: 'Password-protected file'
  - `timeout`: 'Took too long to parse'
  - `parse_failed`: 'Could not read this file'

- [ ] **Paso 1: pruebas que fallan.**
  ```ts
  it('Detailed shows booster hints, savings bar and Markdown/JSON tabs', ...)
  it('JSON tab fetches /api/files/:id/json once and caches it', ...)
  it('lingua switch is disabled with "not installed" when health.lingua.installed=false', ...)
  it('lingua on calls compress after local boosters and shows lossy note', ...)
  it('lingua download state polls /api/health every 1s until ready', ...)    // muestra "Downloading model 42%"
  it('needs_libreoffice row shows install hint link', ...)                   // enlaza a https://www.libreoffice.org/download/
  it('Connect panel lists Claude Code, Claude Desktop, OpenCode, Codex, ChatGPT with "coming in v0.2" for MCP', ...)
  ```
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa:
  - **Detailed** (con `settings.detailed`): las explicaciones de los boosters, un `<select>` de modelo (tinybert, mobilebert y xlm-roberta, con sus tamaños: 57 MB, 99 MB y 2.2 GB) y un slider de `rate` de 0.3 a 0.9 con pasos de 0.05. Por fila: una barra de ahorro, `38,914 → 27,137 tokens (o200k)` con un `title` que dice "Counted with OpenAI o200k. Other models tokenize differently; the % saved is comparable.", y las pestañas Markdown / JSON + boxes.
  - **LLMLingua:** se aplica sobre la salida de los boosters locales, con un debounce de 400 ms al cambiar `rate`.
  - **ConnectPanel:** un `<dialog>` lateral que se abre desde el ícono de enlace, con un bloque por cliente y una nota de que MCP y los hooks llegan en la fase 2 y la 3.
- [ ] **Paso 4:** corre las pruebas. Esperado: PASAN.
- [ ] **Paso 5: Commit** con `feat(web): detailed view, LLMLingua controls, errors, connect panel`.

### Tarea 12: E2E, Docker, CI y README

**Archivos:**
- Crear: `e2e/distill.spec.ts`, `playwright.config.ts`, `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consume: todo lo anterior y `makeSamplePdf`.

- [ ] **Paso 1: prueba E2E que falla.** `playwright.config.ts` usa como `webServer` `node dist/cli.js --port 4399 --no-open`. Flujo: soltar el PDF de muestra con `setInputFiles` en el input del Dropzone → la fila muestra `PDF` y un `−` seguido de un número y `%` → copiar → el `aria-label` cambia a "Copied" → apagar "Optimize for LLMs" → el pie muestra `0%`.
- [ ] **Paso 2:** corre `npm run build && npx playwright test`. Esperado: primero FALLA si algo no está conectado y, al terminar la tarea, PASA.
- [ ] **Paso 3:** escribe el `Dockerfile`: `node:22-slim`; `apt-get install --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress tesseract-ocr-eng tesseract-ocr-spa`; `npm ci --omit=dev`; copia `dist/`; `EXPOSE 4321`; `CMD ["node","dist/cli.js","--host","0.0.0.0","--no-open"]`; agrega la etiqueta `org.opencontainers.image.source=https://github.com/nievesjesus/distill`.
- [ ] **Paso 4:** escribe `ci.yml` con una matriz de `ubuntu-latest` y `macos-latest` en Node 22 que corre `npm ci`, `npm run typecheck`, `npm test`, `npm run build` y `npx playwright install --with-deps chromium && npx playwright test`.
- [ ] **Paso 5:** escribe el `README.md` en inglés con: el hook de una línea, `npx distillmd`, Docker, formatos y el requisito de LibreOffice, qué hace cada booster (incluido que "Slim images and links" quita URLs), cómo se cuentan los tokens (o200k), privacidad (local, sin telemetría), el roadmap (MCP, CLI, hooks), un hueco para el GIF y la licencia. No inventes cifras de rendimiento.
- [ ] **Paso 6:** verifica `docker build -t distill . && docker run --rm -p 4321:4321 distill` y que `curl -s localhost:4321/api/health` devuelva `"libreoffice":true`.
- [ ] **Paso 7: Commit** con `chore: e2e, docker, ci, readme`.

### Tarea 13: App de escritorio (Electron)

> Agregada el 2026-11-06 por decisión del usuario (spec §9.1). Depende de las Tareas 7 a 12: carga la misma UI y el mismo servidor.

**Archivos:**
- Crear: `desktop/main.ts`, `desktop/window.ts`, `desktop/tsup.desktop.config.ts`, `tests/desktop/window.test.ts`, `e2e/desktop.spec.ts`
- Modificar: `package.json` (scripts `build:desktop` y `desktop`; dev dep `electron`)

**Interfaces:**
- Consume: `startServer({ port: 0, host: '127.0.0.1', maxBytes })` de `src/server/start.ts`, que devuelve `{ url, close() }`.
- Produce:
  - `windowOptions(): BrowserWindowConstructorOptions`. Es una función pura: `width: 760, height: 860, minWidth: 420, minHeight: 560, title: 'distill', backgroundColor: '#0B0B10', show: false` y `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }`.
  - `isAllowedExternal(url: string): boolean`: true solo si el protocolo es `https:`.
  - `isSameOrigin(target: string, appUrl: string): boolean`.
  - `dist/desktop/main.js` (ESM), que es el `main` del paquete Electron.

- [ ] **Paso 1: pruebas que fallan** (unitarias, sin Electron):
  ```ts
  expect(windowOptions()).toMatchObject({ width: 760, height: 860, minWidth: 420, minHeight: 560, backgroundColor: '#0B0B10', show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  expect(isAllowedExternal('https://www.libreoffice.org/download/')).toBe(true);
  expect(isAllowedExternal('http://evil.example')).toBe(false); expect(isAllowedExternal('file:///etc/passwd')).toBe(false); expect(isAllowedExternal('javascript:alert(1)')).toBe(false);
  expect(isSameOrigin('http://127.0.0.1:5123/x', 'http://127.0.0.1:5123/')).toBe(true);
  expect(isSameOrigin('http://127.0.0.1:9999/', 'http://127.0.0.1:5123/')).toBe(false);
  ```
- [ ] **Paso 2:** corre las pruebas. Esperado: FALLAN.
- [ ] **Paso 3:** implementa `desktop/window.ts` y `desktop/main.ts`. El main hace esto:
  - `app.requestSingleInstanceLock()`; si no lo obtiene, `app.quit()`; en `second-instance`, restaura y enfoca la ventana.
  - En `ready`: `startServer` en el puerto 0 con 100 MB, crea la ventana, `loadURL(url)` y la muestra en `ready-to-show`.
  - `will-navigate`: `preventDefault` si el destino no es del mismo origen, y lo abre con `shell.openExternal` solo si `isAllowedExternal`.
  - `setWindowOpenHandler`: abre el link externo permitido y devuelve `{ action: 'deny' }`.
  - `window-all-closed`: `await close()` y luego `app.quit()`, en todas las plataformas.
  - Si `startServer` falla: `dialog.showErrorBox('distill could not start', message)` y `app.quit()`.
  - Antes de `startServer` asigna `process.env.ELECTRON_RUN_AS_NODE` solo si la prueba del Paso 5 muestra que el `fork()` de LiteParse lo necesita. Registra el hallazgo en el reporte.
  - Build: `tsup` con su propia config para `desktop/main.ts` → `dist/desktop/main.js` (esm, node20, `electron` y las dependencias externas, `clean: false`).
  - Scripts: `build:desktop` = `npm run build && tsup --config desktop/tsup.desktop.config.ts`; `desktop` = `npm run build:desktop && electron dist/desktop/main.js`.
- [ ] **Paso 4:** corre las pruebas unitarias. Esperado: PASAN.
- [ ] **Paso 5: humo E2E** en `e2e/desktop.spec.ts` con `_electron.launch({ args: ['dist/desktop/main.js'] })` de Playwright. La ventana carga, el título es "distill" y el texto "Fewer tokens" está visible. Además, suelta el PDF de muestra (`makeSamplePdf`) en el input del Dropzone y espera a que la fila muestre un `%` de ahorro: eso prueba que el `fork()` de LiteParse funciona dentro de Electron. Al cerrar la app, el proceso termina en menos de 5 s. Esperado: PASA.
- [ ] **Paso 6: Commit** con `feat(desktop): Electron shell around the local server`.

### Tarea 14: Instaladores lite/full y release

> Agregada el 2026-11-06 (spec §9.1). Depende de la Tarea 13.

**Archivos:**
- Crear: `electron-builder.lite.yml`, `electron-builder.full.yml`, `.github/workflows/release.yml`, `scripts/check-variant.mjs`
- Modificar: `package.json` (scripts `dist:lite` y `dist:full`; dev dep `electron-builder`), `README.md` (sección Desktop)

**Interfaces:**
- Consume: `dist/desktop/main.js`, `dist/cli.js` y `dist/web` (Tarea 13).
- Produce, por variante, artefactos `Distill-<lite|full>-${version}-${os}-${arch}.${ext}`.

- [ ] **Paso 1:** escribe `electron-builder.lite.yml` y `electron-builder.full.yml`, que comparten la base:
  - `appId: dev.nievesjesus.distill` y `productName: distill`
  - `directories.output: release/<variante>`
  - `files: ["dist/**", "package.json", "node_modules/**"]`
  - `asarUnpack: ["node_modules/@llamaindex/**"]`; la full agrega además `node_modules/onnxruntime-node/**` y `node_modules/sharp/**`
  - `mac: { target: dmg, arch: [arm64, x64], identity: null }`, `win: { target: nsis, arch: [x64] }`, `linux: { target: AppImage, arch: [x64] }`
  - `artifactName` según el patrón de arriba
  - `publish: null`
  - La lite agrega a `files` las exclusiones `"!node_modules/@atjsh/**"`, `"!node_modules/@huggingface/**"`, `"!node_modules/js-tiktoken/**"`, `"!node_modules/onnxruntime-*/**"` y `"!node_modules/sharp/**"`.
- [ ] **Paso 2:** `scripts/check-variant.mjs <ruta-al-resources/app.asar.unpacked-o-app> <lite|full>` verifica que la variante lite no contenga `@atjsh/llmlingua-2` ni `onnxruntime-node`, que la full sí los tenga y que las dos tengan el `.node` de liteparse de su plataforma. Termina con código 1 si algo falla.
- [ ] **Paso 3:** corre localmente `npm run dist:lite -- --mac --arm64 --dir` y `npm run dist:full -- --mac --arm64 --dir` (`--dir` deja la app sin empaquetar, más rápido), luego `node scripts/check-variant.mjs` sobre cada una. Abre la app lite empaquetada con `_electron.launch({ executablePath })` y repite el humo de la Tarea 13: soltar el PDF y ver el `%`. Esperado: PASA.
- [ ] **Paso 4:** escribe `release.yml`:
  - Se dispara en `push` de tags `v*` y con `workflow_dispatch`.
  - Matriz: `macos-14` (arm64), `macos-13` (x64), `windows-latest` (x64) y `ubuntu-latest` (x64), con Node 22.
  - Pasos: `npm ci`, `npm run check:deps`, `npm run build:desktop`, `npm run dist:lite`, `npm run dist:full` y `check-variant`, y sube `release/**/Distill-*` como artefactos.
  - Un job final con `softprops/action-gh-release` (versión fijada) crea el Release en **borrador** (`draft: true`) con todos los instaladores. Nunca publica solo.
  - `permissions: contents: write`, únicamente en ese job.
- [ ] **Paso 5:** agrega al README una sección "Desktop app" con las descargas lite y full, la diferencia entre las dos (LLMLingua-2), cómo abrir una app sin firmar la primera vez en macOS (clic derecho → Abrir) y en Windows (SmartScreen → More info → Run anyway), y el requisito de LibreOffice para archivos Office.
- [ ] **Paso 6: Commit** con `build(desktop): lite/full installers and draft release workflow`.

### Tarea 15: Ventana nativa y layout fluido en la app de escritorio

> Agregada el 2026-11-06 a pedido del usuario: "la ventana se tiene que comportar como una ventana nativa, ser más fluida al sizing de la ventana, ajustable, con un min height". Depende de las Tareas 13 y 14.

**Archivos:**
- Crear: `desktop/window-state.ts`, `tests/desktop/window-state.test.ts`, `web/src/lib/shell.ts`, `tests/web/shell.test.ts` (o la carpeta de tests web que ya use el repo)
- Modificar: `desktop/window.ts`, `desktop/main.ts`, `tests/desktop/window.test.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/components/Header.tsx`, `web/src/theme.css`, `e2e/desktop.spec.ts`

**Comportamiento esperado:**

1. **Tamaño y límites de la ventana** (`windowOptions(platform)`):
   - Por defecto 640 × 780 y mínimos `minWidth: 440` y `minHeight: 520`. A ese mínimo, todo sigue usable sin scroll horizontal y con el footer visible.
   - Se queda `show: false` + `ready-to-show` y `backgroundColor: '#0B0B10'` para que no haya flash blanco al abrir ni al redimensionar.
2. **Barra de título integrada**, como las apps nativas modernas:
   - macOS: `titleBarStyle: 'hiddenInset'`, con los semáforos alineados verticalmente al centro de la barra superior.
   - Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay: { color: '#0B0B10', symbolColor: '#A0A0AE', height: 40 }`.
   - Linux: marco nativo, sin cambios.
3. **Recordar posición y tamaño** (`desktop/window-state.ts`):
   - Guardar `{ x, y, width, height, maximized, fullScreen }` en `app.getPath('userData')/window-state.json`. Se toma de `getNormalBounds()` al cerrar la ventana, y también con debounce (~500 ms) en `resize`/`move`. La escritura es atómica (temporal + rename).
   - Una función pura `restoreBounds(saved, workAreas, defaults, mins)`:
     - Si el JSON falta o es inválido, usa los defaults centrados.
     - Si el rectángulo guardado ya no cae en ningún display (monitor desconectado), lo recentra en el principal.
     - Recorta el tamaño al área de trabajo y nunca baja de los mínimos.
     - Al abrir, restaura el estado maximizado o de pantalla completa.
4. **Shell de escritorio en la web.** `main.ts` carga `appUrl + '?shell=desktop&platform=<process.platform>'`. `web/src/lib/shell.ts` lee esos parámetros, pone `data-shell="desktop"` y `data-platform` en `<html>` y no hace nada en el navegador. El guard de navegación sigue aceptando la URL (mismo origen).
5. **Layout de app con scroll interno** (solo bajo `[data-shell='desktop']`; la web en el navegador queda como está):
   - `html`, `body` y `#root` a 100% de alto; `body` con `overflow: hidden` y `overscroll-behavior: none` (sin rebote ni scroll de página).
   - La barra superior (marca, Compact/Detailed, Connect, GitHub) es una franja de 40 px a todo el ancho y arrastrable (`-webkit-app-region: drag`). Sus controles interactivos usan `no-drag`. Deja libre la zona de los semáforos en macOS (~78 px a la izquierda) y la de los controles del overlay en Windows (`env(titlebar-area-x/width)`, con fallback de 140 px a la derecha). El contenido de la barra se alinea con la columna.
   - Debajo va una zona fija con tagline, dropzone y barra de optimización. Luego la **lista de archivos como único contenedor con scroll** (`flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable`) y el **footer fijo abajo** (siempre visible, con borde superior `--border-soft`).
   - **Ancho fluido:** la columna usa todo el ancho menos 16 px de margen por lado, hasta un máximo de 720 px (en el navegador sigue en 520). La densidad tipográfica no cambia: mismas fuentes, filas de 34 px y controles de 24–30 px. Los previews crecen con la ventana (`max-height: min(45vh, 480px)` en Detailed y `min(28vh, 240px)` en Compact).
   - Con la ventana baja (alto ≤ 600 px) el tagline se oculta para dejar espacio a la lista. Debajo de 440 px nunca se llega, por el mínimo.
   - Sensación nativa: `user-select: none` en la barra, el dropzone, la barra de optimización y el footer (el texto del preview sigue seleccionable), `cursor: default` en los botones (los links sí conservan `pointer`) y nada de transiciones en propiedades de layout.
6. **Soltar archivos en cualquier parte de la ventana.** Un archivo que se suelta fuera del dropzone va al mismo `add` (el dropzone se resalta mientras se arrastra sobre la ventana) y nunca navega a `file://`. Aplica también en el navegador.
7. **Zoom:** se bloquea el pinch-zoom (`webContents.setVisualZoomLevelLimits(1, 1)`). El zoom de menú (Cmd +/-) sigue funcionando.

- [ ] **Paso 1 (TDD):**
  - Tests de `restoreBounds`: JSON ausente o corrupto, fuera de pantalla, más grande que el área de trabajo, por debajo de los mínimos, maximizado.
  - Tests de `windowOptions` para darwin, win32 y linux.
  - Test de `shell.ts`: con el query pone los atributos; sin el query no toca nada.
  - Test del drop global: llama a `add` y hace `preventDefault`.
- [ ] **Paso 2:** implementa `window-state.ts`, `windowOptions(platform)` y el cableado en `main.ts`.
- [ ] **Paso 3:** implementa el shell y el CSS del layout de escritorio, y mueve el Header a la barra superior sin cambiar su contenido ni sus textos.
- [ ] **Paso 4:** amplía `e2e/desktop.spec.ts` (sin romper el humo actual):
  - Fija 440×520 (`setSize`) y verifica que `getSize()` respete el mínimo, que no haya scroll horizontal (`scrollWidth <= clientWidth`), que el body no haga scroll y que el footer quede dentro del viewport.
  - Con 12 archivos agregados, la lista hace scroll interno y el footer sigue visible.
  - A 1280×900 la columna mide 720 px y está centrada.
  - Persistencia: lanza con un `userData` temporal, redimensiona, cierra, relanza y comprueba que el tamaño se restaura.
  - Guarda capturas a 440×520, 640×780 y 1280×900 en `test-results/desktop-*.png`.
- [ ] **Paso 5:** `npm run typecheck`, `npm test`, `npm run test:e2e` y `npm run test:desktop` en verde.
- [ ] **Paso 6: Commit** con `feat(desktop): native window sizing, remembered bounds and fluid app layout`.
