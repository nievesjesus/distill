---
name: distill-office-documents
description: Use when you need to read a Word, Excel, PowerPoint or OpenDocument file (.docx, .doc, .xlsx, .xls, .pptx, .ppt, .odt, .ods, .odp). The Read tool cannot open these files; this converts them to token-lean Markdown locally.
---
<!-- distill-llm skill -->

# Read Office documents as Markdown

The Read tool cannot open Word, Excel, PowerPoint or OpenDocument files. Convert them with the Bash tool instead:

```bash
distill-llm convert --stdout --max-tokens 8000 "<path>"
```

- Read the Markdown the command prints.
- If the output starts with an index ("Index of ..."), the document is large: read only the sections you need by running the command again with `--offset <line> --limit <lines>` instead of `--max-tokens`, using the line numbers from the index.
- Convert one file per call.
- Exit code 1 means the conversion failed; the message on stderr says why (for example the file is password-protected, or it is a .doc, .xls, .ppt or OpenDocument file and LibreOffice is missing).
- For PDFs just use Read; the distill hook handles them.
