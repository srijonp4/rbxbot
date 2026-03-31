import { sleep } from "bun";

import type { Config } from "../config/config-schema";
import { fetchSubredditPosts } from "../services/reddit-fetcher";

interface RedditBotDeps {
  config: Config;
}

async function redditBot({ config }: RedditBotDeps) {
  const subreddits = config.reddit?.subreddit_list ?? [];

  if (subreddits.length === 0) {
    console.log("[reddit] No subreddits configured, exiting bot loop");
    return;
  }

  console.log(`[reddit] Monitoring subreddits: ${subreddits.join(", ")}`);

  while (true) {
    try {
      for (const subreddit of subreddits) {
        const posts = await fetchSubredditPosts(subreddit, {
          limit: 10,
          sort: "new",
          flairBlocklist: config.reddit?.flair_blocklist,
          usersBlacklist: config.reddit?.users_blacklist,
        });
        console.log(
          `[reddit] Fetched ${posts.length} posts from r/${subreddit}`
        );
      }
    } catch (error) {
      console.error("[reddit] Error:", error);
    }
    await sleep((config.reddit?.delay ?? 300) * 1000);
  }
}

export default redditBot;
