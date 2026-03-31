import { serve } from "bun";
import { config } from "./config";
import server from "./http-server/server";

serve({ port: config.global.http_port, fetch: server.fetch });
console.log(`Server running on port ${config.global.http_port}`);
