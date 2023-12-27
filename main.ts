
function getHealth(_request: Request): Response {
    return new Response(null)
}

function getReadiness(_request: Request): Response {
    return new Response(null)
}

let WEBSOCKETS: Map = new Map([])
function getConnections(_request: Request): Response {
    const body = JSON.stringify({
        ts: new Date(),
        attributes: {
            websockets: WEBSOCKETS.size
        }
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

Deno.serve({
    hostname: "0.0.0.0",
    port: 8080,
    handler
})