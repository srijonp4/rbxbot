import { GlideClient } from "@valkey/valkey-glide";

let clientPromise: Promise<GlideClient> | null = null;

async function createClient(): Promise<GlideClient> {
  // Lazy import to break circular dependency: redis → config → bots → bluesky → redis
  const { config, env } = await import("../config");

  const redisHost = process.env.REDIS_HOST ?? config.redis.host;

  return GlideClient.createClient({
    addresses: [{ host: redisHost, port: config.redis.port }],
    credentials: {
      password: env.DRAGONFLYDB_PASSWORD,
    },
  });
}

function getValkeyClient(): Promise<GlideClient> {
  if (!clientPromise) {
    clientPromise = createClient();
  }
  return clientPromise;
}

export default getValkeyClient;
