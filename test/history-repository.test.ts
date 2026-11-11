import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";

const repositories: HistoryRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("HistoryRepository", () => {
  it("adds persistent incremental progress to an existing database without losing sync state", () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-mcp-migration-"));
    const path = join(directory, "history.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sync_state (
        username TEXT PRIMARY KEY,
        full_history_synced INTEGER NOT NULL DEFAULT 0,
        last_sync_at_unix INTEGER,
        last_sync_mode TEXT,
        coverage_through_unix INTEGER,
        full_sync_cursor_unix INTEGER,
        full_sync_upper_unix INTEGER
      );
      INSERT INTO sync_state VALUES ('listener', 1, 100, 'full', 100, NULL, NULL);
    `);
    legacy.close();
    const repository = new HistoryRepository(path);
    repositories.push(repository);
    expect(repository.getStatus("listener")).toMatchObject({ fullHistorySynced: true,
      coveredThroughAt: new Date(100 * 1000).toISOString(), incrementalSyncInProgress: false });
    const progress = { cursorUnix: 90, upperUnix: 200, boundaryKeys: ['["artist","album","track"]'] };
    repository.setIncrementalSyncProgress("listener", progress);
    expect(repository.getIncrementalSyncProgress("other-listener")).toBeNull();

    // Open a second connection to verify persisted state and idempotent migration.
    const reopened = new HistoryRepository(path);
    repositories.push(reopened);
    expect(reopened.getIncrementalSyncProgress("listener")).toEqual(progress);
    expect(reopened.getStatus("listener").incrementalSyncInProgress).toBe(true);
    reopened.clearIncrementalSyncProgress("listener");
    expect(repository.getIncrementalSyncProgress("listener")).toBeNull();
    expect(repository.getStatus("listener")).toMatchObject({ fullHistorySynced: true,
      coveredThroughAt: new Date(100 * 1000).toISOString(), incrementalSyncInProgress: false });
  });

  it("deduplicates, searches, aggregates, and tracks sync coverage", () => {
    const repository = createRepository();
    const tracks = [
      scrobble("Invent Animate", "Heavener", "Shade Astray", 1_722_470_400),
      scrobble("Invent Animate", "Heavener", "Without a Whisper", 1_722_470_500),
      scrobble("ERRA", "Cure", "Cure", 1_722_470_600),
    ];

    expect(repository.upsertTracks("listener", tracks)).toBe(3);
    expect(repository.upsertTracks("listener", tracks)).toBe(3); // UPSERT reports touched rows; PK still prevents duplicates.
    repository.markSync("listener", "full", true, 1_722_470_700);

    const result = repository.search("listener", {
      artist: "invent",
      exactMatch: false,
      limit: 10,
    });
    expect(result.matched).toBe(2);
    expect(result.tracks.map((track) => track.name)).toEqual(["Without a Whisper", "Shade Astray"]);
    expect(result.status).toMatchObject({ indexedScrobbles: 3, fullHistorySynced: true });

    const aggregate = repository.aggregate("listener", 1_722_470_000, 1_722_471_000);
    expect(aggregate).toMatchObject({ total: 3, uniqueArtists: 2, uniqueAlbums: 2, uniqueTracks: 3, tracksWithAlbum: 3 });
  });

  it("finds exact first-listen discoveries only after history is indexed", () => {
    const repository = createRepository();
    repository.upsertTracks("listener", [
      scrobble("Old Artist", "A", "One", 100),
      scrobble("New Artist", "B", "Two", 1_000),
      scrobble("New Artist", "B", "Three", 1_100),
    ]);
    expect(repository.recentDiscoveries("listener", 500)).toEqual([
      { artist: "New Artist", firstPlayedAt: "1970-01-01T00:16:40.000Z", playsSince: 2 },
    ]);
  });
});

function createRepository(): HistoryRepository {
  const directory = mkdtempSync(join(tmpdir(), "lastfm-mcp-test-"));
  const repository = new HistoryRepository(join(directory, "history.sqlite"));
  repositories.push(repository);
  return repository;
}

function scrobble(artist: string, album: string, name: string, playedAtUnix: number): RecentTrack {
  return {
    artist,
    album,
    name,
    playedAtUnix,
    playedAt: new Date(playedAtUnix * 1_000).toISOString(),
    nowPlaying: false,
    loved: false,
    mbid: null,
    artistMbid: null,
    albumMbid: null,
    url: `https://last.fm/${encodeURIComponent(name)}`,
  };
}
