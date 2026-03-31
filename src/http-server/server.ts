import { Hono } from "hono";
import { logger } from "hono/logger";
import { config, env } from "../config";
import getValkeyClient from "../services/redis";

const server = new Hono();
server.use(logger());

server.get("/", (c) => {
  return c.text("Hello Hono!");
});

server.get("/health", async (c) => {
  try {
    const valkeyClient = await getValkeyClient();
    await valkeyClient.ping();
    return c.json({
      status: "ok",
      statusCode: 200,
      redis: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log(error);
    return c.json({
      status: "error",
      statusCode: 503,
      redis: "error",
      msg: "redis service unavailable",
      timestamp: new Date().toISOString(),
    });
  }
});

if (config.reddit?.enabled) {
  server.get("/health/reddit", (c) => {
    return c.json({
      status: "ok",
      bot: "reddit",
      subreddits: config.reddit?.subreddit_list,
      timestamp: new Date().toISOString(),
    });
  });
}

if (config.bluesky?.enabled) {
  server.get("/health/bluesky", (c) => {
    return c.json({
      status: "ok",
      bot: "bluesky",
      handle: env.BLUESKY_HANDLE,
      timestamp: new Date().toISOString(),
    });
  });
}

export default server;
