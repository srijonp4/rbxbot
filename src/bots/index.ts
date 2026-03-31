import type { z } from "zod";
import type { Config } from "../config/config-schema";
import blueskyBot, { blueskyEnvSchema } from "./bluesky";
import redditBot from "./reddit";

type BotFn = (deps: {
  config: Config;
  env: Record<string, string>;
}) => Promise<void>;

export const botRegistry: Record<string, BotFn> = {
  reddit: redditBot as BotFn,
  bluesky: blueskyBot as BotFn,
};

export function getEnvSchemas(config: Config): Record<string, z.ZodType> {
  const schemas: Record<string, z.ZodType> = {};

  if (config.bluesky?.enabled) {
    schemas.bluesky = blueskyEnvSchema;
  }

  return schemas;
}

export function getEnabledBots(config: Config): string[] {
  const bots: string[] = [];
  if (config.reddit?.enabled) {
    bots.push("reddit");
  }
  if (config.bluesky?.enabled) {
    bots.push("bluesky");
  }
  return bots;
}
