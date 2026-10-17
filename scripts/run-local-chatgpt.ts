import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createChatGptBridge } from "./chatgpt/bridge.ts";
import { relayTermination } from "./relay-termination.ts";

const { server } = await createChatGptBridge({ directory: resolve(".chatgpt") });
console.log("ChatGPT local bridge ready. Workshop: http://localhost:8787");
const child = spawn(process.execPath, ["scripts/run-local.ts"], { stdio: "inherit" });
child.once("exit", () => { server.close(); server.closeAllConnections(); });
relayTermination(child);
