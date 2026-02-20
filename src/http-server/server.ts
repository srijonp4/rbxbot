import { Hono } from "hono";
import { logger } from "hono/logger";
import valkeyClient from "../services/redis";

const server = new Hono();
const date = new Date();
server.use(logger());
server.get("/", (c) => {
  return c.text("Hello Hono!");
});
server.get("/redisHealth", async (c) => {
  try {
    const redditHealth = await valkeyClient.ping();

    return c.json({
      status: "ok",
      statusCode: 200,
      reddit: redditHealth ? "ok" : "error",
      msg: "redis is up and running",
      timestamp: date.toISOString(),
    });
  } catch (error) {
    // if redis fails throw this error
    console.log(error);
    return c.json({
      status: "error",
      statusCode: 503,
      reddit: "error",
      msg: "internal server error, redis service unavailable",
      timestamp: date.toISOString(),
    });
  }
});

export default server;
