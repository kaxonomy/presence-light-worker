import { DurableObject } from "cloudflare:workers";
import {
  type ConnectionRole,
  type PresenceStatus,
  type ServerMessage,
  type StoredPresence,
  isPresenceStatus,
  parseClientMessage,
  parseStatusBody,
} from "./protocol";

export interface Env {
  PRESENCE_ROOMS: DurableObjectNamespace<PresenceRoom>;
  VIEW_TOKEN: string;
  CONTROL_TOKEN: string;
  ALLOWED_ORIGIN?: string;
}

interface ConnectionAttachment {
  role: ConnectionRole;
}

type MutationResult =
  | { ok: true; state: StoredPresence; changed: boolean }
  | { ok: false; code: "forbidden" | "invalid_status" };

const ROOM_PATH = /^\/api\/rooms\/([^/]+)\/status$/;
const WS_PATH = /^\/ws\/([^/]+)$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INTERNAL_ROLE_HEADER = "X-Presence-Role";
const MAX_HTTP_BODY_BYTES = 1024;

function roleFromToken(token: string | null, env: Env): ConnectionRole | null {
  if (!token) return null;
  if (env.CONTROL_TOKEN && token === env.CONTROL_TOKEN) return "controller";
  if (env.VIEW_TOKEN && token === env.VIEW_TOKEN) return "viewer";
  return null;
}

function roleFromAuthorization(request: Request, env: Env): ConnectionRole | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
  return roleFromToken(match?.[1] ?? null, env);
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of corsHeaders(request, env)) wrapped.headers.set(name, value);
  return wrapped;
}

function getRoomStub(room: string, env: Env): DurableObjectStub<PresenceRoom> {
  return env.PRESENCE_ROOMS.get(env.PRESENCE_ROOMS.idFromName(room));
}

async function handleApi(request: Request, env: Env, room: string): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin");
    return origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN
      ? json({ error: "origin_not_allowed" }, 403)
      : new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return withCors(json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST, OPTIONS" }), request, env);
  }

  const role = roleFromAuthorization(request, env);
  if (!role) return withCors(json({ error: "unauthorized" }, 401), request, env);
  if (request.method === "POST" && role !== "controller") {
    return withCors(json({ error: "forbidden" }, 403), request, env);
  }

  const internalRequest = new Request("https://presence-room.internal/status", {
    method: request.method,
    headers: {
      [INTERNAL_ROLE_HEADER]: role,
      ...(request.headers.get("Content-Type")
        ? { "Content-Type": request.headers.get("Content-Type")! }
        : {}),
    },
    body: request.method === "POST" ? request.body : null,
  });
  return withCors(await getRoomStub(room, env).fetch(internalRequest), request, env);
}

async function handleWebSocket(request: Request, env: Env, room: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required" }, 426);
  }

  const role = roleFromToken(new URL(request.url).searchParams.get("token"), env);
  if (!role) return json({ error: "unauthorized" }, 401);

  return getRoomStub(room, env).fetch(
    new Request("https://presence-room.internal/websocket", {
      headers: { Upgrade: "websocket", [INTERNAL_ROLE_HEADER]: role },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const apiMatch = ROOM_PATH.exec(path);
      const wsMatch = WS_PATH.exec(path);
      const room = apiMatch?.[1] ?? wsMatch?.[1];

      if (!room) return json({ error: "not_found" }, 404);
      if (!ROOM_ID.test(room)) return json({ error: "invalid_room" }, 400);
      return apiMatch ? handleApi(request, env, room) : handleWebSocket(request, env, room);
    } catch (error) {
      console.error("unexpected worker error", error);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export class PresenceRoom extends DurableObject<Env> {
  private async getState(): Promise<StoredPresence> {
    const stored = await this.ctx.storage.get<StoredPresence>("presence");
    if (stored) return stored;

    const initial: StoredPresence = { status: "available", updatedAt: Date.now() };
    await this.ctx.storage.put("presence", initial);
    return initial;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.warn("websocket send failed", error);
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private async setStatus(status: unknown, role: ConnectionRole): Promise<MutationResult> {
    if (role !== "controller") {
      console.warn("unauthorized mutation");
      return { ok: false, code: "forbidden" };
    }
    if (!isPresenceStatus(status)) return { ok: false, code: "invalid_status" };

    const current = await this.getState();
    if (current.status === status) return { ok: true, state: current, changed: false };

    const state: StoredPresence = { status, updatedAt: Date.now() };
    await this.ctx.storage.put("presence", state);
    this.broadcast({ type: "status_changed", ...state });
    console.log("status changed", { status });
    return { ok: true, state, changed: true };
  }

  async fetch(request: Request): Promise<Response> {
    const roleHeader = request.headers.get(INTERNAL_ROLE_HEADER);
    const role: ConnectionRole | null =
      roleHeader === "viewer" || roleHeader === "controller" ? roleHeader : null;
    if (!role) return json({ error: "unauthorized" }, 401);

    const path = new URL(request.url).pathname;
    if (path === "/websocket") return this.connectWebSocket(request, role);
    if (path !== "/status") return json({ error: "not_found" }, 404);

    if (request.method === "GET") return json(await this.getState());
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const length = Number(request.headers.get("Content-Length") ?? 0);
    if (length > MAX_HTTP_BODY_BYTES) return json({ error: "invalid_status" }, 400);

    let body: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_HTTP_BODY_BYTES) throw new Error("too large");
      body = JSON.parse(text);
    } catch {
      return json({ error: "invalid_status" }, 400);
    }

    const status = parseStatusBody(body);
    if (!status) return json({ error: "invalid_status" }, 400);

    const result = await this.setStatus(status, role);
    return result.ok ? json(result.state) : json({ error: result.code }, result.code === "forbidden" ? 403 : 400);
  }

  private async connectWebSocket(request: Request, role: ConnectionRole): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }

    const state = await this.getState();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role } satisfies ConnectionAttachment);
    this.send(server, { type: "snapshot", ...state });
    console.log("room connection opened", { role });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const message = parseClientMessage(data);
    if (!message) {
      console.warn("invalid message");
      this.send(socket, { type: "error", code: "invalid_message" });
      return;
    }

    const attachment: unknown = socket.deserializeAttachment();
    const role =
      typeof attachment === "object" &&
      attachment !== null &&
      "role" in attachment &&
      attachment.role === "controller"
        ? "controller"
        : "viewer";
    const result = await this.setStatus(message.status, role);
    if (!result.ok) {
      this.send(socket, { type: "error", code: result.code });
    } else if (!result.changed) {
      this.send(socket, { type: "snapshot", ...result.state });
    }
  }

  webSocketClose(): void {
    console.log("room connection closed");
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.warn("websocket error", error);
  }
}
