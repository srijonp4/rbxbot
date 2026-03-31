# Architecture Overview

This document explains the architecture of the rbxbot project, including how configuration, environment variables, and bots work together.

## Directory Structure

```
src/
├── index.ts                 # Entry point - starts HTTP server
├── env.ts                   # Base env validation (Redis password)
├── config/
│   ├── index.ts             # Config loader + env validator + bot starter
│   ├── config-parser.ts     # TOML file parser
│   └── config-schema.ts     # Zod schemas for TOML validation
├── bots/
│   ├── index.ts             # Bot registry + helper functions
│   ├── reddit.ts            # Reddit bot (public JSON API)
│   └── bluesky.ts           # Bluesky bot (requires auth)
├── services/
│   └── redis.ts             # Valkey/Glide client
└── http-server/
    └── server.ts            # Hono server + dynamic health endpoints
config.toml                   # User configuration file
```

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Application Startup                          │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. src/config/index.ts (loadApp)                                   │
│     ├─ Parse config.toml via config-parser.ts                       │
│     ├─ Validate TOML structure with config-schema.ts                │
│     ├─ Detect enabled bots from config                              │
│     ├─ Collect env schemas for enabled bots only                    │
│     └─ Validate process.env against merged schemas                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  2. Export { config, env }   │   │  3. Start enabled bots       │
│     - Available everywhere   │   │     - botRegistry[name]()    │
│     - Type-safe access       │   │     - Each runs infinitely   │
└──────────────────────────────┘   └──────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. src/index.ts                                                    │
│     └─ Start HTTP server on config.global.http_port                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Configuration System

### config.toml

User-facing configuration file in TOML format:

```toml
[global]
playwright_timeout = 10
http_port = 8000
cookie_file = "cookie.json"

[redis]
host = "localhost"
port = 6379

[reddit]
enabled = true
delay = 300
subreddit_list = ["unixporn"]
flair_list = ["screenshot", "material"]
users_blacklist = ["bot_account"]

[bluesky]
enabled = false
delay = 300
```

### Schema Validation (src/config/config-schema.ts)

Each section has a Zod schema with defaults:

| Section | Required | Defaults Applied |
|---------|----------|------------------|
| `global` | Yes | `playwright_timeout: 10`, `http_port: 8000`, `cookie_file: "cookie.json"` |
| `redis` | Yes | `host: "localhost"`, `port: 6379` |
| `reddit` | Optional | `enabled: false`, `delay: 300` |
| `bluesky` | Optional | `enabled: false`, `delay: 300` |

Uses `z.looseObject()` to allow unknown sections (e.g., `[ollama]`, `[lemmy]`) without errors.

## Environment Variables System

### Two-Tier Validation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Base Env (Always Required)                    │
├─────────────────────────────────────────────────────────────────┤
│  DRAGONFLYDB_PASSWORD - Redis password (min 10 chars)           │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              Bot Env (Only if bot is enabled)                    │
├─────────────────────────────────────────────────────────────────┤
│  Bluesky (if bluesky.enabled = true):                           │
│    - BLUESKY_HANDLE                                              │
│    - BLUESKY_PASSWORD                                            │
│                                                                  │
│  Reddit: No env required (uses public JSON API)                  │
└─────────────────────────────────────────────────────────────────┘
```

### Conditional Validation Flow

```typescript
// src/env.ts
export function validateEnv(botEnvSchemas: Record<string, z.ZodType>) {
  const schemas = Object.values(botEnvSchemas);
  
  if (schemas.length === 0) {
    return baseEnvSchema.parse(process.env);
  }
  
  // Merge base + bot schemas using object destructuring
  const mergedSchema = schemas.reduce(
    (acc, schema) => z.object({ ...acc.shape, ...schema.shape }),
    baseEnvSchema,
  );
  
  return mergedSchema.parse(process.env);
}
```

### Error Behavior

| Config | Missing Env | Result |
|--------|-------------|--------|
| `bluesky.enabled = false` | `BLUESKY_HANDLE` | ✅ Ignored |
| `bluesky.enabled = true` | `BLUESKY_HANDLE` | ❌ ZodError: Required |
| Any config | `DRAGONFLYDB_PASSWORD` | ❌ ZodError: Required |

## Bot System

### Registry Pattern

Each bot is registered in `src/bots/index.ts`:

```typescript
export const botRegistry: Record<string, BotFn> = {
  reddit: redditBot as BotFn,
  bluesky: blueskyBot as BotFn,
};
```

### Bot Interface

```typescript
type BotFn = (deps: { 
  config: Config; 
  env: Record<string, string> 
}) => Promise<void>;
```

### Enabling/Disabling Bots

```typescript
// src/bots/index.ts
export function getEnabledBots(config: Config): string[] {
  const bots: string[] = [];
  if (config.reddit?.enabled) bots.push("reddit");
  if (config.bluesky?.enabled) bots.push("bluesky");
  return bots;
}
```

### Bot Lifecycle

```
┌─────────────────┐
│  Bot started    │
│  (infinite loop)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Perform task   │
│  (scrape, post) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Sleep for      │
│  config.delay   │
└────────┬────────┘
         │
         └──────► Loop forever
