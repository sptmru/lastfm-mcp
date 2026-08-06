import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LastFmApi, RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import { HistorySyncService } from "../src/history-sync.js";

const repositories: HistoryRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("HistorySyncService", () => {
  it("backfills pages and marks a complete full history", async () => {
    const repository = createRepository();
    const getRecentTracksPage = vi
      .fn<LastFmApi["getRecentTracksPage"]>()
      .mockResolvedValueOnce({
        tracks: [track("A", 300), track("B", 200)],
        pageInfo: { page: 1, perPage: 2, totalPages: 2, total: 3 },
      })
      .mockResolvedValueOnce({
        tracks: [track("C", 100)],
        pageInfo: { page: 2, perPage: 2, totalPages: 2, total: 3 },
      });
    const api = { getRecentTracksPage } as unknown as LastFmApi;
    const sync = new HistorySyncService(api, repository, "listener", 1_000);

    const result = await sync.sync("full", 1_000);

    expect(result).toMatchObject({ scannedTracks: 3, pagesFetched: 2, completedRequestedRange: true });
    expect(result.status).toMatchObject({ indexedScrobbles: 3, fullHistorySynced: true });
    expect(getRecentTracksPage.mock.calls[0]?.[0]).toMatchObject({ page: 1, limit: 200 });
  });
});

function createRepository(): HistoryRepository {
  const directory = mkdtempSync(join(tmpdir(), "lastfm-mcp-sync-"));
  const repository = new HistoryRepository(join(directory, "history.sqlite"));
  repositories.push(repository);
  return repository;
}

function track(name: string, playedAtUnix: number): RecentTrack {
  return {
    name,
    artist: "Artist",
    album: "Album",
    playedAtUnix,
    playedAt: new Date(playedAtUnix * 1_000).toISOString(),
    nowPlaying: false,
    loved: false,
    mbid: null,
    artistMbid: null,
    albumMbid: null,
    url: "https://last.fm/track",
  };
}
