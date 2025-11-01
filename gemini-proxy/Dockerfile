FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY . .
EXPOSE 3000
USER node
CMD ["node", "server.js"]
