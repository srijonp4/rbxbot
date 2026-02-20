import { serve } from "bun";
import redditBot from "./bots/reddit";
import server from "./http-server/server";

async function main() {
  serve({ port: 3000, fetch: server.fetch });
  const tasks: Promise<void>[] = [];
  tasks.push(redditBot());
  await Promise.all(tasks);
}
await main();
