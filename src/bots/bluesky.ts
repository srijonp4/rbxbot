import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, CredentialSession, RichText } from "@atproto/api";
import type { BlobRef } from "@atproto/lexicon";
import { TimeUnit } from "@valkey/valkey-glide";
import { $, file, sleep, write } from "bun";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { z } from "zod";
import type { Config } from "../config/config-schema";
import {
  downloadMedia,
  fetchSubredditPosts,
  MAX_VIDEO_SIZE_BYTES,
  type RedditPost,
} from "../services/reddit-fetcher";
import getValkeyClient from "../services/redis";

// if the bluesky bot is enabled these envs are needed in the environment variable the bottom schema defines that
export const blueskyEnvSchema = z.object({
  BLUESKY_HANDLE: z.string(),
  BLUESKY_PASSWORD: z.string(),
});

const SESSION_FILE = "./bluesky-session.json";
const POSTED_KEY_PREFIX = "bluesky:posted:";
const POSTED_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_BLUESKY_TEXT_LENGTH = 300;
const REDDIT_POST_ID_PATTERN = /^[a-z0-9]+$/i;
const HANDLE_AT_PREFIX = /^@/;

const BLUESKY_MAX_BLOB_SIZE = 1_000_000; // Bluesky's 1MB limit for image blobs
const COMPRESSION_QUALITY_START = 80;
const COMPRESSION_QUALITY_STEP = 10;
const COMPRESSION_QUALITY_MIN = 30;
const MAX_IMAGE_DIMENSION = 2048;

export type BlueskyEnv = z.infer<typeof blueskyEnvSchema>;

interface BlueskyBotDeps {
  config: Config;
  env: BlueskyEnv;
}

function createSession(): CredentialSession {
  return new CredentialSession(
    new URL("https://bsky.social"),
    undefined, // fetch (uses default)
    (_, sess) => {
      // Called on login, refresh, or session change — save to disk with restrictive permissions
      if (sess) {
        write(SESSION_FILE, JSON.stringify(sess), { mode: 0o600 });
      }
    }
  );
}

async function tryResumeSession(
  credSession: CredentialSession
): Promise<boolean> {
  try {
    const sessionFile = file(SESSION_FILE);
    if (!(await sessionFile.exists())) {
      return false;
    }
    const saved = await sessionFile.json();
    await credSession.resumeSession(saved);
    console.log("[bluesky] Resumed saved session");
    return true;
  } catch {
    console.log("[bluesky] Saved session invalid or expired, need fresh login");
    return false;
  }
}

async function loginFresh(
  credSession: CredentialSession,
  env: BlueskyEnv
): Promise<void> {
  // AT Protocol expects handle without @ prefix
  const identifier = env.BLUESKY_HANDLE.replace(HANDLE_AT_PREFIX, "");
  await credSession.login({
    identifier,
    password: env.BLUESKY_PASSWORD,
  });
  console.log("[bluesky] Logged in fresh");
}

async function getAuthenticatedAgent(
  credSession: CredentialSession,
  env: BlueskyEnv
): Promise<Agent> {
  const resumed = await tryResumeSession(credSession);
  if (!resumed) {
    await loginFresh(credSession, env);
  }
  return new Agent(credSession);
}

async function ensureAuthenticated(
  agent: Agent,
  credSession: CredentialSession,
  env: BlueskyEnv
): Promise<Agent> {
  try {
    // Lightweight check — if session is still valid this is cheap
    const handle = env.BLUESKY_HANDLE.replace(HANDLE_AT_PREFIX, "");
    await agent.getProfile({ actor: handle });
    return agent;
  } catch {
    // Session expired mid-run, re-authenticate
    console.log("[bluesky] Session expired, re-authenticating...");
    await loginFresh(credSession, env);
    return new Agent(credSession);
  }
}

function isValidRedditPostId(id: string): boolean {
  return REDDIT_POST_ID_PATTERN.test(id) && id.length <= 20;
}

async function isAlreadyPosted(postId: string): Promise<boolean> {
  if (!isValidRedditPostId(postId)) {
    return true; // Treat invalid IDs as already posted to skip them
  }
  const client = await getValkeyClient();
  const result = await client.get(`${POSTED_KEY_PREFIX}${postId}`);
  return result !== null;
}

async function markAsPosted(postId: string): Promise<void> {
  if (!isValidRedditPostId(postId)) {
    return;
  }
  const client = await getValkeyClient();
  await client.set(`${POSTED_KEY_PREFIX}${postId}`, "1", {
    expiry: { type: TimeUnit.Seconds, count: POSTED_TTL_SECONDS },
  });
}

