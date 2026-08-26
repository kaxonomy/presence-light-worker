export type PresenceStatus = "available" | "busy";
export type ConnectionRole = "viewer" | "controller";

export type ClientMessage = {
  type: "set_status";
  status: PresenceStatus;
};

export type ServerMessage =
  | {
      type: "snapshot";
      status: PresenceStatus;
      updatedAt: number;
    }
  | {
      type: "status_changed";
      status: PresenceStatus;
      updatedAt: number;
    }
  | {
      type: "error";
      code: string;
    };

export interface StoredPresence {
  status: PresenceStatus;
  updatedAt: number;
}

export const isPresenceStatus = (value: unknown): value is PresenceStatus =>
  value === "available" || value === "busy";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseClientMessage(data: string | ArrayBuffer): ClientMessage | null {
  if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > 1024) return null;

  try {
    const value: unknown = JSON.parse(data);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      value.type !== "set_status" ||
      !isPresenceStatus(value.status)
    ) {
      return null;
    }
    return { type: "set_status", status: value.status };
  } catch {
    return null;
  }
}

export function parseStatusBody(value: unknown): PresenceStatus | null {
  return isRecord(value) && Object.keys(value).length === 1 && isPresenceStatus(value.status)
    ? value.status
    : null;
}
