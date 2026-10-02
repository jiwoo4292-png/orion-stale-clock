FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY data ./data
COPY LICENSE LICENSE-DATA.md NOTICE-SOURCES.md METHODOLOGY.md README.md CONTRIBUTING.md ./
COPY assets ./assets
RUN node --check bin/orion-stale-clock.js && node --check src/stale-clock.js
USER node
ENTRYPOINT ["node", "/app/bin/orion-stale-clock.js"]
CMD ["--help"]
