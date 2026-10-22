#!/usr/bin/env node
import { createShop, loadConfig } from "./index.js";

const config = loadConfig();
const { server } = createShop(config);
server.listen(config.port, config.host, () => {
  console.log(`sandbox-shop 已启动：http://${config.host}:${config.port}/relay（门店网页 ${config.publicBaseUrl}）`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
