import { z } from "zod";

export const globalSchema = z.object({
  playwright_timeout: z.number().int().positive().default(10),
  http_port: z.number().int().positive().default(8000),
  cookie_file: z.string().default("cookie.json"),
});

export const redisSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().int().positive().default(6379),
});

export const redditSchema = z.object({
  enabled: z.boolean().default(false),
  delay: z.number().int().positive().default(300),
  subreddit_list: z.array(z.string()).default([]),
  flair_blocklist: z.array(z.string()).default([]),
  users_blacklist: z.array(z.string()).default([]),
});

export const blueskySchema = z.object({
  enabled: z.boolean().default(false),
  delay: z.number().int().positive().default(300),
  hashtag_list: z.array(z.string()).default([]),
});

export const configSchema = z.looseObject({
  global: globalSchema,
  redis: redisSchema,
  reddit: redditSchema.optional(),
  bluesky: blueskySchema.optional(),
});

export type Config = z.infer<typeof configSchema>;
