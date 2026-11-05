FROM oven/bun:1.4.4
WORKDIR /app
COPY --chown=bun:bun policy.ts server.ts ./
USER bun
EXPOSE 8080
CMD ["bun", "run", "server.ts"]
