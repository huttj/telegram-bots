FROM node:20-slim

# Install build dependencies for better-sqlite3 and tools for Litestream
RUN apt-get update && apt-get install -y python3 make g++ curl bash wget && rm -rf /var/lib/apt/lists/*

# Install Litestream
RUN wget https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz \
  && tar -xzf litestream-v0.3.13-linux-amd64.tar.gz \
  && mv litestream /usr/local/bin/ \
  && rm litestream-v0.3.13-linux-amd64.tar.gz

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Copy Litestream config
COPY litestream.yml /etc/litestream.yml

# Create directory for database
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Start both Litestream and the bot
CMD ["sh", "start.sh"]
