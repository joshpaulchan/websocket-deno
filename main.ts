
function getHealth(_request: Request) {
    return new Response(null)
}

function getReadiness(_request: Request) {
    return new Response(null)
}

function getConnections(_request: Request) {
    return new Response(null)
}

function notFound(_request: Request) {
    return new Response(null, {
        status: 404
    })
}

function router(routes) {
    return async function handler(request) {
        const requestPattern = `${request.method} ${new URL(request.url).pathname}`
        return (routes[requestPattern] ?? notFound)(request)
    }
}

Deno.serve({
    hostname: "0.0.0.0",
    port: 8080,
    handler: router({
        "GET /healthz": getHealth,
        "GET /readiness": getReadiness,
        "GET /connections": getConnections
    })
})