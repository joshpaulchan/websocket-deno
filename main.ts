import { connect } from "https://deno.land/x/redis/mod.ts";

function getHealth(_request: Request): Response {
    return new Response(null)
}

function getReadiness(_request: Request): Response {
    return new Response(null)
}

let METRICS = new Map<String, number>([])
function increment(map: Map<any, number>, key: any, amount = 1, _default = 0) {
    map.set(key, (map.get(key) ?? _default) + amount)
}

function getMetrics(_request: Request): Response {
    const body = JSON.stringify({
        ts: new Date(),
        attributes: Object.fromEntries(METRICS.entries())
    })
    return new Response(body, {
        headers: {
            "Content-Type": "application/json"
        }
    })
}

// needs to be workable to actual broker tech (redis)
// also needs to be able to subscribe other event streams (SSE) not just sockets
class Broker<T> {
    #subscribed: Map<String, Array<T>>
    constructor() {
        this.#subscribed = new Map<String, Array<T>>()
    }

    subscribe(topic: String, socket: T): void {
        if (this.#subscribed.has(topic)) {
            this.#subscribed.get(topic)?.push(socket)
        } else {
            this.#subscribed.set(topic, [socket])
        }
        console.log(new Date(), `added subscriber for ${topic}`)
    }

    unsubscribe(topic: String, socket: T): void {
        // probably a better way to optimize removal
        // TODO: fix this
        this.#subscribed.set(topic, this.getSubscribers(topic).filter(s => s == socket))
        console.log(new Date(), `removed subscriber for ${topic}`)
    }

    getSubscribers(topic: String): Array<T> {
        return this.#subscribed.get(topic) ?? []
    }
}

// TODO: connect to a bunch of remote event sources and on event, lookup relevant subscribers and emit to em
let websocketBroker = new Broker<number>()
let sseBroker = new Broker<number>()

function pong(e: MessageEvent, socket: WebSocket) {
    socket.send(JSON.stringify({
        type: "pong",
        attributes: {
            ts: new Date()
        }
    }))
}

function subscribe(e: MessageEvent, socket: WebSocket, socketID: number) {
    const message = JSON.parse(e.data)
    websocketBroker.subscribe(message.destination, socketID)

    socket.send(JSON.stringify({
        type: "ack",
        attributes: {
            ts: new Date()
        }
    }))
}

// TODO: nope still have to fix this
function unsubscribe(e: MessageEvent, socket: WebSocket, socketID: number) {
    const message = JSON.parse(e.data)
    websocketBroker.unsubscribe(message.destination, socketID)

    socket.send(JSON.stringify({
        type: "ack",
        attributes: {
            ts: new Date()
        }
    }))
}

function relay(e: MessageEvent) {
    const message = JSON.parse(e.data)
    const destination = message?.destination

    console.log("broadcasting to destination:", destination)
    
    // websocketBroker.getSubscribers(topic).forEach(id => websocketManager.getById(id)?.send(e.data))
    publisher.publish(destination, e.data)
}

function echo(e: MessageEvent, socket: WebSocket) {
    socket.send(e.data)
}

function closeOnReceivingEnd(e: MessageEvent, socket: WebSocket) {
    socket.close()
}

function nackMessage(e: MessageEvent, socket: WebSocket) {
    socket.send(JSON.stringify({
        type: "nack",
        attributes: {
            ts: new Date()
        }
    }))
}

interface MessageReceiver<T> {
    (e: MessageEvent): void
    (e: MessageEvent, receiver: T): void
    (e: MessageEvent, receiver: T, id: number): void
}

// maybe I should be passing socket ID around instead and interfacing thru manager? 🤷
function messageRouter(socket: WebSocket, socketID: number, routes: Object, defaultHandler: MessageReceiver<WebSocket>) {
    return function onMessage(e: MessageEvent) {
        // gotta make sure content negotiation is in place from extensions / protocol
        const message = JSON.parse(e.data)
        return (routes[message.type] ?? defaultHandler)(e, socket, socketID)
    }
}


abstract class BaseManager<T> {
    #managedItems: Map<number, T>
    #latestID: number
    #metricName: string
    constructor(metricName: string) {
        this.#managedItems = new Map()
        this.#latestID = 1
        this.#metricName = metricName
    }

    getById(id: number): T | undefined {
        return this.#managedItems.get(id)
    }

    register(item: T): number {
        increment(METRICS, `server.${this.#metricName}.active`, 1)
        const id = this.#latestID + 1
        this.#latestID += id

        this.#managedItems.set(id, item)
        this.bootstrap(id, item)

        return id;
    }

    bootstrap(id: number, item: T): void {}

    unregister(id: number, e: Error | undefined): void {
        if (e != null) {
            console.log(new Date(), `${this.#metricName} errored:`, e)
        } else {
            console.log(new Date(), `${this.#metricName} closed`)
        }
        
        increment(METRICS, `server.${this.#metricName}.active`, -1)
        const item = this.#managedItems.get(id)
        if (item) {
            this.teardown(id, item)
        }
        this.#managedItems.delete(id)
    }

    teardown(id: number, item: T): void {}
}

