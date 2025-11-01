# Use an official Node.js image
FROM node:18

# Create and set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first (for dependency caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the project files
COPY . .

# Expose a port (if your gemini-proxy server listens on 8080 or something else, change here)
EXPOSE 8080

# Define environment variable (optional)
ENV NODE_ENV=production

# Command to start the proxy
CMD ["node", "server.js"]
