import { z } from "zod";

const baseEnvSchema = z.object({
  DRAGONFLYDB_PASSWORD: z.string().min(10),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function validateEnv(botEnvSchemas: Record<string, z.ZodType>) {
  const schemas = Object.values(botEnvSchemas) as z.ZodObject<z.ZodRawShape>[];
  if (schemas.length === 0) {
    return baseEnvSchema.parse(process.env) as BaseEnv & Record<string, string>;
  }

  const mergedSchema = schemas.reduce(
    (acc, schema) => z.object({ ...acc.shape, ...schema.shape }),
    baseEnvSchema
  );

  return mergedSchema.parse(process.env) as BaseEnv & Record<string, string>;
}

export type Env = ReturnType<typeof validateEnv>;
