const USER_AGENT = "rbxbot/1.0 (Bun; +https://github.com/rbxbot)";
const REDDIT_BASE_URL = "https://www.reddit.com";

type MediaType = "image" | "video" | "gallery" | "gif" | "none";

interface MediaItem {
  url: string;
  mimeType?: string;
  audioUrl?: string;
}

export interface RedditPost {
  id: string;
  title: string;
  author: string;
  permalink: string;
  url: string;
  flair: string | null;
  subreddit: string;
  mediaType: MediaType;
  mediaItems: MediaItem[];
  videoDurationSeconds: number | null;
}

interface RedditVideoData {
  fallback_url: string;
  duration: number;
  width: number;
  height: number;
}

interface GalleryMediaMetadata {
  [mediaId: string]: {
    status: string;
    e: string; // "Image" | "AnimatedImage"
    m: string; // mime type e.g. "image/jpg"
    s: {
      u?: string;
      mp4?: string;
      gif?: string;
      x: number;
      y: number;
    };
  };
}

interface GalleryItem {
  media_id: string;
}

interface RedditListingChild {
  kind: string;
  data: {
    id: string;
    title: string;
    author: string;
    permalink: string;
    url: string;
    link_flair_text: string | null;
    post_hint?: string;
    is_video: boolean;
    is_gallery?: boolean;
    stickied: boolean;
    over_18: boolean;
    subreddit: string;
    media?: {
      reddit_video?: RedditVideoData;
    };
    media_metadata?: GalleryMediaMetadata;
    gallery_data?: {
      items: GalleryItem[];
    };
    preview?: {
      images: Array<{
        source: { url: string; width: number; height: number };
        variants?: {
          mp4?: {
            source: { url: string; width: number; height: number };
          };
          gif?: {
            source: { url: string; width: number; height: number };
          };
        };
      }>;
    };
  };
}

interface RedditListing {
  kind: string;
  data: {
    children: RedditListingChild[];
    after: string | null;
  };
}

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp)$/i;
const VIDEO_EXTENSIONS = /\.(mp4)$/i;
const MAX_GALLERY_ITEMS = 4;
const MAX_VIDEO_DURATION_SECONDS = 60; // Skip videos longer than 60s
const API_TIMEOUT_MS = 15_000; // 15s for Reddit API
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000; // 60s for media downloads

function decodeHtmlEntities(url: string): string {
  return url.replaceAll("&amp;", "&");
}

interface ExtractedMedia {
  mediaType: MediaType;
  mediaItems: MediaItem[];
  videoDurationSeconds: number | null;
}

const NO_MEDIA: ExtractedMedia = {
  mediaType: "none",
  mediaItems: [],
  videoDurationSeconds: null,
};

