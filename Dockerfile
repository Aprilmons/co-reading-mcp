FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /data
ENV MCP_SSE_HOST=0.0.0.0
ENV READING_MCP_DATA_DIR=/data
CMD ["node", "src/server-sse.js"]
