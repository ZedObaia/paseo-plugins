// Serves simulator streams and input with serve-sim's own middleware, on a Unix socket in a
// folder only this user can open: no TCP port, so no web page or other machine can reach it.
// Started by server/ios.ts on the Node in PATH (serve-sim loads a native module the desktop app's
// runtime refuses); it exits when the plugin closes its stdin.
import { chmodSync, rmSync } from "node:fs";
import http from "node:http";
import { simMiddleware } from "serve-sim/middleware";

const socketPath = process.argv[2];
const middleware = simMiddleware();
const server = http.createServer((req, res) => {
  void middleware(req, res, async () => {
    res.writeHead(404).end();
  });
});
server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head));

rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  process.stdout.write("ready\n");
});
process.stdin.on("end", () => process.exit(0)).resume();
