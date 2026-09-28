# Playwright's own image ships a matching Chromium + all its OS-level dependencies already
# installed, and Node 20+ (this one ships v24) - both are hard requirements for the MCP browser
# server, so this avoids the nvm-lookup workaround server/index.js needs on the dev machine.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Installed before the rest of the app copies over so this layer is cached across deploys that
# only change application code, not dependencies.
COPY package.json package-lock.json ./
RUN npm ci && npm install -g @anthropic-ai/claude-code

COPY --chown=pwuser:pwuser . .

ENV NODE_ENV=production
# Render sets $PORT itself at runtime; this is only the documented default for `docker run`
# elsewhere. server/index.js already reads process.env.PORT.
ENV PORT=4000
EXPOSE 4000

# The base image runs as root by default, but `claude --permission-mode bypassPermissions`
# refuses to start as root/sudo for safety - it has no way to tell an intentionally-isolated
# container apart from a real root shell. pwuser (uid 1000) is the base image's own built-in
# non-root user, made exactly for this; the app's own writable dirs (tests/generated,
# test-results, etc.) are created under /app at runtime, which pwuser now owns via the --chown
# above, and Chromium (pre-installed in this image, launched via the MCP server) needs no root
# access to run.
USER pwuser

CMD ["node", "server/index.js"]
