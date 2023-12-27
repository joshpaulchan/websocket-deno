
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
        return (routes[requestPattern] ?? notFound)(request)
    }
}

export const handler = router({
    "GET /healthz": getHealth,
    "GET /readiness": getReadiness,
    "GET /connections": getConnections
})

const httpServer = Deno.serve({
    hostname: "0.0.0.0",
    port: 8080,
    handler
})

const webSocketServer = Deno.listen({
    hostname: "0.0.0.0",
    port: 8081,
    handle
})

async function handle(conn: Deno.Conn) {
    increment(METRICS, "ws_server.tcp_conn.active", 1)
    const httpConn = Deno.serveHttp(conn);
    for await (const requestEvent of httpConn) {
        await requestEvent.respondWith(handleReq(requestEvent.request));
    }
    increment(METRICS, "ws_server.tcp_conn.active", -1)
}

for await (const conn of webSocketServer) {
    handle(conn);
}
  
function handleReq(req: Request): Response {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() != "websocket") {
        return new Response("request isn't trying to upgrade to websocket.");
    }
    increment(METRICS, "ws_server.tcp_conn.upgrades", 1)
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => console.log("socket opened");
    socket.onmessage = (e) => {
        console.log("socket message:", e.data);
        socket.send(new Date().toString());
    };
    socket.onerror = (e) => console.log("socket errored:", e);
    socket.onclose = () => console.log("socket closed");
    return response;
}