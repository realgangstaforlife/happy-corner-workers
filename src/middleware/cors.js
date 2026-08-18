const DEFAULT_ALLOWED_ORIGINS = [
    "https://happycorner.top",
    "https://www.happycorner.top",
    "https://happycorner.lol",
    "https://www.happycorner.lol",
    "https://happy-corner.vercel.app"
];

function getAllowedOrigins(env) {
    if (env && env.ALLOWED_ORIGINS) {
        return env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
    }
    return DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Mutates the Response object headers to apply CORS logic.
 * @param {Request} request 
 * @param {Response} response 
 * @param {Object} env 
 * @param {string[]} methods 
 */
export function applyCors(request, response, env, methods = ["GET", "POST", "OPTIONS"]) {
    const origin = request.headers.get("Origin");
    const allowlist = getAllowedOrigins(env);

    if (origin && allowlist.includes(origin)) {
        response.headers.set("Access-Control-Allow-Origin", origin);
        response.headers.set("Vary", "Origin");
    }

    response.headers.set("Access-Control-Allow-Methods", methods.join(", "));
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-forwarded-for");
}
