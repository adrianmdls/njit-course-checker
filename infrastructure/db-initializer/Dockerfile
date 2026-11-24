# syntax=docker/dockerfile:1
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
ADD --chmod=0644 --checksum=sha256:b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77 https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem ./rds-ca.pem
COPY database/init/01-schema.sql infrastructure/db-initializer/init-db.cjs ./
USER node
CMD ["node", "init-db.cjs"]
