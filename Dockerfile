FROM node:18-alpine
RUN apk add --no-cache python3 py3-pip
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data
ENV MCP_SSE_HOST=0.0.0.0
ENV READING_MCP_DATA_DIR=/data
CMD ["node", "src/server-sse.js"]
