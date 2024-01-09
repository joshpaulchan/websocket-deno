This repository contains a tiny, flexible service that can be used to implement public, real-time message. It's currently a thin layer built over Redis Pub Sub (and would be nice to support other MQ / event stream technologies like kafka) and supports Websockets (and a half baked SSE implementation)

## Quickstart

```
docker compose up --build
```

## Development

Tests
```
deno test -A
```

Redis

You can connect using netcat (`nc`) and send commands like `PUBLISH <channel> <message>` OR `PSUBSCRIBE *` See https://redis.io/commands/subscribe/ for more commands.


## Roadmap

Smattering of things that might be interesting and/or useful:
- support Kafka, RMQ, other shared state tech?
- support SSE
- upgrade routing to handle subscriptions