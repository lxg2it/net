FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY public/ ./public/
COPY sql/ ./sql/

RUN mkdir -p /app/data

EXPOSE 3006

CMD ["node", "dist/server/index.js"]
