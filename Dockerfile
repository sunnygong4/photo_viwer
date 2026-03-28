FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY server.ts tsconfig.json ./
COPY public ./public
RUN mkdir -p /app/.thumbcache
EXPOSE 3333
CMD ["npx", "tsx", "server.ts"]
