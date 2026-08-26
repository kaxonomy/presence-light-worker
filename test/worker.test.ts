import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src";

const worker = exports.default;
const VIEW_TOKEN = "test-view-token";
const CONTROL_TOKEN = "test-control-token";

type State = { status: "available" | "busy"; updatedAt: number };
type Message = State & { type: "snapshot" | "status_changed" } | { type: "error"; code: string };

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function read(room: string, token = VIEW_TOKEN): Promise<Response> {
  return worker.fetch(`https://example.com/api/rooms/${room}/status`, {
    headers: authorization(token),
  });
}

async function setStatus(room: string, status: unknown, token = CONTROL_TOKEN): Promise<Response> {
  return worker.fetch(`https://example.com/api/rooms/${room}/status`, {
    method: "POST",
    headers: { ...authorization(token), "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

function nextMessage(socket: WebSocket): Promise<Message> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string) as Message), {
      once: true,
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
  });
}

async function connect(room: string, token: string): Promise<{ socket: WebSocket; snapshot: Message }> {
  const response = await worker.fetch(`https://example.com/ws/${room}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Expected WebSocket response");
  response.webSocket.accept();
  return { socket: response.webSocket, snapshot: await nextMessage(response.webSocket) };
}

describe("presence worker", () => {
  it("returns the default status for a new room", async () => {
    const response = await read("default-room");
    expect(response.status).toBe(200);
    expect(await response.json<State>()).toMatchObject({ status: "available" });
  });

  it("lets a controller change status", async () => {
    expect(await (await setStatus("controller-room", "busy")).json<State>()).toMatchObject({ status: "busy" });
    expect(await (await read("controller-room")).json<State>()).toMatchObject({ status: "busy" });
  });

  it("does not let a viewer change status over WebSocket", async () => {
    const { socket } = await connect("viewer-room", VIEW_TOKEN);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "set_status", status: "busy" }));
    await expect(reply).resolves.toEqual({ type: "error", code: "forbidden" });
    expect(await (await read("viewer-room")).json<State>()).toMatchObject({ status: "available" });
    socket.close(1000, "done");
  });

  it("rejects an invalid status without changing state", async () => {
    expect((await setStatus("invalid-room", "banana")).status).toBe(400);
    expect(await (await read("invalid-room")).json<State>()).toMatchObject({ status: "available" });
  });

  it("persists status for a fresh request", async () => {
    await setStatus("persistent-room", "busy");
    const response = await read("persistent-room");
    expect(await response.json<State>()).toMatchObject({ status: "busy" });
  });

  it("isolates rooms", async () => {
    await setStatus("room-a", "busy");
    expect(await (await read("room-a")).json<State>()).toMatchObject({ status: "busy" });
    expect(await (await read("room-b")).json<State>()).toMatchObject({ status: "available" });
  });

  it("sends the authoritative snapshot on WebSocket connection", async () => {
    await setStatus("snapshot-room", "busy");
    const { socket, snapshot } = await connect("snapshot-room", VIEW_TOKEN);
    expect(snapshot).toMatchObject({ type: "snapshot", status: "busy" });
    expect((snapshot as State).updatedAt).toEqual(expect.any(Number));
    socket.close(1000, "done");
  });

  it("broadcasts a controller WebSocket mutation to every socket", async () => {
    const viewer = await connect("broadcast-room", VIEW_TOKEN);
    const controller = await connect("broadcast-room", CONTROL_TOKEN);
    const viewerUpdate = nextMessage(viewer.socket);
    const controllerUpdate = nextMessage(controller.socket);
    controller.socket.send(JSON.stringify({ type: "set_status", status: "busy" }));
    await expect(Promise.all([viewerUpdate, controllerUpdate])).resolves.toEqual([
      expect.objectContaining({ type: "status_changed", status: "busy" }),
      expect.objectContaining({ type: "status_changed", status: "busy" }),
    ]);
    viewer.socket.close(1000, "done");
    controller.socket.close(1000, "done");
  });

  it("broadcasts an HTTP mutation to every socket", async () => {
    const first = await connect("http-broadcast-room", VIEW_TOKEN);
    const second = await connect("http-broadcast-room", VIEW_TOKEN);
    const firstUpdate = nextMessage(first.socket);
    const secondUpdate = nextMessage(second.socket);
    expect((await setStatus("http-broadcast-room", "busy")).status).toBe(200);
    await expect(Promise.all([firstUpdate, secondUpdate])).resolves.toEqual([
      expect.objectContaining({ type: "status_changed", status: "busy" }),
      expect.objectContaining({ type: "status_changed", status: "busy" }),
    ]);
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("survives malformed WebSocket input", async () => {
    const { socket } = await connect("malformed-room", CONTROL_TOKEN);
    const invalidReply = nextMessage(socket);
    socket.send("not json at all");
    await expect(invalidReply).resolves.toEqual({ type: "error", code: "invalid_message" });

    const validReply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "set_status", status: "busy" }));
    await expect(validReply).resolves.toMatchObject({ type: "status_changed", status: "busy" });
    socket.close(1000, "done");
  });

  it("keeps duplicate updates idempotent", async () => {
    await setStatus("idempotent-room", "busy");
    const { socket, snapshot } = await connect("idempotent-room", CONTROL_TOKEN);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "set_status", status: "busy" }));
    await expect(reply).resolves.toEqual(snapshot);
    socket.close(1000, "done");
  });

  it("preserves controller authorization across hibernation", async () => {
    const room = "hibernation-room";
    const { socket } = await connect(room, CONTROL_TOKEN);
    const namespace = (env as unknown as Env).PRESENCE_ROOMS;
    await evictDurableObject(namespace.get(namespace.idFromName(room)));

    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "set_status", status: "busy" }));
    await expect(reply).resolves.toMatchObject({ type: "status_changed", status: "busy" });
    socket.close(1000, "done");
  });

  it("enforces HTTP authentication and authorization", async () => {
    expect((await worker.fetch("https://example.com/api/rooms/auth-room/status")).status).toBe(401);
    expect((await read("auth-room", "wrong-token")).status).toBe(401);
    expect((await read("auth-room", VIEW_TOKEN)).status).toBe(200);
    expect((await setStatus("auth-room", "busy", VIEW_TOKEN)).status).toBe(403);
    expect((await read("auth-room", CONTROL_TOKEN)).status).toBe(200);
    expect((await setStatus("auth-room", "busy", CONTROL_TOKEN)).status).toBe(200);
  });
});
