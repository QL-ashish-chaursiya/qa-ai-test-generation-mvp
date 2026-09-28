# Playwright's own image ships a matching Chromium + all its OS-level dependencies already
# installed, and Node 20+ (this one ships v24) - both are hard requirements for the MCP browser
# server, so this avoids the nvm-lookup workaround server/index.js needs on the dev machine.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Installed before the rest of the app copies over so this layer is cached across deploys that
# only change application code, not dependencies.
COPY package.json package-lock.json ./
RUN npm ci && npm install -g @anthropic-ai/claude-code

COPY . .

ENV NODE_ENV=production
# Render sets $PORT itself at runtime; this is only the documented default for `docker run`
# elsewhere. server/index.js already reads process.env.PORT.
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/index.js"]
