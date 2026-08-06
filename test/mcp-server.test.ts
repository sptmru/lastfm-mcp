import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createLastFmMcpServer } from "../src/mcp-server.js";
import type { ListeningService } from "../src/listening-service.js";

describe("MCP server", () => {
  it("advertises the complete Last.fm tool surface over Streamable HTTP", async () => {
    const handler = createMcpHandler(() => createLastFmMcpServer({} as ListeningService));
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const raw = await response.text();
    const json = raw.startsWith("event:")
      ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : raw;
    const payload = JSON.parse(json ?? "{}") as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
    const names = payload.result.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toEqual([
      "get_user_profile",
      "get_listening_summary",
      "get_top_artists",
      "get_top_tracks",
      "get_top_albums",
      "get_recent_tracks",
      "search_listening_history",
      "get_history_status",
      "sync_listening_history",
      "compare_listening_periods",
      "get_taste_profile",
      "get_artist_context",
    ]);
    expect(payload.result.tools.find((tool) => tool.name === "get_taste_profile")?.annotations?.readOnlyHint).toBe(true);
    expect(payload.result.tools.find((tool) => tool.name === "sync_listening_history")?.annotations?.readOnlyHint).toBe(false);
    await handler.close();
  });
});
