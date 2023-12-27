
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

class WebsocketManager {
    constructor(heartbeatIntervalSeconds=60) {
        this.sockets = new Map()
        this.latestID = 1
        this.heartBeatInterval = setInterval(this.sendHeartBeats.bind(this), heartbeatIntervalSeconds*1000)
    }

    sendHeartBeats() {
        const sendHeartBeat = this.sendPong.bind(this)
        this.sockets.forEach((socket, key) => sendHeartBeat(key, false))
    }

    // TODO: don't actually know if I should be sending pongs, or it's already handled by Deno as part of implementing the websocket spec
    // probably fine to keep for now
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

        const pong = this.sendPong.bind(this)
        socket.onmessage = (e) => {
            console.log("socket message:", e.data, e.origin, e.source);
            if (JSON.parse(e.data).type === "ping") {
                pong(id, true)
                return
            }
            socket.send(new Date().toString());
        };

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

function notFound(_request: Request): Response {
    return new Response(null, {
        status: 404
    })
}

type RouterConfig = {
    [key: string]: (request: Request) => Response;
  };

function router(routes: RouterConfig) {
    return async function handler(request: Request): Promise<Response> {
        const requestPattern = `${request.method} ${new URL(request.url).pathname}`
        return await (routes[requestPattern] ?? notFound)(request)
    }
}

export const handler = router({
    "GET /healthz": getHealth,
    "GET /readiness": getReadiness,
    "GET /connections": getConnections,
    "DELETE /connections": closeConnection,
    "GET /websocket": establishWebsocket,
})

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