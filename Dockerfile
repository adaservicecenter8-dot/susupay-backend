FROM node:20-bookworm-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
RUN npx prisma generate
COPY . .
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node src/app.js"]