function buildAudioUrl(fallbackUrl: string): string | undefined {
  try {
    const url = new URL(fallbackUrl);
    // fallback_url is like https://v.redd.it/{id}/DASH_720.mp4?source=fallback
    // Audio is at https://v.redd.it/{id}/DASH_AUDIO_128.mp4
    const pathParts = url.pathname.split("/");
    pathParts[pathParts.length - 1] = "DASH_AUDIO_128.mp4";
    url.pathname = pathParts.join("/");
    url.search = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function extractVideoMedia(
  data: RedditListingChild["data"]
): ExtractedMedia | null {
  if (!(data.is_video && data.media?.reddit_video)) {
    return null;
  }
  const { fallback_url, duration } = data.media.reddit_video;
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    return { ...NO_MEDIA, videoDurationSeconds: duration };
  }
  const audioUrl = buildAudioUrl(fallback_url);
  return {
    mediaType: "video",
    mediaItems: [{ url: fallback_url, mimeType: "video/mp4", audioUrl }],
    videoDurationSeconds: duration,
  };
}

function extractGalleryMedia(
  data: RedditListingChild["data"]
): ExtractedMedia | null {
  if (!(data.is_gallery && data.media_metadata && data.gallery_data?.items)) {
    return null;
  }
  const items: MediaItem[] = [];
  for (const galleryItem of data.gallery_data.items.slice(
    0,
    MAX_GALLERY_ITEMS
  )) {
    const meta = data.media_metadata[galleryItem.media_id];
    if (!meta || meta.status !== "valid") {
      continue;
    }
    const imageUrl = meta.s.u;
    if (imageUrl) {
      items.push({ url: decodeHtmlEntities(imageUrl), mimeType: meta.m });
    }
  }
  if (items.length > 0) {
    return {
      mediaType: "gallery",
      mediaItems: items,
      videoDurationSeconds: null,
    };
  }
  return null;
}

function extractDirectMedia(data: RedditListingChild["data"]): ExtractedMedia {
  // GIF from preview variants
  if (data.preview?.images?.[0]?.variants?.mp4?.source?.url) {
    const gifMp4Url = decodeHtmlEntities(
      data.preview.images[0].variants.mp4.source.url
    );
    return {
      mediaType: "gif",
      mediaItems: [{ url: gifMp4Url, mimeType: "video/mp4" }],
      videoDurationSeconds: null,
    };
  }

  // Direct image URL
  if (IMAGE_EXTENSIONS.test(data.url)) {
    return {
      mediaType: "image",
      mediaItems: [{ url: data.url }],
      videoDurationSeconds: null,
    };
  }

  // Direct video URL (e.g. .mp4 link)
  if (VIDEO_EXTENSIONS.test(data.url)) {
    return {
      mediaType: "video",
      mediaItems: [{ url: data.url, mimeType: "video/mp4" }],
      videoDurationSeconds: null,
    };
  }

  // Reddit-hosted image via preview
  if (data.preview?.images?.[0]?.source?.url) {
    return {
      mediaType: "image",
      mediaItems: [
        { url: decodeHtmlEntities(data.preview.images[0].source.url) },
      ],
      videoDurationSeconds: null,
    };
  }

  return NO_MEDIA;
}

function extractMedia(child: RedditListingChild): ExtractedMedia {
  const { data } = child;

  return (
    extractVideoMedia(data) ??
    extractGalleryMedia(data) ??
    extractDirectMedia(data)
  );
}

export async function fetchSubredditPosts(
  subreddit: string,
  options: {
    limit?: number;
    sort?: "new" | "hot" | "top" | "rising";
    flairBlocklist?: string[];
    usersBlacklist?: string[];
  } = {}
): Promise<RedditPost[]> {
  const { limit = 10, sort = "new", flairBlocklist, usersBlacklist } = options;

  const url = `${REDDIT_BASE_URL}/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${limit}&raw_json=1`;

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Reddit API error: ${response.status} ${response.statusText}`
    );
  }

  const listing = (await response.json()) as RedditListing;

  const posts: RedditPost[] = [];

  for (const child of listing.data.children) {
    const { data } = child;

    // Skip stickied/pinned posts
    if (data.stickied) {
      continue;
    }

    // Skip NSFW
    if (data.over_18) {
      continue;
    }

    // Skip blacklisted users
    if (usersBlacklist?.includes(data.author)) {
      continue;
    }

    // Skip posts matching blocked flairs
    if (flairBlocklist && flairBlocklist.length > 0) {
      const postFlair = data.link_flair_text?.toLowerCase() ?? "";
      const isBlockedFlair = flairBlocklist.some((f) =>
        postFlair.includes(f.toLowerCase())
      );
      if (isBlockedFlair) {
        continue;
      }
    }

    const { mediaType, mediaItems, videoDurationSeconds } = extractMedia(child);

    posts.push({
      id: data.id,
      title: data.title,
      author: data.author,
      permalink: `${REDDIT_BASE_URL}${data.permalink}`,
      url: data.url,
      flair: data.link_flair_text,
      subreddit: data.subreddit,
      mediaType,
      mediaItems,
      videoDurationSeconds,
    });
  }

  return posts;
}

const ALLOWED_MEDIA_HOSTS = new Set([
  "i.redd.it",
  "preview.redd.it",
  "i.imgur.com",
  "imgur.com",
  "v.redd.it",
]);

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB (Bluesky limit)

function isAllowedMediaHost(mediaUrl: string): boolean {
  try {
    const { hostname } = new URL(mediaUrl);
    return ALLOWED_MEDIA_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export async function downloadMedia(
  mediaUrl: string,
  maxSizeBytes: number = MAX_IMAGE_SIZE_BYTES
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (!isAllowedMediaHost(mediaUrl)) {
    throw new Error(`Blocked media download from untrusted host: ${mediaUrl}`);
  }

  const response = await fetch(mediaUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download media: ${response.status} ${response.statusText}`
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxSizeBytes) {
    throw new Error(
      `Media too large: ${contentLength} bytes (max ${maxSizeBytes})`
    );
  }

  const mimeType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > maxSizeBytes) {
    throw new Error(
      `Media too large: ${buffer.byteLength} bytes (max ${maxSizeBytes})`
    );
  }

  return { data: new Uint8Array(buffer), mimeType };
}

export { MAX_VIDEO_SIZE_BYTES };
