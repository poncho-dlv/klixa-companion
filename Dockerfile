FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY src ./src

ENV NODE_ENV=production

CMD ["npm", "start"]