// TODO: generalize to any potential listening stream (SSE or Websocket)
class WebsocketManager extends BaseManager<WebSocket> implements Manager<number, WebSocket> {
    #metricName: string
    constructor(metricName: string) {
        super(metricName)
        this.#metricName = metricName
    }

    bootstrap(id: number, item: WebSocket): void {
        item.onopen = () => console.log(new Date(), `${this.#metricName} opened`)

        item.onmessage = messageRouter(item, id, {
            "ping": pong,
            "subscribe": subscribe,
            "unsubscribe": unsubscribe,
            "nack": nackMessage,
            "echo": echo,
            "bye": closeOnReceivingEnd,
        }, relay)

        const unregister = this.unregister.bind(this)
        item.onerror = (e) => unregister(id, e)
        item.onclose = () => unregister(id)
    }

    teardown(id: number, socket: WebSocket): void {
        // maybe check state in: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
        socket.close()
        // TODO: unsubscribe socket from all subs
    }
}

// TODO: generalize to any potential listening stream (SSE or Websocket)
class ServerSentEventsManager extends BaseManager<ReadableStreamDefaultController> implements Manager<number, ReadableStreamDefaultController> {
    constructor(metricName: string) {
        super(metricName)
    }
    teardown(id: number, item: ReadableByteStreamController): void {
        item.close()
        // TODO: unsubscribe socket from all subs
    }
}

interface Manager<K, T> {
    getById(id: K): T | undefined

    register(item: T): number

    bootstrap(id: K, item: T): void

    unregister(id: K, e: Error | undefined): void

    teardown(id: K, item: T): void
}

const subscribeSocketToPath = new Boolean(Deno.env.get("CLIENT_AUTO_SUBSCRIBE_ON_PATH") ?? true)

// handles upgrades to websocket protocol
function websocketMiddleware(next) {
    return async function handler(request: Request): Promise<Response> {
        const handshakeResponse = establishWebsocket(request)
        if (handshakeResponse != null) {
            return handshakeResponse
        }
        return await next(request)
    }
}
function establishWebsocket(_request: Request): Response | null {
    if (_request.method != "GET") {
        // websocket upgrade requests start as GETs; maybe this is handled by Deno already?
        return null;
    }
    const upgrade = _request.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() != "websocket") {
        return null;
    }

    increment(METRICS, "server.tcp_conn.upgrades", 1)
    const { socket, response } = Deno.upgradeWebSocket(_request);
    const socketId = websocketManager.register(socket)
    if (subscribeSocketToPath) {
        websocketBroker.subscribe(new URL(_request.url).pathname, socketId)
    }

    return response;
}

function sse(_request: Request): Response {
    let id: number | undefined;
    const body = new ReadableStream({
        start(controller) {
            id = sseManager.register(controller)
            sseBroker.subscribe(new URL(_request.url).pathname, id)
        },
        cancel() {
            if (id) {
                sseBroker.unsubscribe(new URL(_request.url).pathname, id)
                sseManager.unregister(id, undefined)
            }
        },
    });

    return new Response(body, {
        headers: {
            "Content-Type": "text/event-stream",
        },
    });
}

function notFound(_request: Request): Response {
    return new Response(null, {
        status: 404
    })
}

type RouterConfig = {
    [key: string]: (request: Request) => Response | Promise<Response>;
};

  
function httpRouter(routes: RouterConfig, defaultHandler) {
    return async function handler(request: Request): Promise<Response> {
        const requestPattern = `${request.method} ${new URL(request.url).pathname}`
        return await (routes[requestPattern] ?? defaultHandler)(request)
    }
}

export const handler = websocketMiddleware(httpRouter({
    "GET /healthz": getHealth,
    "GET /readiness": getReadiness,
    "GET /metrics": getMetrics,
    "GET /sse": sse,
}, notFound))

let websocketManager : Manager<number, WebSocket> = new WebsocketManager("websocket")
let sseManager : Manager<number, ReadableStreamDefaultController> = new ServerSentEventsManager("server_sent_event_connections")

const redisHostname = Deno.env.get("REDIS_HOSTNAME") ?? "127.0.0.1"
const redisPort = Deno.env.get("REDIS_PORT") ?? "6379"
const redisDb = Deno.env.get("REDIS_DB") ?? "0"
const channelPattern = Deno.env.get("REDIS_CHANNEL_PATTERN") ?? "*"
const redis = await connect({ hostname: redisHostname, port: redisPort, db: redisDb });
let publisher = await connect({ hostname: redisHostname, port: redisPort, db: redisDb });
// manage subscriptions better?
let sub = await redis.psubscribe(channelPattern);

// make em & run
(
    async function () {
        const encoder = new TextEncoder()
        console.log(new Date(), `subscribing to channels matching ${channelPattern} in ${redisHostname}:${redisPort}`)
        for await (const { channel, message } of sub.receive()) {
            websocketBroker.getSubscribers(channel).forEach(id => websocketManager.getById(id)?.send(message))
            sseBroker.getSubscribers(channel).forEach(id => sseManager.getById(id)?.enqueue(encoder.encode(message)))
        }
    }
)();

(
    async function () {
        const port = parseInt(Deno.env.get("PORT") ?? 8080)
        const httpServer = Deno.serve({
            hostname: "0.0.0.0",
            port,
            handler
        })
    }
)();