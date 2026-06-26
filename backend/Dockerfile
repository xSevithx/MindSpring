FROM node:22-slim
WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# Run migrations then start the server.
CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
