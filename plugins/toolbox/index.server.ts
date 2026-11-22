import { stat } from "node:fs/promises";
import path from "node:path";
import { execCommand, type PluginServerContext } from "@getpaseo/plugin/server";
import {
  addRpc,
  applyRpc,
  listRpc,
  loginCancelRpc,
  loginRpc,
  loginStatusRpc,
  packRpc,
  permissionRpc,
  removeRpc,
  restoreRpc,
  skillRpc,
  trustRpc,
  type Provider,
} from "./shared/contracts";
import type { Agent } from "./server/agent";
import { claudeAgent } from "./server/claude";
import { codexAgent } from "./server/codex";
import { opencodeAgent } from "./server/opencode";
import { packSkill } from "./server/files";
import { cliError } from "./server/run";
import { cancelLogin, loginStatus, stopLogins, undoRemoval } from "./server/sessions";

const agents: Record<Provider, Agent> = { claude: claudeAgent, codex: codexAgent, opencode: opencodeAgent };

/** A chat's folder: an absolute path to a directory on this host. */
async function folder(cwd: string): Promise<string> {
  const isDir =
    path.isAbsolute(cwd) &&
    (await stat(cwd).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  if (!isDir) throw new Error(`${cwd} isn't a folder on this host`);
  return cwd;
}

/**
 * Restarts a chat's agent process, keeping its history: Paseo's "Reload agent". Plugins reach it
 * through the paseo CLI, whose path Paseo gives its plugins.
 */
async function reloadChat(agentId: string): Promise<void> {
  const args = ["agent", "reload", agentId, "--json"];
  if (process.env.PASEO_HOME) args.push("--home", process.env.PASEO_HOME);
  try {
    await execCommand(process.env.PASEO_CLI ?? "paseo", args, { timeout: 120_000 });
  } catch (error) {
    throw new Error(`Saved, but the chat didn't restart: ${cliError(error)}`);
  }
}

export default function contribute(server: PluginServerContext) {
  server.handle(listRpc, async ({ provider, cwd, refresh }) =>
    agents[provider].list(await folder(cwd), refresh),
  );

  server.handle(applyRpc, async ({ provider, cwd, agentId, changes, restart }, { paseo }) => {
    const dir = await folder(cwd);
    const chat = agentId ? paseo.agents.ref(agentId) : null;
    const agent = chat ? (await chat.refresh())?.agent : null;
    if (chat && (!agent || agent.cwd !== dir)) throw new Error("That chat isn't in this folder any more");
    if (agent && agent.provider !== provider) throw new Error("That chat runs another agent");
    if (agent?.status === "running" || agent?.status === "initializing")
      throw new Error("Wait for the chat to finish its turn, then apply");

    const done = await agents[provider].save(dir, changes);
    // without a chat, or with a closed one, the agent reads them when a chat starts
    if (!chat || !agent || agent.status === "closed")
      return {
        message: changes.length
          ? "Saved. Chats here get them when they start."
          : "The chat isn't running: it connects when it starts.",
      };
    if (restart || done.restart) {
      await reloadChat(agent.id);
      // no changes: a restart on its own, which reconnects every connector
      return {
        message: changes.length
          ? "Applied. The chat restarted and kept its history."
          : "Reconnected. The chat restarted and kept its history.",
      };
    }
    for (const command of done.commands) await chat.run(command, { timeoutMs: 60_000 });
    return { message: "Applied to this chat" };
  });

  server.handle(addRpc, async ({ provider, cwd, name, where, server: entry }) => ({
    message: await agents[provider].add(await folder(cwd), name, where, entry),
  }));

  server.handle(removeRpc, async ({ provider, cwd, name }) => ({
    message: `Removed ${name}`,
    undoId: await agents[provider].remove(await folder(cwd), name),
  }));

  server.handle(restoreRpc, async ({ undoId }) => ({
    message: `${(await undoRemoval(undoId)).name} is back`,
  }));

  server.handle(permissionRpc, async ({ provider, cwd, server: name, tool, behavior }) =>
    agents[provider].setRule(await folder(cwd), name, tool, behavior),
  );

  server.handle(trustRpc, async ({ provider, cwd }) => ({
    message: await agents[provider].trust(await folder(cwd)),
  }));

  server.handle(skillRpc, async ({ provider, cwd, name }) => agents[provider].skill(await folder(cwd), name));

  server.handle(packRpc, async ({ provider, cwd, name }) =>
    packSkill(await agents[provider].skill(await folder(cwd), name)),
  );

  server.handle(loginRpc, async ({ provider, cwd, name, again }) =>
    agents[provider].login(await folder(cwd), name, again),
  );

  server.handle(loginStatusRpc, ({ loginId, paste }) => loginStatus(loginId, paste));

  server.handle(loginCancelRpc, ({ loginId }) => {
    cancelLogin(loginId);
    return { ok: true as const };
  });

  return () => stopLogins();
}
