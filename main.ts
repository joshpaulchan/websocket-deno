import { connect } from "https://deno.land/x/redis/mod.ts";

function getHealth(_request: Request): Response {
    return new Response(null)
}

function getReadiness(_request: Request): Response {
    return new Response(null)
}

let METRICS = new Map<String, number>([])
function increment(map, key, amount = 1, _default = 0) {
    map.set(key, (map.get(key) ?? _default) + amount)
}

function getConnections(_request: Request): Response {
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

async function closeConnection(req: Request): Promise<Response> {
    websocketManager.unregister(await req.json().id)
    return new Response(null, {
        status: 204,
        headers: {
            "Content-Type": "application/json"
        }
    })
}

// needs to be workable to actual broker tech (redis)
// also needs to be able to subscribe other event streams (SSE) not just sockets
class Broker<T> {
    subscribed: Map<String, Array<T>>
    constructor() {
        this.subscribed = new Map<String, Array<T>>()
    }

    subscribe(topic: String, socket: T): void {
        if (this.subscribed.has(topic)) {
            this.subscribed.get(topic)?.push(socket)
        } else {
            this.subscribed.set(topic, [socket])
        }
    }

    unsubscribe(topic: String, socket: T): void {
        // probably a better way to optimize removal
        // TODO: fix this
        this.subscribed.set(topic, this.getSubscribers(topic).filter(s => s == socket))
    }

    getSubscribers(topic: String): Array<T> {
        return this.subscribed.get(topic) ?? []
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
function messageRouter(socket, socketID, routes, defaultHandler) {
    return function onMessage(e) {
        // gotta make sure content negotiation is in place from extensions / protocol
        const message = JSON.parse(e.data)
        return (routes[message.type] ?? defaultHandler)(e, socket, socketID)
    }
}

class WebsocketManager {
    sockets: Map<number, WebSocket>
    latestID: number
    heartBeatInterval: number
    constructor(heartbeatIntervalSeconds=60) {
        this.sockets = new Map()
        this.latestID = 1
        this.heartBeatInterval = setInterval(this.sendHeartBeats.bind(this), heartbeatIntervalSeconds*1000)
    }

    sendHeartBeats() {
        this.sockets.forEach((socket, key) => pong({}, socket))
    }

    drain() {
        this.sockets.forEach((socket, key) => this.unregister(key))
    }

    getById(id: number): WebSocket | undefined {
        return this.sockets.get(id)
    }

    register(socket: WebSocket) {
        increment(METRICS, "server.websockets.active", 1)
        const id = this.latestID + 1
        this.latestID += id

        this.sockets.set(id, socket)

        socket.onopen = () => console.log(new Date(), "socket opened");

        socket.onmessage = messageRouter(socket, id, {
            "ping": pong,
            "subscribe": subscribe,
            "unsubscribe": unsubscribe,
            "nack": nackMessage,
            "echo": echo,
            "bye": closeOnReceivingEnd,
        }, relay)

        const unregister = this.unregister.bind(this)
        socket.onerror = (e) => {
            console.log(new Date(), "socket errored:", e)
            unregister(id)
        };
        socket.onclose = () => unregister(id);
    }

    unregister(id: number): void {
        increment(METRICS, "server.websockets.active", -1)
        // maybe check state in: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
        this.sockets.get(id)?.close()
        this.sockets.delete(id)
    }
}

// NOTE: this could probably be a middleware that upgrades + register sockets based on header.
function establishWebsocket(_request: Request): Response {
    const upgrade = _request.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() != "websocket") {
        return new Response("request isn't trying to upgrade to websocket.");
    }

    increment(METRICS, "server.tcp_conn.upgrades", 1)
    const { socket, response } = Deno.upgradeWebSocket(_request);
    websocketManager.register(socket)

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
    [key: string]: ((request: Request) => Response) | ((request: Request) => Promise<Response>);
  };

  
function httpRouter(routes: RouterConfig, defaultHandler) {
    return async function handler(request: Request): Promise<Response> {
        const requestPattern = `${request.method} ${new URL(request.url).pathname}`
        return await (routes[requestPattern] ?? defaultHandler)(request)
    }
}

export const handler = httpRouter({
    "GET /healthz": getHealth,
    "GET /readiness": getReadiness,
    "GET /connections": getConnections,
    "DELETE /connections": closeConnection,

    // websocket upgrade requests start as GETs
    "GET /websocket": establishWebsocket,
    "GET /sse": sse,
}, notFound)

const port = Number(Deno.env.get("PORT", 8000))
const httpServer = Deno.serve({
    hostname: "0.0.0.0",
    port,
    handler
})

let websocketManager = new WebsocketManager()
// NOTE: this dedicated server may not be necessary, but may be useful for:
// - splitting event loops(if you can have more than 1 in deno an)
// - instrumenting some of the lower level bits
const webSocketServer = Deno.listen({
    hostname: "0.0.0.0",
    port: port + 1,
    handle
})

const redis = await connect({ hostname: "127.0.0.1" });
let publisher = await connect({ hostname: "127.0.0.1" });
// manage subscriptions better
let sub = await redis.psubscribe("*");
(async function () {
  for await (const { channel, message } of sub.receive()) {
    websocketBroker.getSubscribers(channel).forEach(id => websocketManager.getById(id)?.send(message))
  }
})();

async function handle(conn: Deno.Conn) {
    const httpConn = Deno.serveHttp(conn);
    for await (const requestEvent of httpConn) {
        increment(METRICS, "server.request_event", 1)
        await requestEvent.respondWith(handler(requestEvent.request));
        increment(METRICS, "server.request_event", -1)
    }
}

for await (const conn of webSocketServer) {
    increment(METRICS, "server.tcp_conn.active", 1)
    handle(conn);
    increment(METRICS, "server.tcp_conn.active", -1)
}