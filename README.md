
## Quickstart

```
docker compose up -d
deno run --allow-net --allow-env main.ts
```

## Development

Tests
```
deno test -A
```

Redis

You can connect using netcat (`nc`) and send commands like `PUBLISH <channel> <message>` OR `PSUBSCRIBE *` See https://redis.io/commands/subscribe/ for more commands.