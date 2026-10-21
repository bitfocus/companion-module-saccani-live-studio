import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import type { Socket } from "node:net";

const token = "a".repeat(64);
export async function networkFixture(
  websockets = false,
  replayAdmissionDelay = 0,
  requireToken = false,
) {
  const sourceID = randomUUID();
  const tab = {
    id: 7,
    sourceID,
    sourceKind: "video",
    filename: "remote.mp4",
    loaded: true,
    playing: false,
    loading: false,
    replay: false,
    outputActive: true,
    position: 0,
    duration: 20,
    frameRate: 25,
    volume: 0,
  };
  const commands: Record<string, unknown>[] = [];
  const operations = new Map<string, Record<string, unknown>>();
  let statusReads = 0;
  const httpAuthorizations: (string | undefined)[] = [],
    websocketProtocols: string[][] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    httpAuthorizations.push(request.headers.authorization);
    if (requireToken && request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(
        JSON.stringify({
          error: { code: "unauthorized", message: "Invalid token" },
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/status") {
      statusReads++;
      // Deliberately different host clock: network freshness must use local receipt time.
      response.end(
        JSON.stringify({
          playback: {
            seenAt: 100,
            videoControl: true,
            audioControl: true,
            videoJogControl: true,
            playbackTransportControl: true,
            audioVolumeControl: true,
            tabs: [tab],
          },
          replay: {
            seenAt: 100,
            busy: false,
            replayTab: 7,
            replayAudio: "mac",
            replayStopControl: true,
            configuredReplayControl: true,
            replayFullFrameControl: true,
            outputs: [{ id: 7, active: true, kind: "display" }],
          },
          operations: [...operations.values()],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.startsWith("/api/v1/operations/")
    ) {
      const value = operations.get(request.url.split("/").at(-1)!);
      response.writeHead(value ? 200 : 404);
      response.end(
        JSON.stringify(value ?? { error: { message: "Unknown operation" } }),
      );
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      commands.push({ ...body, route: request.url });
      const value = {
        id: body.id,
        state: "completed",
        completionID: "acknowledged",
      };
      if (request.url?.endsWith("/play")) tab.playing = true;
      if (request.url?.endsWith("/pause") || request.url?.endsWith("/stop"))
        tab.playing = false;
      if (request.url?.endsWith("/seek"))
        tab.position += Number(body.offsetSeconds);
      if (request.url === "/api/v1/replay/start") {
        value.state = "running";
        if (replayAdmissionDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, replayAdmissionDelay),
          );
      }
      if (request.url === "/api/v1/replay/stop") {
        const replay = operations.get(String(body.operationId));
        if (replay) replay.state = "cancelled";
      }
      operations.set(String(body.id), value);
      response.writeHead(202);
      response.end(JSON.stringify(value));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  const sockets = new Set<Socket>();
  let sequence = 0;
  const instanceId = randomUUID();
  server.on("upgrade", (request, socket) => {
    const protocols = String(request.headers["sec-websocket-protocol"])
      .split(",")
      .map((value) => value.trim());
    websocketProtocols.push(protocols);
    if (
      !websockets ||
      !protocols.includes("sls.v1") ||
      (requireToken && !protocols.includes(`sls.auth.${token}`))
    ) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(
        String(request.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: sls.v1\r\n\r\n`,
    );
    sockets.add(socket);
    const publish = () => {
      const value = {
        event: "studio.snapshot",
        sequence: ++sequence,
        instanceId,
        data: {
          playback: { seenAt: 100, videoControl: true, tabs: [tab] },
          replay: { seenAt: 100, busy: false },
          operations: [...operations.values()],
        },
      };
      const payload = Buffer.from(JSON.stringify(value));
      const header =
        payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      socket.write(Buffer.concat([header, payload]));
    };
    publish();
    const timer = setInterval(publish, 100);
    socket.on("data", (data) => {
      if ((data[0]! & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    socket.on("close", () => {
      clearInterval(timer);
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = {
    url: `http://127.0.0.1:${address.port}`,
    ...(requireToken ? { token } : {}),
  };
  return {
    connection,
    tab,
    commands,
    operations,
    httpAuthorizations,
    websocketProtocols,
    disconnectEvents: () => {
      for (const socket of sockets) socket.destroy();
    },
    reads: () => statusReads,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
