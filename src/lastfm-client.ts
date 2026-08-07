import type {
  AlbumPlay,
  ArtistContext,
  ArtistPlay,
  LastFmApi,
  LastFmPeriod,
  LovedTrack,
  PageInfo,
  RecentTrack,
  RecentTracksPage,
  TrackPlay,
  UserProfile,
} from "./domain.js";
import { toIso } from "./time.js";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

export type LastFmClientOptions = {
  apiKey: string;
  username: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  minRequestIntervalMs: number;
  cacheTtlMs: number;
  fetchImpl?: FetchLike;
};

export class LastFmApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number | null,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = "LastFmApiError";
  }
}

export class LastFmClient implements LastFmApi {
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: LastFmClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getUserInfo(): Promise<UserProfile> {
    const response = await this.call("user.getInfo", {});
    const user = record(response.user);
    const registered = record(user.registered);
    return {
      username: text(user.name) || this.options.username,
      realName: nullableText(user.realname),
      country: nullableText(user.country),
      profileUrl: text(user.url),
      registeredAt: toIso(integer(registered.unixtime)),
      totalScrobbles: integer(user.playcount) ?? 0,
      artistCount: integer(user.artist_count),
      albumCount: integer(user.album_count),
      trackCount: integer(user.track_count),
    };
  }

  async getTopArtists(period: LastFmPeriod, limit: number): Promise<ArtistPlay[]> {
    const response = await this.call("user.getTopArtists", { period, limit });
    const container = record(response.topartists);
    return array(container.artist).map((value, index) => {
      const artist = record(value);
      return {
        rank: rankOf(artist, index),
        name: text(artist.name),
        playcount: integer(artist.playcount) ?? 0,
        mbid: nullableText(artist.mbid),
        url: text(artist.url),
      };
    });
  }

  async getTopTracks(period: LastFmPeriod, limit: number): Promise<TrackPlay[]> {
    const response = await this.call("user.getTopTracks", { period, limit });
    const container = record(response.toptracks);
    return array(container.track).map((value, index) => {
      const track = record(value);
      const artist = record(track.artist);
      return {
        rank: rankOf(track, index),
        name: text(track.name),
        artist: text(artist.name),
        playcount: integer(track.playcount) ?? 0,
        mbid: nullableText(track.mbid),
        artistMbid: nullableText(artist.mbid),
        url: text(track.url),
      };
    });
  }

  async getTopAlbums(period: LastFmPeriod, limit: number): Promise<AlbumPlay[]> {
    const response = await this.call("user.getTopAlbums", { period, limit });
    const container = record(response.topalbums);
    return array(container.album).map((value, index) => {
      const album = record(value);
      const artist = record(album.artist);
      return {
        rank: rankOf(album, index),
        name: text(album.name),
        artist: text(artist.name),
        playcount: integer(album.playcount) ?? 0,
        mbid: nullableText(album.mbid),
        artistMbid: nullableText(artist.mbid),
        url: text(album.url),
      };
    });
  }

  async getLovedTracks(limit: number): Promise<LovedTrack[]> {
    const response = await this.call("user.getLovedTracks", { limit });
    const container = record(response.lovedtracks);
    return array(container.track).map((value) => {
      const track = record(value);
      const artist = record(track.artist);
      const date = record(track.date);
      return {
        name: text(track.name),
        artist: text(artist.name),
        mbid: nullableText(track.mbid),
        artistMbid: nullableText(artist.mbid),
        url: text(track.url),
        lovedAt: toIso(integer(date.uts)),
      };
    });
  }

  async getRecentTracksPage(input: {
    from?: number;
    to?: number;
    page?: number;
    limit?: number;
  }): Promise<RecentTracksPage> {
    const response = await this.call("user.getRecentTracks", {
      extended: 1,
      from: input.from,
      to: input.to,
      page: input.page ?? 1,
      limit: Math.min(input.limit ?? 200, 200),
    }, false);
    const container = record(response.recenttracks);
    const pageInfo = parsePageInfo(record(container["@attr"]));
    return {
      tracks: array(container.track).map(normalizeRecentTrack),
      pageInfo,
    };
  }

  async getArtistContext(artistName: string, autocorrect: boolean): Promise<ArtistContext> {
    const response = await this.call("artist.getInfo", {
      artist: artistName,
      autocorrect: autocorrect ? 1 : 0,
      username: this.options.username,
    });
    const artist = record(response.artist);
    const stats = record(artist.stats);
    const tags = record(artist.tags);
    const similar = record(artist.similar);
    const bio = record(artist.bio);
    return {
      name: text(artist.name),
      mbid: nullableText(artist.mbid),
      url: text(artist.url),
      listeners: integer(stats.listeners),
      playcount: integer(stats.playcount),
      userPlaycount: integer(stats.userplaycount),
      tags: array(tags.tag).map((item) => text(record(item).name)).filter(Boolean),
      similarArtists: array(similar.artist).slice(0, 20).map((item) => {
        const value = record(item);
        return {
          name: text(value.name),
          url: text(value.url),
          match: decimal(value.match),
        };
      }),
      bioSummary: nullableText(stripHtml(text(bio.summary))),
    };
  }

