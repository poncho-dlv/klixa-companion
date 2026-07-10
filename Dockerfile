FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY src ./src

ENV NODE_ENV=production

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8786) + '/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "src/index.js"]
