"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const defaultPort = 22846;
const parsePort = (...candidates) => {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        const parsed = parseInt(candidate, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return defaultPort;
};
async function main() {
    const app = await (0, app_1.createApp)();
    const port = parsePort(process.env.PANEL_PROXY_PORT, process.env.PORT);
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`panel-proxy listening on http://0.0.0.0:${port}`);
}
if (require.main === module) {
    main().catch((err) => {
        console.error('panel-proxy failed to start', err);
        process.exit(1);
    });
}
