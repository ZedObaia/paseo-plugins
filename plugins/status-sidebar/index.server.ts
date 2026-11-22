import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PROGRESS_KEY } from "./shared/progress";
import { withProgress } from "./server/progress";

export default function contribute(server: PluginServerContext) {
  const stopOpen = server.addHook("agent.open.before", async ({ request }) => withProgress(request));
  // A line an agent forgot to clear would outlive its work.
  const stopTurn = server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
    if (agent.metadata[PROGRESS_KEY]) await paseo.agents.ref(agent.id).setMetadata({ [PROGRESS_KEY]: null });
  });
  return () => {
    stopOpen();
    stopTurn();
  };
}
