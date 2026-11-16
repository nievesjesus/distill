---
name: distill-office-documents
description: Use when you need to read a Word, Excel, PowerPoint or OpenDocument file (.docx, .doc, .xlsx, .xls, .pptx, .ppt, .odt, .ods, .odp). The Read tool cannot open these files; this converts them to token-lean Markdown locally.
---
<!-- distill-llm skill -->

# Read Office documents as Markdown

The Read tool cannot open Word, Excel, PowerPoint or OpenDocument files. Convert them with the Bash tool instead:

```bash
distill-llm convert --stdout "<path>"
```

- Read the Markdown the command prints.
- Convert one file per call.
- Exit code 1 means the conversion failed; the message on stderr says why (for example the file is password-protected, or it is a .doc, .xls, .ppt or OpenDocument file and LibreOffice is missing).
- For PDFs just use Read; the distill hook handles them.
