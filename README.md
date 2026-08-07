# Last.fm Taste MCP

A personal Last.fm MCP server built with Node.js and TypeScript. It uses stateless Streamable HTTP, maintains a canonical local listening index, combines Last.fm with MusicBrainz metadata, records explicit preferences, and produces evidence-backed taste analytics and recommendations.

The server uses only read-only Last.fm and MusicBrainz methods. API credentials stay inside the container and are never returned through MCP. Feedback, exclusions, and recommendation events are written only to the local SQLite database.

## Features

| MCP tool | Purpose |
| --- | --- |
| `get_user_profile` | Public profile, total play count, and library size |
| `get_listening_summary` | Compact summary for `overall`, `12month`, `6month`, `3month`, `1month`, or `7day` |
| `get_top_artists` | Top artists for a period |
| `get_top_tracks` | Top tracks for a period |
| `get_top_albums` | Top albums for a period |
| `get_recent_tracks` | Recent scrobbles with optional time filtering |
| `search_listening_history` | Artist, album, or track search using the local index or a bounded live scan |
| `get_history_status` | SQLite index coverage and freshness |
| `sync_listening_history` | Full history backfill or incremental sync |
| `compare_listening_periods` | Artist and track share changes between two periods |
| `get_taste_profile` | Core artists, favorite tracks and albums, discoveries, forgotten favorites, and listening patterns |
| `get_artist_context` | Tags, similar artists, play counts, and a short biography context |
| `resolve_canonical_entities` | Canonical artist/album/track identities, aliases, and known MBIDs |
| `check_listening_exposure` | Fast unheard/sample/explored/established/favorite checks |
| `get_artist_affinity` | Active days/months, sessions, returns, concentration, and explainable affinity |
| `get_listening_sessions` | Session grouping with configurable inactivity gap |
| `get_album_exposure` | Track coverage, ordered runs, stopping points, and returns using MusicBrainz tracklists |
| `get_listening_timeline` | Arbitrary UTC ranges and day/week/month/year buckets by artist, album, or tag |
| `get_listening_matrix` | Pageable sparse time-bucket × artist/album matrix with global window totals, active days, concentration, and explicit coverage |
| `detect_listening_eras` | Statistical change points in monthly listening distributions |
| `get_artist_features` | Combined Last.fm tags/similarity and MusicBrainz metadata/relationships |
| `build_taste_graph` | Artists, albums, tags, sessions, eras, external similarity, and preference edges |
| `record_music_feedback` | Structured love/like/mixed/boring/dislike/not-now feedback |
| `record_preference_signal` | Explicit -5..5 signals for atmosphere, groove, melody, structure, vocals, and more |
| `get_feedback_context` | Feedback, dimension summaries, and active exclusions |
| `get_recommendations` | Safe, bridge, or explore recommendations with evidence, risks, and starting points |
| `exclude_recommendation` | Permanent, six-month, or new-releases-only artist exclusion |
| `list_recommendation_exclusions` | Active recommendation exclusions |
| `record_recommendation` | Store an externally issued recommendation and its exposure baseline |
| `evaluate_recommendations` | Measure post-recommendation sampling, engagement, and later returns |

Informational tools are marked read-only. `sync_listening_history`, feedback/preference recording, exclusions, and recommendation recording are explicitly annotated as local writes. `get_recommendations` also records every emitted recommendation so it can be evaluated later.

## 1. Get a Last.fm API key