  async getArtistTopTracks(artistName: string, limit: number, autocorrect = true): Promise<TrackPlay[]> {
    const response = await this.call("artist.getTopTracks", {
      artist: artistName,
      autocorrect: autocorrect ? 1 : 0,
      limit: Math.min(limit, 1_000),
    });
    const container = record(response.toptracks);
    return array(container.track).map((value, index) => {
      const track = record(value);
      const artist = record(track.artist);
      return {
        rank: rankOf(track, index),
        name: text(track.name),
        artist: text(artist.name) || artistName,
        playcount: integer(track.playcount) ?? 0,
        mbid: nullableText(track.mbid),
        artistMbid: nullableText(artist.mbid),
        url: text(track.url),
      };
    });
  }

  async getArtistTopAlbums(artistName: string, limit: number, autocorrect = true): Promise<AlbumPlay[]> {
    const response = await this.call("artist.getTopAlbums", {
      artist: artistName,
      autocorrect: autocorrect ? 1 : 0,
      limit: Math.min(limit, 1_000),
    });
    const container = record(response.topalbums);
    return array(container.album).map((value, index) => {
      const album = record(value);
      const artist = record(album.artist);
      return {
        rank: rankOf(album, index),
        name: text(album.name),
        artist: text(artist.name) || artistName,
        playcount: integer(album.playcount) ?? 0,
        mbid: nullableText(album.mbid),
        artistMbid: nullableText(artist.mbid),
        url: text(album.url),
      };
    });
  }

  private async call(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
    cacheable = true,
  ): Promise<JsonRecord> {
    const url = new URL(this.options.baseUrl);
    const searchParams = new URLSearchParams({
      method,
      api_key: this.options.apiKey,
      user: this.options.username,
      format: "json",
    });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value));
    }
    url.search = searchParams.toString();

    const cacheKey = redactApiKey(url).toString();
    const cached = this.cache.get(cacheKey);
    if (cacheable && cached && cached.expiresAt > Date.now()) {
      return cached.value as JsonRecord;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        await this.waitForRateLimit();
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": "lastfm-mcp/0.3.0" },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        const body = await parseJsonResponse(response);
        const apiCode = integer(body.error);
        if (!response.ok || apiCode !== null) {
          const retriable = response.status === 429 || response.status >= 500 || [11, 16, 29].includes(apiCode ?? -1);
          throw new LastFmApiError(
            text(body.message) || `Last.fm returned HTTP ${response.status}`,
            apiCode,
            response.status,
            retriable,
          );
        }
        if (cacheable && this.options.cacheTtlMs > 0) {
          this.cache.set(cacheKey, { expiresAt: Date.now() + this.options.cacheTtlMs, value: body });
        }
        return body;
      } catch (error) {
        lastError = error;
        const retriable = error instanceof LastFmApiError ? error.retriable : isNetworkError(error);
        if (!retriable || attempt >= this.options.maxRetries) break;
        await delay(Math.min(5_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 200));
      }
    }

    if (lastError instanceof LastFmApiError) throw lastError;
    const message = lastError instanceof Error ? lastError.message : "Unknown Last.fm request error";
    throw new LastFmApiError(`Last.fm request failed: ${message}`, null, null, false);
  }

  private async waitForRateLimit(): Promise<void> {
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.lastRequestAt + this.options.minRequestIntervalMs - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.lastRequestAt = Date.now();
    } finally {
      release();
    }
  }
}

async function parseJsonResponse(response: Response): Promise<JsonRecord> {
  const raw = await response.text();
  try {
    return record(JSON.parse(raw));
  } catch {
    throw new LastFmApiError(
      `Last.fm returned a non-JSON response (HTTP ${response.status})`,
      null,
      response.status,
      response.status >= 500,
    );
  }
}

function normalizeRecentTrack(value: unknown): RecentTrack {
  const track = record(value);
  const artist = record(track.artist);
  const album = record(track.album);
  const date = record(track.date);
  const attributes = record(track["@attr"]);
  const playedAtUnix = integer(date.uts);
  return {
    name: text(track.name),
    artist: text(artist.name) || text(artist["#text"]),
    album: nullableText(album.name) ?? nullableText(album["#text"]),
    mbid: nullableText(track.mbid),
    artistMbid: nullableText(artist.mbid),
    albumMbid: nullableText(album.mbid),
    url: text(track.url),
    loved: text(track.loved) === "1",
    nowPlaying: text(attributes.nowplaying).toLowerCase() === "true",
    playedAt: toIso(playedAtUnix),
    playedAtUnix,
  };
}

function parsePageInfo(attributes: JsonRecord): PageInfo {
  return {
    page: integer(attributes.page) ?? 1,
    perPage: integer(attributes.perPage) ?? 0,
    totalPages: integer(attributes.totalPages) ?? 0,
    total: integer(attributes.total) ?? 0,
  };
}

function rankOf(value: JsonRecord, index: number): number {
  return integer(record(value["@attr"]).rank) ?? index + 1;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText === "" ? null : valueText;
}

function integer(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.parseInt(text(value), 10);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function decimal(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(number) ? number : null;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}

function redactApiKey(url: URL): URL {
  const redacted = new URL(url);
  redacted.searchParams.set("api_key", "[redacted]");
  return redacted;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
