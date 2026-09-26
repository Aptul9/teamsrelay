import { DownloadArgs, parseArgs, type DownloadResult } from "@/shared/slot-db/commands";
import { cmdResultKey } from "@/shared/slot-db/state";
import type { Handler } from "./index";

// arg1: SharePoint URL, arg2: {name}. The file name for /files goes in cmd_result:<id>.
export const download: Handler = async (a, { id, arg1: url, arg2 }) => {
  const { name } = parseArgs(DownloadArgs, arg2);
  const f = await a.media.download(a.tp.page, url, name);
  if (!f) return "failed";
  a.store.setState(cmdResultKey(id), JSON.stringify({ f } satisfies DownloadResult));
  return "done";
};
