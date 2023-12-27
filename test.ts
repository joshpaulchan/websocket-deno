import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { handler } from "./main.ts"

Deno.test("GET /healthz always returns 200", async () => {
    const request = new Request(new URL("http://host:8080/healthz"))
    const response = await handler(request)
    assertEquals(response.status, 200);
});

Deno.test("GET /readiness always returns 200", async () => {
    const request = new Request(new URL("http://host:8080/readiness"))
    const response = await handler(request)
    assertEquals(response.status, 200);
});