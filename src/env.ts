import { z } from "zod";

const envSchema = z.object({
  DRAGONFLYDB_PASSWORD: z.string().min(10),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
