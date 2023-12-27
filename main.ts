
function health(_request: Request) {
    return new Response(null)
}

function readiness(_request: Request) {
    return new Response(null)
}

function connections(_request: Request) {
    return new Response(null)
}

function notFound(_request: Request) {
    return new Response(null, {
        status: 404
    })
}

function router(routes) {
    return async function handler(request) {
        return (routes[new URL(request.url).pathname] ?? notFound)(request)
    }
}

Deno.serve({
    hostname: "0.0.0.0",
    port: 8080,
    handler: router({
        "/healthz": health,
        "/readiness": readiness,
        "/connections": connections
    })
})