import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { createApp } from "./app.mjs";
import { ModelSettings } from "./settings.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, process.env.DATA_DIR || ".data");
mkdirSync(dataDir, { recursive: true });
const store = new Store(resolve(dataDir, "frame.sqlite"));
store.recoverJobs();
const settings = new ModelSettings({ store });
const { server, drain } = createApp({
  store,
  settings,
});
const port = Number(process.env.PORT || 8787);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Frame extension API at http://127.0.0.1:${port} | mode=${settings.current().mode} | configure models in extension settings`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(async () => {
      await drain();
      store.close();
      process.exit(0);
    });
  });
