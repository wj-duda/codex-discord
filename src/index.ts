import { runBridge } from "./app.js";

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception", error);
});

void runBridge().catch((error) => {
  console.error(error);
  process.exit(1);
});
