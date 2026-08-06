import type { LastFmApi, RecentTrack } from "./domain.js";
import { HistoryRepository } from "./history-repository.js";

export type SyncMode = "incremental" | "full";

export type SyncResult = {
  mode: SyncMode;
  startedAt: string;
  finishedAt: string;
  requestedMaxTracks: number;
  scannedTracks: number;
  storedRowsChanged: number;
  pagesFetched: number;
  totalReportedByLastFm: number;
  completedRequestedRange: boolean;
  status: ReturnType<HistoryRepository["getStatus"]>;
};

export class HistorySyncService {
  private activeSync: Promise<SyncResult> | null = null;

  constructor(
    private readonly api: LastFmApi,
    private readonly repository: HistoryRepository,
    private readonly username: string,
    private readonly maxAllowedTracks: number,
  ) {}

  sync(mode: SyncMode, requestedMaxTracks: number): Promise<SyncResult> {
    if (this.activeSync) return this.activeSync;
    const maxTracks = Math.min(requestedMaxTracks, this.maxAllowedTracks);
    this.activeSync = this.run(mode, maxTracks).finally(() => {
      this.activeSync = null;
    });
    return this.activeSync;
  }

  isRunning(): boolean {
    return this.activeSync !== null;
  }

  private async run(mode: SyncMode, maxTracks: number): Promise<SyncResult> {
    const startedAtMs = Date.now();
    const startedAtUnix = Math.floor(startedAtMs / 1_000);
    const before = this.repository.getStatus(this.username);
    const newestUnix = before.newestScrobbleAt ? Math.floor(Date.parse(before.newestScrobbleAt) / 1_000) : undefined;
    // Re-read the newest second inclusively so a late scrobble with the same
    // timestamp cannot be missed; the SQLite primary key makes this idempotent.
    const from = mode === "incremental" && newestUnix !== undefined ? newestUnix : undefined;

    let page = 1;
    let scannedTracks = 0;
    let storedRowsChanged = 0;
    let pagesFetched = 0;
    let totalReportedByLastFm = 0;
    let completedRequestedRange = false;

    while (scannedTracks < maxTracks) {
      const response = await this.api.getRecentTracksPage({
        ...(from === undefined ? {} : { from }),
        to: startedAtUnix,
        page,
        limit: 200,
      });
      pagesFetched += 1;
      if (page === 1) totalReportedByLastFm = response.pageInfo.total;

      const historical = response.tracks.filter(isHistorical);
      const remaining = maxTracks - scannedTracks;
      const selected = historical.slice(0, remaining);
      scannedTracks += selected.length;
      storedRowsChanged += this.repository.upsertTracks(this.username, selected);

      if (
        historical.length === 0 ||
        response.pageInfo.totalPages === 0 ||
        page >= response.pageInfo.totalPages ||
        response.tracks.length < response.pageInfo.perPage
      ) {
        completedRequestedRange = true;
        break;
      }
      if (selected.length < historical.length || scannedTracks >= maxTracks) break;
      page += 1;
    }

    const completedFullHistory = mode === "full" && completedRequestedRange;
    this.repository.markSync(this.username, mode, completedFullHistory, Math.floor(Date.now() / 1_000));
    return {
      mode,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      requestedMaxTracks: maxTracks,
      scannedTracks,
      storedRowsChanged,
      pagesFetched,
      totalReportedByLastFm,
      completedRequestedRange,
      status: this.repository.getStatus(this.username),
    };
  }
}

function isHistorical(track: RecentTrack): boolean {
  return !track.nowPlaying && track.playedAtUnix !== null;
}
