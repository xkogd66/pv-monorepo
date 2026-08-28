FROM node:22-bookworm-slim AS production

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src/ ./src/

USER node

EXPOSE 3000

CMD ["npm", "start"]
