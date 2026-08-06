# Last.fm Taste MCP

A personal Last.fm MCP server built with Node.js and TypeScript. It uses stateless Streamable HTTP, provides ChatGPT with normalized scrobble data, and builds a taste profile with explicit confidence and completeness indicators.

The server uses only read-only Last.fm methods. The API key stays inside the container and is never returned through MCP.

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

All informational tools are marked read-only. `sync_listening_history` only changes the local SQLite cache and is annotated separately.

## 1. Get a Last.fm API key

1. Sign in to your Last.fm account.
2. Open [Last.fm Create API account](https://www.last.fm/api/account/create).
3. Enter an application name and description. This server does not require a callback URL.
4. Copy the **API key**.
5. Get your username from your profile URL: `https://www.last.fm/user/<username>`.

Last.fm also displays a shared secret, but this server does not need it. `user.getInfo`, `user.getTop*`, `user.getRecentTracks`, `user.getLovedTracks`, and `artist.getInfo` do not require a user session. Do not add the shared secret to `.env`.

## 2. Configure and run with Docker Compose

```bash
cp .env.example .env
```

At minimum, set:

```dotenv
LASTFM_API_KEY=your-api-key
LASTFM_USERNAME=your-lastfm-username
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
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

You can also invoke the MCP tool `sync_listening_history` and inspect progress with `get_history_status`.

If your library contains more than `HISTORY_MAX_SYNC_TRACKS`, increase that variable in `.env` and repeat the full sync. A full sync fixes its upper time boundary when it starts, so new scrobbles cannot shift pagination during the backfill.

The index is stored in the `lastfm-data` named volume as normalized SQLite data rather than raw Last.fm responses.

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
3. Enter a name such as `My Last.fm` and the endpoint `https://mcp.example.com/mcp`.
4. Select **No authentication**.
5. Click **Scan Tools**, wait for all 12 tools to appear, and create the app.
6. Enable the app from the tools menu in a new chat.

Example first prompt:

> Call get_history_status first. If fullHistorySynced=true, build a detailed music taste profile with get_taste_profile and compare_listening_periods for 12month versus 3month. Separate facts from interpretations.

Developer mode and custom MCP app availability depend on your plan and workspace settings. See the [official ChatGPT instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) for current details.

### Why there is no static Bearer token

ChatGPT custom apps should not rely on an arbitrary user-supplied API key or header. For a personal MVP, this server exposes only public, read-only Last.fm data and uses `noauth`; `LASTFM_API_KEY` remains server-side.

If you consider your listening history sensitive, do not expose this configuration publicly. Use Secure MCP Tunnel or place a proper OAuth 2.1 gateway in front of the MCP server. Query-string tokens are intentionally unsupported because URLs are commonly recorded in logs and browser history.

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
| `LASTFM_TIMEOUT_MS` | `10000` | Timeout for one API request |
| `LASTFM_MAX_RETRIES` | `3` | Retry count for temporary and rate-limit errors |
| `LASTFM_MIN_REQUEST_INTERVAL_MS` | `250` | Minimum delay between Last.fm requests, approximately four requests per second |
| `LASTFM_CACHE_TTL_SECONDS` | `300` | In-memory cache duration for chart and info calls |
| `HISTORY_DB_PATH` | `/app/data/lastfm.sqlite` | SQLite database path |
| `HISTORY_LIVE_SCAN_LIMIT` | `5000` | Maximum live scan size when no index exists |
| `HISTORY_MAX_SYNC_TRACKS` | `250000` | Safety cap for a single sync |

The `from` and `to` parameters accept Unix seconds or ISO 8601 with an explicit timezone, such as `2026-08-01T00:00:00Z`. Ambiguous local dates without `Z` or a UTC offset are rejected.

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
- Last.fm does not publish a fixed numeric rate limit. The client limits its request rate and retries temporary errors `11`, `16`, and `29`, as well as HTTP `429` and `5xx`, with backoff.
- Images are intentionally neither returned nor cached because the API Terms place separate restrictions on artwork and image use.
- For commercial or research use, review the [Last.fm API Terms](https://www.last.fm/api/tos) and contact Last.fm if required.

Official methods: [REST API](https://www.last.fm/api/rest), [user.getRecentTracks](https://www.last.fm/api/show/user.getRecentTracks), [user.getTopArtists](https://www.last.fm/api/show/user.getTopArtists), [user.getTopTracks](https://www.last.fm/api/show/user.getTopTracks), [user.getTopAlbums](https://www.last.fm/api/show/user.getTopAlbums), [user.getLovedTracks](https://www.last.fm/api/show/user.getLovedTracks), and [user.getInfo](https://www.last.fm/api/show/user.getInfo).

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
