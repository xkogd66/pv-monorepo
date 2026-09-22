FROM node:22-bookworm-slim AS production

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src/ ./src/

# rclone (OneDrive import) — static binary + CA bundle from the official image
COPY --from=rclone/rclone:1.71.1 /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=rclone/rclone:1.71.1 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

USER node

EXPOSE 3000

CMD ["npm", "start"]