const BOLD_UPPERCASE_OFFSET = 0x1_d4_00 - 0x41; // 𝐀 - A
const BOLD_DIGIT_OFFSET = 0x1_d7_ce - 0x30; // 𝟎 - 0

const ITALIC_UPPERCASE_OFFSET = 0x1_d4_34 - 0x41; // 𝐴 - A
// italic lowercase: a=0x1D44E, but h=0x210E (planck constant exception)

function toBold(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x41 && code <= 0x5a) {
      // A-Z
      result += String.fromCodePoint(code + BOLD_UPPERCASE_OFFSET);
    } else if (code >= 0x61 && code <= 0x7a) {
      // a-z → 0x1D41A to 0x1D433
      result += String.fromCodePoint(code - 0x61 + 0x1_d4_1a);
    } else if (code >= 0x30 && code <= 0x39) {
      // 0-9
      result += String.fromCodePoint(code + BOLD_DIGIT_OFFSET);
    } else {
      result += char;
    }
  }
  return result;
}

function toItalic(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x41 && code <= 0x5a) {
      // A-Z
      result += String.fromCodePoint(code + ITALIC_UPPERCASE_OFFSET);
    } else if (code >= 0x61 && code <= 0x7a) {
      // a-z → 0x1D44E to 0x1D467, except h → U+210E
      if (char === "h") {
        result += String.fromCodePoint(0x21_0e);
      } else {
        result += String.fromCodePoint(code - 0x61 + 0x1_d4_4e);
      }
    } else {
      result += char;
    }
  }
  return result;
}

function buildPostText(post: RedditPost, hashtags: string[]): string {
  const boldTitle = toBold(post.title);
  const italicAuthor = toItalic(`u/${post.author}`);
  const hashtagLine =
    hashtags.length > 0 ? hashtags.map((tag) => `#${tag}`).join(" ") : "";
  const parts = [
    boldTitle,
    "",
    `r/${post.subreddit} | ${italicAuthor}`,
    post.permalink,
  ];
  if (hashtagLine) {
    parts.push(hashtagLine);
  }
  const text = parts.join("\n");

  // Bluesky counts graphemes, not UTF-16 code units
  const graphemeLength = [...text].length;
  if (graphemeLength > MAX_BLUESKY_TEXT_LENGTH) {
    const truncatedTitle = `${toBold(post.title.slice(0, 150))}...`;
    const truncatedParts = [
      truncatedTitle,
      "",
      `r/${post.subreddit} | ${italicAuthor}`,
      post.permalink,
    ];
    if (hashtagLine) {
      truncatedParts.push(hashtagLine);
    }
    return truncatedParts.join("\n");
  }

  return text;
}

const VIDEO_POLL_INTERVAL_MS = 1500;
const VIDEO_POLL_MAX_ATTEMPTS = 120; // ~3 minutes max wait
const VIDEO_SERVICE_DID = "did:web:video.bsky.app";
const VIDEO_SERVICE_URL = "https://video.bsky.app";

async function getVideoServiceAuth(agent: Agent, lxm: string): Promise<string> {
  const response = await agent.com.atproto.server.getServiceAuth({
    aud: VIDEO_SERVICE_DID,
    lxm,
  });
  return response.data.token;
}

function videoServiceQuery(
  endpoint: string,
  params?: Record<string, string>,
  token?: string
): Promise<Response> {
  const url = new URL(endpoint, VIDEO_SERVICE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { headers });
}

