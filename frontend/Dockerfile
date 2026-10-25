FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_* values are inlined at build time. Leave the Google key empty
# to use the keyless OpenStreetMap provider.
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/out /usr/share/nginx/html
# Serve /demo from demo.html.
RUN printf 'server {\n  listen 3000;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri.html $uri/ =404; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 3000
