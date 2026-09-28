import type { Agent } from "../context";
import { log } from "../log";

// The media folder keeps what the rows name. The rest goes: pictures of chats that left the list (a list with thousands
// of chats shows other people below its first screen at every start), of items gone from the feed, images of messages
// no longer kept.
export function pruneMedia(a: Agent) {
  const removed = a.media.prune(a.store.mediaFiles());
  if (removed) log.info("media", "removed files no row names", { files: removed });
}
