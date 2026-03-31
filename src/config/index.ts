import { botRegistry, getEnabledBots, getEnvSchemas } from "../bots";
import { validateEnv } from "../env";
import parseConfigFile from "./config-parser";
import { configSchema } from "./config-schema";

async function loadApp() {
  const raw = await parseConfigFile();
  const config = configSchema.parse(raw);

  const botEnvSchemas = getEnvSchemas(config);

  const env = validateEnv(botEnvSchemas);

  return { config, env };
}

export const { config, env } = await loadApp();

const enabledBotNames = getEnabledBots(config);
for (const name of enabledBotNames) {
  const bot = botRegistry[name];
  if (bot) {
    bot({ config, env });
  }
}

export type { Config } from "./config-schema";
