import { resolve } from "node:path";
import { createChatGptBridge } from "./bridge.ts";

const { server } = await createChatGptBridge({ directory: resolve(".chatgpt") });
console.log("ChatGPT local bridge ready on 127.0.0.1:1455");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
