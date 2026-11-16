export function rejectUntrustedRequest(req, port) {
    const host = `127.0.0.1:${port}`;
    const origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
        return { status: 403, error: "Request origin is not authorized." };
    }
    if (req.method === "POST") {
        if (req.headers.origin !== origin) {
            return { status: 403, error: "Request origin is not authorized." };
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
            return { status: 415, error: "Request body must be JSON." };
        }
    }
    return null;
}
