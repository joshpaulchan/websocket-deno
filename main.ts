
function getHealth(_request: Request): Response {
    return new Response(null)
}

function getReadiness(_request: Request): Response {
    return new Response(null)
}

let METRICS: Map = new Map([])
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

async function closeConnection(req: Request): Response {
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

let websocketBroker = new Broker<WebSocket>()

function subscribe(e, socket) {
    const message = JSON.parse(e.data)
    websocketBroker.subscribe(message.attributes.topic, socket)

    socket.send(JSON.stringify({
        type: "ack",
        attributes: {
            ts: new Date()
        }
    }))
}

function unsubscribe(e, socket) {
    const message = JSON.parse(e.data)
    websocketBroker.unsubscribe(message.attributes.topic, socket)

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
    
    websocketBroker.getSubscribers(topic).forEach((socket) => socket.send(e.data))
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
function messageRouter(socket, routes, defaultHandler) {
    return function onMessage(e) {
        // gotta make sure content negotiation is in place from extensions / protocol
        const message = JSON.parse(e.data)
        return (routes[message.type] ?? defaultHandler)(e, socket)
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
        const sendHeartBeat = this.sendPong.bind(this)
        this.sockets.forEach((socket, key) => sendHeartBeat(key, false))
    }

    // I shouldn't actually need to sending pongs, those frames should be implemented
    // as part of the websocket protocol
    sendPong(id, prompted) {
        const socket = this.sockets.get(id)
        if (!socket) {
            return
        }

        socket.send(JSON.stringify({
            id: null,
            type: "PONG",
            attributes: {
                prompted
            }
        }))
    }

    drain() {
        this.sockets.forEach((socket, key) => this.unregister(key))
    }

    register(socket) {
        increment(METRICS, "ws_server.websockets.active", 1)
        const id = this.latestID + 1
        this.latestID += id

        this.sockets.set(id, socket)

        socket.onopen = () => console.log("socket opened");

        const pong = this.sendPong.bind(this, null, id, true)
        socket.onmessage = messageRouter(socket, {
            "ping": pong,
            "subscribe": subscribe,
            "unsubscribe": unsubscribe,
            "nack": nackMessage,
            "echo": echo,
            "bye": closeOnReceivingEnd,
        }, relay)

        const unregister = this.unregister.bind(this)
        socket.onerror = (e) => {
            console.log("socket errored:", e)
            unregister(id)
        };
        socket.onclose = () => unregister(id);
    }

    unregister(id) {
        increment(METRICS, "ws_server.websockets.active", -1)
        const socket = this.sockets.get(id)
        // state in: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
        if (socket != null) {
            socket.close()
        }
        this.sockets.delete(id)
    }
}

// NOTE: this could probably be a middleware that upgrades + register sockets based on header.
function establishWebsocket(_request: Request): Response {
    const upgrade = _request.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() != "websocket") {
        return new Response("request isn't trying to upgrade to websocket.");
    }

    increment(METRICS, "ws_server.tcp_conn.upgrades", 1)
    const { socket, response } = Deno.upgradeWebSocket(_request);
    websocketManager.register(socket)

    return response;
}

function sse(_request: Request): Response {
    let timerId: number | undefined;
    const msg = new TextEncoder().encode(_request.url);
    const body = new ReadableStream({
        start(controller) {
            increment(METRICS, "server.sse.active", 1)
            timerId = setInterval(() => {
                controller.enqueue(msg);
            }, 1000);
        },
        cancel() {
            increment(METRICS, "server.sse.active", -1)
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
    [key: string]: (request: Request) => Response;
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

const httpServer = Deno.serve({
    hostname: "0.0.0.0",
    port: 8080,
    handler
})

let websocketManager = new WebsocketManager()
// NOTE: this dedicated server may not be necessary, but may be useful for:
// - splitting event loops(if you can have more than 1 in deno an)
// - instrumenting some of the lower level bits
const webSocketServer = Deno.listen({
    hostname: "0.0.0.0",
    port: 8081,
    handle
})

async function handle(conn: Deno.Conn) {
    const httpConn = Deno.serveHttp(conn);
    for await (const requestEvent of httpConn) {
        increment(METRICS, "ws_server.request_event", 1)
        await requestEvent.respondWith(handler(requestEvent.request));
        increment(METRICS, "ws_server.request_event", -1)
    }
}

for await (const conn of webSocketServer) {
    increment(METRICS, "ws_server.tcp_conn.active", 1)
    handle(conn);
    increment(METRICS, "ws_server.tcp_conn.active", -1)
}