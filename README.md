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

The server only listens on loopback by default. Passing `--host 0.0.0.0` exposes it to your network and disables the loopback check, so only do that on a network you trust.

`npx distillmd` currently installs the LLMLingua runtime (several hundred MB, mostly onnxruntime) as part of the package. A slimmer install is planned.

## Docker

```bash
docker run --rm -p 4321:4321 ghcr.io/nievesjesus/distill
```

(once published; until then, build the image yourself as shown below)

The image is based on `node:22-bookworm-slim` and bundles LibreOffice (Writer, Calc, Impress) and the Tesseract English language data, with `TESSDATA_PREFIX` and `DISTILL_TESSDATA` pointing at it, so every supported format works out of the box without any download. Inside the container the server listens on `0.0.0.0`.

To build it yourself:

```bash
docker build -t distill .
docker run --rm -p 4321:4321 distill
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
| Drop repeated boilerplate | Removes short non-structural lines (not headings, table rows or list items) that appear 3 or more times, keeping the first | No information lost |
| Slim images and links | `![alt](path)` becomes `[alt]` and `[text](url)` becomes `text` | **Drops image paths and URLs** |
| Compact tables | Removes alignment padding from GFM tables | None |
| Collapse whitespace | Collapses blank-line runs, trailing spaces and double spaces outside code | None |
| LLMLingua-2 | A local model removes low-value words | **Lossy**, off by default |

The first four are on by default. They drop only formatting, repeats and link targets, not content words. If you need link targets, turn off "Slim images and links".

LLMLingua-2 is optional and experimental. It is marked as lossy in the UI, the model (TinyBERT by default, about 57 MB) is downloaded the first time you enable it into `~/.cache/distillmd/models`, and after that it runs offline. If its runtime is not installed, the switch is disabled and says "not installed".

## How tokens are counted

Counts use the `o200k_base` encoding (via `gpt-tokenizer`), computed in your browser. Other models, such as Claude or Gemini, tokenize differently, so absolute counts are approximate. The percentage saved is comparable across tokenizers.

## Privacy

Files are parsed locally and never leave your machine. There is no telemetry, no analytics and no CDN: fonts are bundled. Distill can make two one-time downloads. First, the first OCR of an image or scan downloads about 15 MB of Tesseract English data (`eng.traineddata`) from GitHub, unless tessdata is already present. To avoid it, point `DISTILL_TESSDATA` or `TESSDATA_PREFIX` at a local tessdata directory (`DISTILL_OCR_LANG` sets the OCR language, default `eng`), or use the Docker image, which ships the data. Second, the LLMLingua model download, only when you turn it on. Uploaded files are written to a temporary directory and deleted after parsing; the original bytes and the result stay in memory (a small LRU) only so the JSON view can be requested later.

## Desktop app

Distill also ships as a desktop app for macOS (arm64 and x64, `.dmg`), Windows (x64, `.exe` installer) and Linux (x64, `.AppImage`). Downloads are on the [GitHub Releases](https://github.com/nievesjesus/distill/releases) page once published. It runs the same local server and UI as `npx distillmd` in its own window.

| Variant | What it includes | Size |
|---------|------------------|------|
| `Distill-lite-*` | Everything except the LLMLingua-2 runtime. The switch shows "not installed". | Smaller |
| `Distill-full-*` | Adds the LLMLingua-2 runtime (onnxruntime and the model tooling). | Much larger |

The installers are not signed yet, so the operating system warns the first time:

- **macOS:** right-click the app and choose **Open**, then confirm **Open** in the dialog.
- **Windows:** in the SmartScreen dialog click **More info**, then **Run anyway**.

Office files (DOCX, PPTX, XLSX) still need LibreOffice installed on your machine. OCR data (`eng.traineddata`) is bundled, so the desktop app never downloads it. The desktop app has no auto-update.

## Roadmap

- MCP server so any agent can convert documents
- CLI for converting files from the terminal
- Hooks so Claude Code and OpenCode read the distilled Markdown instead of the binary
- A slimmer npm install without the LLMLingua runtime

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

## License

Apache-2.0. See [LICENSE](LICENSE).

Built on [LiteParse](https://github.com/run-llama/liteparse) by LlamaIndex.