```

## HTTP Server

### Dynamic Endpoints

Endpoints are registered based on enabled bots:

```typescript
// Always available
GET /health          → Redis ping status
GET /                → "Hello Hono!"

// Only if reddit.enabled = true
GET /health/reddit   → Reddit bot status + subreddit list

// Only if bluesky.enabled = true
GET /health/bluesky  → Bluesky bot status + handle
```

### Health Response Examples

**GET /health** (Redis check)
```json
{
  "status": "ok",
  "statusCode": 200,
  "redis": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**GET /health/reddit**
```json
{
  "status": "ok",
  "bot": "reddit",
  "subreddits": ["unixporn", "linux"],
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Dependency Flow

```
src/index.ts
    │
    ├── imports ──► src/config/index.ts
    │                    │
    │                    ├── src/config/config-parser.ts
    │                    │       └── reads config.toml
    │                    │
    │                    ├── src/config/config-schema.ts
    │                    │       └── Zod validation schemas
    │                    │
    │                    ├── src/env.ts
    │                    │       └── validates process.env
    │                    │
    │                    └── src/bots/index.ts
    │                            ├── src/bots/reddit.ts
    │                            └── src/bots/bluesky.ts
    │
    └── imports ──► src/http-server/server.ts
                         └── src/services/redis.ts
                                 └── uses config.redis + env.DRAGONFLYDB_PASSWORD
```

## Adding a New Bot

1. **Create bot file** (`src/bots/newbot.ts`):
   ```typescript
   import { z } from "zod";
   import type { Config } from "../config/config-schema";

   export const newbotEnvSchema = z.object({
     NEWBOT_API_KEY: z.string(),
   });

   export type NewbotEnv = z.infer<typeof newbotEnvSchema>;

   async function newbotBot({ config, env }: { config: Config; env: NewbotEnv }) {
     while (true) {
       // Bot logic here
       await sleep(config.newbot?.delay ?? 300);
     }
   }

   export default newbotBot;
   ```

2. **Add to config schema** (`src/config/config-schema.ts`):
   ```typescript
   export const newbotSchema = z.object({
     enabled: z.boolean().default(false),
     delay: z.number().int().positive().default(300),
   });

   export const configSchema = z.looseObject({
     // ... existing
     newbot: newbotSchema.optional(),
   });
   ```

3. **Register bot** (`src/bots/index.ts`):
   ```typescript
   import newbotBot, { newbotEnvSchema } from "./newbot";

   export const botRegistry = {
     reddit: redditBot as BotFn,
     bluesky: blueskyBot as BotFn,
     newbot: newbotBot as BotFn,
   };

   export function getEnvSchemas(config: Config) {
     const schemas: Record<string, z.ZodType> = {};
     // ... existing
     if (config.newbot?.enabled) {
       schemas.newbot = newbotEnvSchema;
     }
     return schemas;
   }

   export function getEnabledBots(config: Config) {
     const bots: string[] = [];
     // ... existing
     if (config.newbot?.enabled) bots.push("newbot");
     return bots;
   }
   ```

4. **Add health endpoint** (`src/http-server/server.ts`):
   ```typescript
   if (config.newbot?.enabled) {
     server.get("/health/newbot", (c) => {
       return c.json({ status: "ok", bot: "newbot" });
     });
   }
   ```

## Key Design Decisions

| Decision | Reason |
|----------|--------|
| TOML over JSON | Human-friendly, comments support, common in config |
| Conditional env validation | Fail fast only for enabled bots, reduce setup friction |
| Bot registry pattern | Decouples bot loading from individual bots |
| `z.looseObject()` | Allow unknown sections in config for future bots |
| Config module pattern | Single source of truth, loaded once at startup |
| Top-level await | Simplifies async config loading |
