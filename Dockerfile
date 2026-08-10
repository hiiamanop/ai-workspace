FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY client ./client
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
