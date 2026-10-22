FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates libreoffice-impress python3 libseccomp2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY public ./public
# Exercise the production converter (including its network/resource sandbox) during the build.
COPY tests/fixtures/presentation.pptx /tmp/arslive-import-check/input.pptx
RUN python3 server/office-sandbox.py /tmp/arslive-import-check soffice -env:UserInstallation=file:///tmp/arslive-import-check/profile --headless --convert-to pdf:impress_pdf_Export --outdir /tmp/arslive-import-check /tmp/arslive-import-check/input.pptx && pdfinfo /tmp/arslive-import-check/input.pdf && rm -rf /tmp/arslive-import-check
RUN pnpm build
ENV NODE_ENV=production APP_MODE=public
CMD ["node","--import","tsx","server/index.ts"]
