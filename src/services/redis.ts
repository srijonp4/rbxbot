import { GlideClient } from "@valkey/valkey-glide";
import { env } from "../env";

const valkeyClient = await GlideClient.createClient({
  addresses: [{ host: "localhost", port: 6379 }],
  credentials: {
    password: env.DRAGONFLYDB_PASSWORD,
  },
});
export default valkeyClient;