async function uploadAndPollVideo(
  agent: Agent,
  videoData: Uint8Array
): Promise<{ jobId: string; blobRef: BlobRef } | null> {
  const userDid = agent.did;
  if (!userDid) {
    console.error("[bluesky] No DID available for video upload auth");
    return null;
  }

  // Check upload limits (requires service auth)
  const limitsToken = await getVideoServiceAuth(
    agent,
    "app.bsky.video.getUploadLimits"
  );
  const limitsResponse = await videoServiceQuery(
    "/xrpc/app.bsky.video.getUploadLimits",
    { did: userDid },
    limitsToken
  );
  if (!limitsResponse.ok) {
    console.error(
      `[bluesky] Failed to check upload limits (${limitsResponse.status})`
    );
    return null;
  }
  const limits = (await limitsResponse.json()) as {
    canUpload: boolean;
    message?: string;
    error?: string;
  };
  if (!limits.canUpload) {
    console.error(
      `[bluesky] Video upload not allowed: ${limits.message ?? limits.error ?? "unknown reason"}`
    );
    return null;
  }

  // Upload directly to video service (requires service auth)
  const token = await getVideoServiceAuth(agent, "app.bsky.video.uploadVideo");
  const uploadUrl = new URL(
    "/xrpc/app.bsky.video.uploadVideo",
    VIDEO_SERVICE_URL
  );
  uploadUrl.searchParams.set("did", userDid);
  uploadUrl.searchParams.set("name", "video.mp4");

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "video/mp4",
    },
    body: videoData,
  });

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text();
    console.error(
      `[bluesky] Video upload failed (${uploadResponse.status}): ${errorBody}`
    );
    return null;
  }

  const uploadResult = (await uploadResponse.json()) as {
    jobStatus: { jobId: string };
  };
  const { jobId } = uploadResult.jobStatus;
  console.log(`[bluesky] Video upload started, job: ${jobId}`);

  // Poll until processing completes
  for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(VIDEO_POLL_INTERVAL_MS);

    const statusToken = await getVideoServiceAuth(
      agent,
      "app.bsky.video.getJobStatus"
    );
    const statusResponse = await videoServiceQuery(
      "/xrpc/app.bsky.video.getJobStatus",
      { jobId },
      statusToken
    );
    if (!statusResponse.ok) {
      console.error(
        `[bluesky] Failed to poll job status (${statusResponse.status})`
      );
      continue;
    }

    const statusResult = (await statusResponse.json()) as {
      jobStatus: {
        state: string;
        blob?: BlobRef;
        error?: string;
        progress?: number;
      };
    };
    const { state, blob, error, progress } = statusResult.jobStatus;

    if (state === "JOB_STATE_COMPLETED" && blob) {
      console.log(`[bluesky] Video processing completed for job: ${jobId}`);
      return { jobId, blobRef: blob };
    }

    if (state === "JOB_STATE_FAILED") {
      console.error(`[bluesky] Video processing failed: ${error}`);
      return null;
    }

    if (progress !== undefined) {
      console.log(
        `[bluesky] Video processing ${Math.round(progress * 100)}%...`
      );
    }
  }

  console.error("[bluesky] Video processing timed out");
  return null;
}

async function compressImageForBluesky(
  data: Uint8Array
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (data.byteLength <= BLUESKY_MAX_BLOB_SIZE) {
    return { data, mimeType: "image/jpeg" };
  }

  // Resize once, then only vary quality
  const resized = await sharp(data)
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();

  for (
    let quality = COMPRESSION_QUALITY_START;
    quality >= COMPRESSION_QUALITY_MIN;
    quality -= COMPRESSION_QUALITY_STEP
  ) {
    const compressed = await sharp(resized).jpeg({ quality }).toBuffer();
    if (compressed.byteLength <= BLUESKY_MAX_BLOB_SIZE) {
      return { data: new Uint8Array(compressed), mimeType: "image/jpeg" };
    }
  }

  // Final fallback: aggressive resize
  const fallback = await sharp(data)
    .resize({ width: 1024, height: 1024, fit: "inside" })
    .jpeg({ quality: COMPRESSION_QUALITY_MIN })
    .toBuffer();

  return { data: new Uint8Array(fallback), mimeType: "image/jpeg" };
}

async function postWithImages(
  agent: Agent,
  richText: RichText,
  post: RedditPost
): Promise<void> {
  const images: Array<{ alt: string; image: BlobRef }> = [];

  for (const mediaItem of post.mediaItems) {
    try {
      const downloaded = await downloadMedia(mediaItem.url);
      const { data, mimeType } = await compressImageForBluesky(downloaded.data);
      const uploadResponse = await agent.uploadBlob(data, {
        encoding: mimeType,
      });
      images.push({
        alt: post.title,
        image: uploadResponse.data.blob,
      });
    } catch (error) {
      console.error(
        `[bluesky] Failed to upload image ${mediaItem.url}:`,
        error
      );
    }
  }

  if (images.length === 0) {
    // All image uploads failed, post text-only
    await agent.post({
      text: richText.text,
      facets: richText.facets,
    });
    return;
  }

  await agent.post({
    text: richText.text,
    facets: richText.facets,
    embed: {
      $type: "app.bsky.embed.images",
      images,
    },
  });
}

async function mergeVideoAndAudio(
  videoData: Uint8Array,
  audioData: Uint8Array | null
): Promise<Uint8Array> {
  if (!audioData) {
    return videoData;
  }

  const uid = randomUUID();
  const tmp = tmpdir();
  const videoPath = join(tmp, `rbxbot-video-${uid}.mp4`);
  const audioPath = join(tmp, `rbxbot-audio-${uid}.mp4`);
  const outputPath = join(tmp, `rbxbot-merged-${uid}.mp4`);

  try {
    await write(videoPath, videoData);
    await write(audioPath, audioData);

    const ffmpeg = ffmpegPath ?? "ffmpeg";
    const result =
      await $`${ffmpeg} -y -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -shortest ${outputPath} -loglevel error`.quiet();

    if (result.exitCode !== 0) {
      console.error("[bluesky] ffmpeg merge failed, using video-only");
      return videoData;
    }

    const merged = file(outputPath);
    return new Uint8Array(await merged.arrayBuffer());
  } catch (error) {
    console.error("[bluesky] Failed to merge video+audio:", error);
    return videoData;
  } finally {
    // Clean up temp files
    await $`rm -f ${videoPath} ${audioPath} ${outputPath}`.quiet().nothrow();
  }
}