1. Sign in to your Last.fm account.
2. Open [Last.fm Create API account](https://www.last.fm/api/account/create).
3. Enter an application name and description. This server does not require a callback URL.
4. Copy the **API key**.
5. Get your username from your profile URL: `https://www.last.fm/user/<username>`.

Last.fm also displays a shared secret, but this server does not need it. `user.getInfo`, `user.getTop*`, `user.getRecentTracks`, `user.getLovedTracks`, and `artist.getInfo` do not require a user session. Do not add the shared secret to `.env`.

MusicBrainz does not require an API key. It does require a meaningful `User-Agent`; set `MUSICBRAINZ_USER_AGENT` to an application name/version plus your public URL or email. The client serializes calls and defaults to one request every 1.1 seconds.

## 2. Configure and run with Docker Compose

```bash
cp .env.example .env
```

At minimum, set:

```dotenv
LASTFM_API_KEY=your-api-key
LASTFM_USERNAME=your-lastfm-username
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
MCP_ENABLE_MUTATIONS=false
MUSICBRAINZ_USER_AGENT=lastfm-mcp/0.3.0 (https://your-domain.example/)
```

Start the service:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
```

MCP endpoint: `http://127.0.0.1:3000/mcp`.

Test protocol and tool discovery:

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response may be JSON or an SSE `event: message`; both are valid Streamable HTTP MCP responses.

## 3. Index your listening history once

Summary, top-chart, recent-track, and taste tools work immediately without an index. However, Last.fm does not provide server-side listening-history search by artist, album, or track. Exact search and reliable `recentDiscoveries` therefore require a full backfill:

```bash
docker compose exec lastfm-mcp node dist/src/sync.js full 250000
```

Afterward, periodically fetch new scrobbles:

```bash
docker compose exec lastfm-mcp node dist/src/sync.js incremental 10000
```

You can also invoke the MCP tool `sync_listening_history` (when `MCP_ENABLE_MUTATIONS=true`) and inspect progress with `get_history_status`. The container CLI remains available regardless of that MCP safety flag.

If a full sync reaches `HISTORY_MAX_SYNC_TRACKS`, call it again. The server persists the oldest backfill cursor and resumes from it; it does not redownload the same newest slice. Incremental syncs with a capped backlog advance oldest-first so no middle segment is skipped. `coveredThroughAt` advances only after the requested range is complete.

The index is stored in the `lastfm-data` named volume as normalized SQLite data rather than raw Last.fm responses. Intelligence tools lazily backfill canonical entity keys and alias catalogs after each sync, so an existing v0.1 database is migrated in place.

The full sync is foundational: without it, first-listen dates, long-term returns, eras, exposure filtering, and recommendation evaluation can be incomplete. Every affected response includes the current history status and a caveat when `fullHistorySynced=false`.

### Exact window and era analysis

`get_listening_matrix` is the raw statistical surface for custom era analysis. It selects artist or album columns using totals across the complete requested window—not a separate top list inside each bucket—and returns a compact sparse coordinate matrix:

- `buckets` contains UTC boundaries, total plays, active days, selected plays, and omitted plays;
- `entities` contains whole-window totals, active days/buckets, first and last play, peak bucket/day concentration, active span, and bucket density;
- `matrix.cells` uses `[bucketIndex, entityIndex, plays, activeDays]`; a missing cell means zero plays;
- `filtering` reports exact play coverage, page position, and every omission caused by `minPlays` or entity pagination.

The default `bucket=month`, `dimension=artist`, and `minPlays=1` starts an exact month × artist matrix in globally ranked pages of 250 entities. No per-month top-N truncation is applied. Re-call the tool with `entityOffset=filtering.nextEntityOffset` until that value is `null`; entity `rank` remains global while `index` addresses the current page's matrix cells. Increase `limitEntities` up to 5,000 when the client can accept a larger response. The ordinary text result stays compact while the complete page is returned in `structuredContent`, preserving ChatGPT context. If a sparse page exceeds `maxCells`, the call fails with narrowing options instead of silently dropping evidence. `activeDays`, `maxDayShare`, and `bucketDensity` help distinguish a one-evening spike from gradual discovery and recurring affinity.

Last.fm can expose imported or undated records with placeholder Unix timestamps near the 1970 epoch. The matrix and era detector keep those rows in the local history but exclude timestamps before `2002-01-01T00:00:00Z` from temporal evidence. Responses expose `minimumTimestamp` and `excludedBeforeMinimumTimestamp`, so this cleanup is explicit rather than silently rewriting dates or deleting plays.

## 4. Make the endpoint reachable by ChatGPT

ChatGPT cannot connect directly to `localhost`; it needs a remote HTTPS endpoint. The recommended setup is to keep the Compose port bound to `127.0.0.1` and run a reverse proxy such as Caddy on the same server:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Add the public hostname to `.env` without a scheme or port:

```dotenv
MCP_ALLOWED_HOSTS=mcp.example.com,localhost,127.0.0.1
```

Apply the change and verify HTTPS:

```bash
docker compose up -d --build
curl https://mcp.example.com/healthz
```

If the server remains on a private network or local machine, use [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) instead of exposing an arbitrary public port.

## 5. Connect it to ChatGPT

Current flow in ChatGPT web:

1. Enable Developer mode under `Settings → Apps → Advanced Settings`. A workspace admin or owner may need to allow it first.
2. Open `Settings → Apps → Create`.
3. Enter a name such as `My Last.fm` and the endpoint `https://mcp.example.com/mcp`. For this deployment, use `https://lastfm.mcp.sptm.online/mcp`.
4. Select **No authentication** only for a read-only deployment or an endpoint already protected by a private tunnel. Use an OAuth 2.1 gateway before enabling mutations on a public hostname.
5. Click **Scan Tools**, wait for all 30 tools to appear, and create the app. If the app was created against an older version, rescan or recreate it so ChatGPT discovers the new tools.
6. Enable the app from the tools menu in a new chat.

Example first prompt:

> Call get_history_status first. If fullHistorySynced=true, build a detailed music taste profile with get_taste_profile and compare_listening_periods for 12month versus 3month. Separate facts from interpretations.

Recommendation-oriented prompt:

> Check my exposure and explicit feedback first. Then call get_recommendations in bridge mode, exclude anything above sampled exposure, explain each evidence path and risk, and give me one album plus three tracks to start with.

Deep-history prompt:

> Call get_listening_matrix for my complete history with bucket=month, dimension=artist, and minPlays=1. Continue through entityOffset pages until filtering.nextEntityOffset is null. Combine columns by entity rank/key, then use the sparse matrix, active-day evidence, and normalized monthly shares to calculate change points, identify artists shared by adjacent eras, and distinguish one-evening spikes from gradual discoveries. Report aggregate coverage before interpreting the result, then compare your boundaries with detect_listening_eras.

Developer mode and custom MCP app availability depend on your plan and workspace settings. See the [official ChatGPT instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) for current details.

### Authentication and mutation safety

ChatGPT custom apps should not rely on an arbitrary user-supplied API key or header. `LASTFM_API_KEY` remains server-side, but it is not client authentication.

`MCP_ENABLE_MUTATIONS=false` is the safe default. The server still advertises all tools, but sync, feedback, preference, exclusion, recommendation generation/recording, and private feedback/recommendation reads reject calls; the taste graph omits explicit preference edges. Enable them only behind trusted access control such as a private Secure MCP Tunnel or OAuth 2.1 gateway. A public no-auth endpoint with mutations enabled lets any caller read or alter your local preference database and trigger expensive syncs. Query-string tokens are intentionally unsupported because URLs are commonly recorded in logs and browser history.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LASTFM_API_KEY` | required | Last.fm API key |
| `LASTFM_USERNAME` | required | Fixed user whose data is exposed by the MCP server |
| `LASTFM_API_BASE_URL` | official endpoint | Primarily useful for tests |
| `MCP_HOST` | `0.0.0.0` | Bind address inside the container |
| `MCP_PORT` | `3000` | Port inside the container |
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Host address used to publish the Compose port |
| `MCP_PUBLIC_PORT` | `3000` | Published host port |
| `MCP_ALLOWED_HOSTS` | required for `0.0.0.0` | Host and Origin allowlist for DNS rebinding protection |
| `MCP_ENABLE_MUTATIONS` | `false` | Enable sync, feedback, exclusions, and recommendation recording only behind trusted access control |
| `LASTFM_TIMEOUT_MS` | `10000` | Timeout for one API request |
| `LASTFM_MAX_RETRIES` | `3` | Retry count for temporary and rate-limit errors |
| `LASTFM_MIN_REQUEST_INTERVAL_MS` | `250` | Minimum delay between Last.fm requests, approximately four requests per second |
| `LASTFM_CACHE_TTL_SECONDS` | `300` | In-memory cache duration for chart and info calls |
| `MUSICBRAINZ_BASE_URL` | official WS/2 endpoint | Primarily useful for tests |
| `MUSICBRAINZ_USER_AGENT` | project URL | Required MusicBrainz application identity/contact |
| `MUSICBRAINZ_TIMEOUT_MS` | `10000` | Timeout for one MusicBrainz request |
| `MUSICBRAINZ_MAX_RETRIES` | `2` | Retry count for temporary MusicBrainz errors |
| `MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS` | `1100` | Serialized MusicBrainz request interval |
| `HISTORY_DB_PATH` | `/app/data/lastfm.sqlite` | SQLite database path |
| `HISTORY_LIVE_SCAN_LIMIT` | `5000` | Maximum live scan size when no index exists |
| `HISTORY_MAX_SYNC_TRACKS` | `250000` | Safety cap for one resumable sync call |

The `from` and `to` parameters accept Unix seconds, a UTC date such as `2026-08-01`, or ISO 8601 with an explicit timezone such as `2026-08-01T00:00:00Z`. A date-only `from` means 00:00:00 UTC; a date-only inclusive `to` means 23:59:59 UTC. Ambiguous local date-times without `Z` or a UTC offset are rejected.

## Intelligence methodology

- Canonicalization uses NFKC Unicode normalization, locale-independent case folding, punctuation spacing normalization, conservative trailing `feat.` removal for artist credits, and conservative remaster/deluxe suffix removal for albums. Track qualifiers remain distinct.
- Exposure levels are explicit heuristics: zero plays is `unheard`, 1–10 is `sampled`, and a one-track/one-day repeat remains `sampled` even above ten plays. Broader trials are `explored`, distributed returns are `established`, and high sustained exposure is `favorite`.
- Artist affinity scores play depth, active-day/month breadth, returning sessions, 30-day returns, and distribution. Each component and weight is returned; album-completion evidence is reported separately rather than silently folded into the score.
- Sessions default to a 45-minute inactivity gap. Album completion is only classified when MusicBrainz supplies an ordered tracklist; otherwise completion remains unknown rather than fabricated.
- Timeline buckets use UTC. Era boundaries compare monthly artist distributions statistically and preserve genuine inactive-month gaps.
- Recommendation `confidence` measures evidence coverage/consistency, not the probability that the user will like an artist. Risks always disclose missing audio-feature evidence and weak/single-cluster support.
- `safe` favors strong similarity to established seeds, `bridge` requires links to at least two tag-derived/provisional seed clusters, and `explore` favors grounded but more moderate similarity. Prior recommendation outcomes and artist-level feedback adjust ranking; album/track dislikes only remove that starting item, not the whole artist.

## Persistent local data

The SQLite volume stores:

- complete normalized scrobbles and sync status;
- canonical artist, album, and track catalogs plus aliases;
- explicit feedback and taste-dimension signals;
- recommendation exclusions and expiration policies;
- recommendation events, baseline exposure, and evaluation inputs.

This data is personal. Back up the `lastfm-data` Docker volume, and do not expose a no-auth deployment if its listening history or feedback should remain private.

## Taste profile methodology

- `coreArtists`: all-time top artists with play counts for the last three months.
- `trend`: when the local index has sufficient coverage, the most recent 30 days are compared with the preceding non-overlapping 30 days. Otherwise, the server approximately compares normalized three-month and overall shares.
- `favoriteTracks`: all-time top tracks, recent plays, and the `loved` signal.
- `recentDiscoveries`: the exact first-listen date is available only after a complete, current sync; otherwise the result is explicitly marked as an approximation.
- `forgottenFavorites`: strong all-time artists with almost no plays in the recent three-month chart.
- `repeatHeavy`: unique-track ratio and the top-ten track share across the last 90 days or the available sample.
- `albumOriented`: album metadata coverage and the share of consecutive transitions within the same album.

Every profile response contains `confidence` and `caveat` fields so the model can distinguish evidence from heuristics.

## Last.fm API limitations

- `user.getRecentTracks` returns at most 200 items per page and may include a now-playing item without a timestamp.
- Artist, album, and track history search is performed locally because Last.fm provides no equivalent server-side filter.
- MBIDs are frequently empty; the fallback identity is built from normalized names.
- MusicBrainz metadata is community-edited and may not resolve local files, obscure editions, or ambiguous names. The response reports when no ordered tracklist is available.
- MusicBrainz relationships are metadata, not a general similarity graph. Candidate generation currently uses Last.fm similar artists and the local taste graph.
- Spotify audio features and scraped recommendation sites are intentionally not used. They require separate credentials, licensing, or scraping decisions and should be integrated explicitly rather than silently.
- Last.fm does not publish a fixed numeric rate limit. The client limits its request rate and retries temporary errors `11`, `16`, and `29`, as well as HTTP `429` and `5xx`, with backoff.
- Images are intentionally neither returned nor cached because the API Terms place separate restrictions on artwork and image use.
- For commercial or research use, review the [Last.fm API Terms](https://www.last.fm/api/tos) and contact Last.fm if required.

Official methods and APIs: [Last.fm REST API](https://www.last.fm/api/rest), [user.getRecentTracks](https://www.last.fm/api/show/user.getRecentTracks), [user.getTopArtists](https://www.last.fm/api/show/user.getTopArtists), [user.getTopTracks](https://www.last.fm/api/show/user.getTopTracks), [user.getTopAlbums](https://www.last.fm/api/show/user.getTopAlbums), [user.getLovedTracks](https://www.last.fm/api/show/user.getLovedTracks), [user.getInfo](https://www.last.fm/api/show/user.getInfo), and [MusicBrainz Web Service](https://musicbrainz.org/doc/MusicBrainz_API).

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Run checks:

```bash
npm run check
npm audit --omit=dev
docker compose build
```

The project uses the official MCP TypeScript SDK v2, the Express adapter with Host and Origin validation, Node.js 24, and the built-in `node:sqlite` module.
