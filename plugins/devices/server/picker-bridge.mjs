// The device picker's MCP server as an agent runs it, over stdio. Each message goes to the plugin
// (server/picker.ts) on its Unix socket with the workspace the agent started in: a request per
// message, so it keeps working when the plugin reloads.
import http from "node:http";
import readline from "node:readline";

const { PASEO_DEVICES_SOCKET: socketPath, PASEO_DEVICES_WORKSPACE: workspace = "" } = process.env;

function send(line) {
  return new Promise((resolve) => {
    const request = http.request(
      { socketPath, method: "POST", path: `/?workspace=${encodeURIComponent(workspace)}` },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      },
    );
    request.on("error", (error) => {
      let id;
      try {
        ({ id } = JSON.parse(line));
      } catch {
        id = null;
      }
      // a notification gets no answer, not even an error
      const message = `The devices plugin isn't running: ${error.message}`;
      resolve(
        id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }),
      );
    });
    request.end(line);
  });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const answer = await send(line);
  if (answer) process.stdout.write(`${answer}\n`);
}
