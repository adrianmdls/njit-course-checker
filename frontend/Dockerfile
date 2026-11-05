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

# Copy production build
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose HTTP port
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]