FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/nievesjesus/distill"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress \
        tesseract-ocr-eng \
        fonts-dejavu-core fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    NODE_ENV=production \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    DISTILL_TESSDATA=/usr/share/tesseract-ocr/5/tessdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /home/node/.cache && chown node:node /home/node/.cache
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/cli.js","--host","0.0.0.0","--no-open"]
