// The statuses of the status challenge (app/status-challenge-spec.md), shared by the light agent, the web app and the
// page in the browser

export const STATUSES = ["available", "busy", "dnd", "brb", "away", "offline"] as const;
export type Status = (typeof STATUSES)[number] | "unknown";

// Seconds after the last poll that saw a status within which the same status extends its stretch: 3 polls of the
// default LIGHT_POLL. The light agent uses 3 × its own poll.
export const STATUS_GAP = 180;

// presence.availability as Teams draws it next to the name
export function statusOf(availability: string): Status {
  switch (availability) {
    case "Available":
    case "AvailableIdle":
      return "available";
    case "Busy":
    case "BusyIdle":
      return "busy";
    case "DoNotDisturb":
      return "dnd";
    case "BeRightBack":
      return "brb";
    case "Away":
      return "away";
    case "Offline":
      return "offline";
    default:
      return "unknown";
  }
}
