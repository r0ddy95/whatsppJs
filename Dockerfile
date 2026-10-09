
FROM node:22-bookworm-slim

# Installer Chromium et ses dépendances
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installer les dépendances Node.js
COPY package*.json ./
RUN npm install --omit=dev

# Copier le serveur
COPY . .

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 8080

CMD ["npm", "start"]
