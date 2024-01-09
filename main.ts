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

function pong(e, socket) {
    socket.send(JSON.stringify({
        type: "pong",
        attributes: {
            ts: new Date()
        }
    }))
}

function subscribe(e, socket, socketID) {
    const message = JSON.parse(e.data)
    websocketBroker.subscribe(message.attributes.topic, socketID)

    socket.send(JSON.stringify({
        type: "ack",
        attributes: {
            ts: new Date()
        }
    }))
}

// TODO: nope still have to fix this
function unsubscribe(e, socket, socketID) {
    const message = JSON.parse(e.data)
    websocketBroker.unsubscribe(message.attributes.topic, socketID)

    socket.send(JSON.stringify({
        type: "ack",
        attributes: {
            ts: new Date()
        }
    }))
}

function relay(e) {
    const message = JSON.parse(e.data)
    const topic = message?.attributes?.topic

    console.log("broadcasting to topic:", topic)
    
    // websocketBroker.getSubscribers(topic).forEach(id => websocketManager.getById(id)?.send(e.data))
    publisher.publish(topic, e.data)
}

function echo(e, socket) {
    socket.send(e.data)
}

function closeOnReceivingEnd(e, socket) {
    socket.close()
}

function nackMessage(e, socket) {
    socket.send(JSON.stringify({
        type: "nack",
        attributes: {
            ts: new Date()
        }
    }))
}

// maybe I should be passing socket ID around instead and interfacing thru manager? 🤷
function messageRouter(socket: WebSocket, socketID: number, routes: Object, defaultHandler) {
    return function onMessage(e) {
        // gotta make sure content negotiation is in place from extensions / protocol
        const message = JSON.parse(e.data)
        return (routes[message.type] ?? defaultHandler)(e, socket, socketID)
    }
}

// TODO: generalize to any potential listening stream (SSE or Websocket)
class WebsocketManager {
    #sockets: Map<number, WebSocket>
    #latestID: number
    constructor() {
        this.#sockets = new Map()
        this.#latestID = 1
    }

    getById(id: number): WebSocket | undefined {
        return this.#sockets.get(id)
    }

    register(socket: WebSocket): number {
        increment(METRICS, "server.websocket.active", 1)
        const id = this.#latestID + 1
        this.#latestID += id

        this.#sockets.set(id, socket)

        socket.onopen = () => console.log(new Date(), "socket opened");

        socket.onmessage = messageRouter(socket, id, {
            "ping": pong,
            "subscribe": subscribe,
            "unsubscribe": unsubscribe,
            "nack": nackMessage,
            "echo": echo,
            "bye": closeOnReceivingEnd,
        }, relay)

        // TODO: unsubscribe all
        const unregister = this.unregister.bind(this)
        socket.onerror = (e) => unregister(id, e)
        socket.onclose = () => unregister(id)
        return id;
    }

    unregister(id: number, e: Error | undefined): void {
        if (e != null) {
            console.log(new Date(), "socket errored:", e)
        } else {
            console.log(new Date(), "socket closed")
        }
        
        increment(METRICS, "server.websocket.active", -1)
        // maybe check state in: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
        this.#sockets.get(id)?.close()
        this.#sockets.delete(id)
    }
}

const subscribeSocketToPath = new Boolean(Deno.env.get("CLIENT_AUTO_SUBSCRIBE_ON_PATH")) ?? true

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
    let timerId: number | undefined;
    const msg = new TextEncoder().encode(_request.url);
    const body = new ReadableStream({
        start(controller) {
            increment(METRICS, "server.server_sent_events.active", 1)
            timerId = setInterval(() => {
                controller.enqueue(msg);
            }, 1000);
        },
        cancel() {
            increment(METRICS, "server.server_sent_events.active", -1)
            if (typeof timerId === "number") {
                clearInterval(timerId);
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

let websocketManager = new WebsocketManager()

const redisHostname = Deno.env.get("REDIS_HOSTNAME") ?? "127.0.0.1"
const redisPort = Deno.env.get("REDIS_PORT") ?? "6379"
const channelPattern = Deno.env.get("REDIS_CHANNEL_PATTERN") ?? "*"
const redis = await connect({ hostname: redisHostname, port: redisPort });
let publisher = await connect({ hostname: redisHostname, port: redisPort });
// manage subscriptions better?
let sub = await redis.psubscribe(channelPattern);

// make em & run

(
    async function () {
        console.log(new Date(), `subscribing to channels matching ${channelPattern} in ${redisHostname}:${redisPort}`)
        for await (const { channel, message } of sub.receive()) {
            websocketBroker.getSubscribers(channel).forEach(id => websocketManager.getById(id)?.send(message))
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