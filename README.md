This repository contains a tiny, flexible service that can be used to implement public, real-time message. It's currently a thin layer built over Redis Pub Sub (and would be nice to support other MQ / event stream technologies like kafka) and supports Websockets (and a half baked SSE implementation)

This service can be used to implement and experiment with several real-time technologies both client facing and server to server. However, it aims to be use-case (and protocol) agnostic, so if application-specific logic is necessary (i.e. message augmentation, transformation or filtering using data from an application-specific database or other source), you should either fork it or build a transformation pipeline using your MQ tech. ex.:

1. A - sub to /rooms/12 (OOB with this)
2. B - pub to /messages (OOB with this)
3. X - listen to /messages, record, distribute, etc. and write to /rooms/12 (app-specific)


hmm, having written that a tricky thing is compression / estimation - in a related data model, how should a client express what entities and changes (if diffs) they want to receive, how should that be performantly encoded for retrieval and manipulation, and how that should be expressed in the MQ tech?

## Quickstart

```
docker compose up --build
```

You can then use the websocket protocol to connect to a particular path to subscribe to that path, or do others. You can also listen to an event stream over SSE (currently only on the `/sse` path).


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
- upgrade routing to handle subscriptions, maybe better operations + mapping from HTTP paths and message types to MQ tech
- (probably) better security - authz, pass through