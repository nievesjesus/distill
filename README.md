# distill

Documents in. Fewer tokens out.

Distill turns PDFs, Office files and images into token-lean Markdown for LLMs. It parses with [LiteParse](https://github.com/run-llama/liteparse) and then runs a chain of small, deterministic "boosters" that drop formatting, repeats and link targets, not content. Everything runs on your machine.

<!-- GIF: drop a file, see the saving (about 10 seconds) -->

## Quick start

```bash
npx distillmd
```

This starts a local server at `http://127.0.0.1:4321` and opens the web UI. Drop files in, read the Markdown, copy it or download it (a single `.md` or a ZIP of all of them).

Options:

```bash
npx distillmd --port 4321 --host 127.0.0.1 --no-open --max-size 100
```

The server only listens on loopback by default. Passing `--host 0.0.0.0` exposes it to your network and disables the loopback check, so only do that on a network you trust. On every host, state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) to `/api` are rejected with 403 when the browser marks them `Sec-Fetch-Site: cross-site` or when their `Origin` differs from the `Host`, so another website cannot drive your instance through your browser. This does not stop DNS rebinding on an exposed host, so keep `--host 0.0.0.0` (and the Docker port) on trusted networks. Clients that send no `Origin` (curl, MCP clients) are unaffected. If you put distill behind a reverse proxy, keep the original `Host` header.

`npx distillmd` installs only the parser, the local boosters and the server. LLMLingua-2 is not part of that install: you turn it on from the app when you want it (see below).

## Docker

```bash
docker run --rm -p 4321:4321 ghcr.io/nievesjesus/distill
```

(once published; until then, build the image yourself as shown below)

The image is based on `node:22-bookworm-slim` and bundles LibreOffice (Writer, Calc, Impress) and the Tesseract English language data, with `TESSDATA_PREFIX` and `DISTILL_TESSDATA` pointing at it, so every supported format works out of the box without any download. Inside the container the server listens on `0.0.0.0`, so the loopback check is off, but the cross-site check described above still applies.

To build it yourself:

```bash
docker build -t distill .
docker run --rm -p 4321:4321 distill
```

The image does not include LLMLingua-2. If you enable it from the app, the runtime is installed into `~/.cache/distillmd/lingua` inside the container, and the model goes to `~/.cache/distillmd/models`. Mount a volume on `/home/node/.cache` to keep both across runs:

```bash
docker run --rm -p 4321:4321 -v distill-cache:/home/node/.cache ghcr.io/nievesjesus/distill
```

## Supported formats

