# Stage 1: Build React frontend
FROM node:24-alpine AS build

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build Vite application
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:stable-alpine AS production

ENV API_UPSTREAM=backend:3000 \
    API_RESOLVER=127.0.0.11 \
    API_SCHEME=http \
    API_HOST='$host' \
    ALB_REAL_IP_DIRECTIVES='' \
    NGINX_ENVSUBST_FILTER='^(API_UPSTREAM|API_RESOLVER|API_SCHEME|API_HOST|ALB_REAL_IP_DIRECTIVES)$'

# Copy production build
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Expose HTTP port
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