async function downloadVideoWithAudio(
  videoItem: RedditPost["mediaItems"][0]
): Promise<Uint8Array> {
  const { data: videoData } = await downloadMedia(
    videoItem.url,
    MAX_VIDEO_SIZE_BYTES
  );

  if (!videoItem.audioUrl) {
    return videoData;
  }

  // Try to download audio, but don't fail if it's not available
  let audioData: Uint8Array | null = null;
  try {
    const audio = await downloadMedia(videoItem.audioUrl, MAX_VIDEO_SIZE_BYTES);
    audioData = audio.data;
  } catch {
    console.log("[bluesky] No audio track available, using video-only");
  }

  return mergeVideoAndAudio(videoData, audioData);
}

async function postWithVideo(
  agent: Agent,
  richText: RichText,
  post: RedditPost,
  presentation?: "default" | "gif"
): Promise<void> {
  const videoItem = post.mediaItems[0];
  if (!videoItem) {
    await agent.post({ text: richText.text, facets: richText.facets });
    return;
  }

  const videoData = await downloadVideoWithAudio(videoItem);

  const result = await uploadAndPollVideo(agent, videoData);
  if (!result) {
    console.log("[bluesky] Falling back to text-only post");
    await agent.post({ text: richText.text, facets: richText.facets });
    return;
  }

  await agent.post({
    text: richText.text,
    facets: richText.facets,
    embed: {
      $type: "app.bsky.embed.video",
      video: result.blobRef,
      alt: post.title,
      presentation,
    },
  });
}

async function postToBluesky(
  agent: Agent,
  post: RedditPost,
  hashtags: string[]
): Promise<void> {
  const text = buildPostText(post, hashtags);

  const richText = new RichText({ text });
  await richText.detectFacets(agent);

  switch (post.mediaType) {
    case "image":
    case "gallery":
      await postWithImages(agent, richText, post);
      break;

    case "video":
      await postWithVideo(agent, richText, post);
      break;

    case "gif":
      await postWithVideo(agent, richText, post, "gif");
      break;

    default:
      await agent.post({
        text: richText.text,
        facets: richText.facets,
      });
      break;
  }
}

async function processSubreddit(
  agent: Agent,
  subreddit: string,
  config: Config
): Promise<void> {
  console.log(`[bluesky] Fetching posts from r/${subreddit}...`);

  const posts = await fetchSubredditPosts(subreddit, {
    limit: 10,
    sort: "new",
    flairBlocklist: config.reddit?.flair_blocklist,
    usersBlacklist: config.reddit?.users_blacklist,
  });

  console.log(`[bluesky] Found ${posts.length} posts from r/${subreddit}`);

  for (const post of posts) {
    const alreadyPosted = await isAlreadyPosted(post.id);
    if (alreadyPosted) {
      continue;
    }

    try {
      console.log(
        `[bluesky] Posting: "${post.title}" (${post.id}) [${post.mediaType}]`
      );
      await postToBluesky(agent, post, config.bluesky?.hashtag_list ?? []);
      await markAsPosted(post.id);
      console.log(`[bluesky] Successfully posted: ${post.id}`);

      // Small delay between posts to avoid rate limiting
      await sleep(2000);
    } catch (error) {
      console.error(`[bluesky] Failed to post ${post.id}:`, error);
    }
  }
}

async function blueskyBot({ config, env }: BlueskyBotDeps) {
  console.log("[bluesky] Bot started with handle:", env.BLUESKY_HANDLE);

  const credSession = createSession();
  let agent = await getAuthenticatedAgent(credSession, env);

  const subreddits = config.reddit?.subreddit_list ?? [];
  if (subreddits.length === 0) {
    console.log("[bluesky] No subreddits configured, exiting bot loop");
    return;
  }

  while (true) {
    try {
      // Re-validate session before each cycle to avoid rate-limit bans
      agent = await ensureAuthenticated(agent, credSession, env);

      for (const subreddit of subreddits) {
        await processSubreddit(agent, subreddit, config);
      }
    } catch (error) {
      console.error("[bluesky] Error in bot loop:", error);
    }
    const delaySeconds = config.bluesky?.delay ?? 300;
    console.log(`[bluesky] Sleeping for ${delaySeconds}s...`);
    await sleep(delaySeconds * 1000);
  }
}

export default blueskyBot;