| Format | Needs |
|--------|-------|
| PDF | nothing else |
| Images (PNG, JPG, TIFF, WebP) | nothing else, OCR is built in (see Privacy for the one-time English data download) |
| DOCX, PPTX, XLSX, ODF | [LibreOffice](https://www.libreoffice.org/download/) on your `PATH` (`soffice`) |

If LibreOffice is missing, Distill still accepts an Office file and shows an explicit "Office files need LibreOffice" error instead of failing silently. The Docker image already includes it. Password-protected PDFs are reported as an error; asking for the password is not supported yet.

Parsing quality is whatever LiteParse gives you. It varies on dense tables and on complex scans, and Distill does not try to fix that.

## Boosters

Boosters run in a fixed order and each one is a pure, idempotent function over the Markdown. None of them touches fenced code blocks or front-matter. "Optimize for LLMs" is the master switch; the individual boosters are in the Detailed view.

| Booster | What it does | Loss |
|---------|--------------|------|
| Drop repeated boilerplate | Removes repeated running headers and footers: non-structural lines (not headings, table rows or list items) with at least 4 words and 25 characters that appear 3 or more times, and page indicators that fill the whole line or a leading or trailing segment set off by ` — `, ` | ` or ` · ` (lines are compared as written, so lines that differ in a link target or a page cross-reference are kept), such as `Page 3 of 12`, `p. 3/12`, `3 of 12 pages` or `- 3 -`, keeping the first. Short repeated lines (`Yes`, `N/A`, `Score: 3/4`) are never removed | No information lost |
| Slim images and links | `![alt](path)` becomes `[alt]` and `[text](url)` becomes `text` | **Drops image paths and URLs** |
| Compact tables | Removes alignment padding from GFM tables | None |
| Collapse whitespace | Collapses blank-line runs, trailing spaces and double spaces outside code | None |
| LLMLingua-2 | A local model removes low-value words | **Lossy**, off by default |

The first four are on by default. They drop only formatting, repeats and link targets, not content words. If you need link targets, turn off "Slim images and links".

LLMLingua-2 is optional and experimental. It is marked as lossy in the UI, it is not installed by default. When `npm` is available (`npx`, the CLI and the Docker image), the LLMLingua-2 row shows **Install (~520 MB)**. That one click runs `npm ci --omit=dev --include=peer --ignore-scripts` against a lockfile with pinned versions and integrity hashes, installs the runtime (`@atjsh/llmlingua-2`, `@huggingface/transformers` and `js-tiktoken`, mostly onnxruntime) into `~/.cache/distillmd/lingua`, and then, the first time you use it, downloads the model (TinyBERT by default, about 57 MB) from Hugging Face into `~/.cache/distillmd/models`. After that it runs offline. The runtime takes about 520 MB on disk. The install skips onnxruntime's postinstall script, which on Linux x64 would fetch CUDA binaries from NuGet and is not needed for CPU inference; the CPU runtime ships inside the npm package. If the install fails, the row shows the reason and a Retry button. The desktop lite app has no npm, so there the row says "Available in distill full" and links to the release; anywhere else, if npm cannot be found, the row says so and suggests installing Node.js.

## How tokens are counted

Counts use the `o200k_base` encoding (via `gpt-tokenizer`), computed in your browser. Other models, such as Claude or Gemini, tokenize differently, so absolute counts are approximate. The percentage saved is comparable across tokenizers.

## Privacy

Files are parsed locally and never leave your machine. There is no telemetry, no analytics and no CDN: fonts are bundled. Distill can make up to three one-time downloads. First, the first OCR of an image or scan downloads about 15 MB of Tesseract English data (`eng.traineddata`) from GitHub, unless tessdata is already present. To avoid it, point `DISTILL_TESSDATA` or `TESSDATA_PREFIX` at a local tessdata directory (`DISTILL_OCR_LANG` sets the OCR language, default `eng`), or use the Docker image, which ships the data. Second, the LLMLingua-2 runtime, installed from the npm registry only when you click Install. Third, the LLMLingua model (about 57 MB) from Hugging Face, the first time you use it after installing the runtime. Uploaded files are written to a temporary directory and deleted after parsing; the original bytes and the result stay in memory (a small LRU) only so the JSON view can be requested later. Removing a row or choosing Clear drops its copy from memory too (a file removed at the exact moment its parse finishes can stay in the local server's memory until LRU eviction, 50 files or 200 MB, or a restart). Nothing is written to disk except: the files you save yourself; the LLMLingua-2 runtime in `~/.cache/distillmd/lingua` and its model cache in `~/.cache/distillmd/models`, if you enable it; the desktop app's window size and position and last save folder (`window-state.json` and `desktop-prefs.json` in its user data folder); and the browser's or Electron profile's own data (your settings live there). The list of documents is not remembered between launches. API responses are sent with `Cache-Control: no-store`, so they are not cached by the browser.

## Desktop app

Distill also ships as a desktop app for macOS (arm64 and x64, `.dmg`), Windows (x64, `.exe` installer) and Linux (x64, `.AppImage`). Downloads are on the [GitHub Releases](https://github.com/nievesjesus/distill/releases) page once published. It runs the same local server and UI as `npx distillmd` in its own window. Saving uses the native save dialog, which opens in the last folder you used, and a short "Show in Finder" link appears afterwards.

| Variant | What it includes | Size |
|---------|------------------|------|
| `Distill-lite-*` | Everything except the LLMLingua-2 runtime. The row shows "Available in distill full". | Smaller |
| `Distill-full-*` | Bundles the LLMLingua-2 runtime (onnxruntime and the model tooling); only the model is downloaded when you turn it on. | Much larger |

The installers are not signed yet, so the operating system warns the first time:

- **macOS 15 and later:** open the app once and dismiss the warning, then go to System Settings > Privacy & Security and click **Open Anyway**.
- **macOS 14 and earlier:** right-click the app and choose **Open**, then confirm **Open** in the dialog.
- **"The app is damaged":** run `xattr -dr com.apple.quarantine /Applications/distill.app` and open it again.
- **Windows:** in the SmartScreen dialog click **More info**, then **Run anyway**.

Office files (DOCX, PPTX, XLSX) still need LibreOffice installed on your machine. OCR data (`eng.traineddata`) is bundled, so the desktop app never downloads it. The desktop app has no auto-update.

## Roadmap

- MCP server so any agent can convert documents
- CLI for converting files from the terminal
- Hooks so Claude Code and OpenCode read the distilled Markdown instead of the binary

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

To build the full desktop variant locally, build one architecture per host: `npm run dist:full -- --arm64` on an Apple Silicon machine or `npm run dist:full -- --x64` on an Intel one. `build/lingua` holds only the sharp binary of the machine that ran `npm ci`, so a cross-architecture installer would ship the wrong native module.

Re-running the release workflow for a tag whose draft release already exists does not replace the installers attached to that draft. Delete the draft first, then re-run.

## License

Apache-2.0. See [LICENSE](LICENSE).

Built on [LiteParse](https://github.com/run-llama/liteparse) by LlamaIndex.
