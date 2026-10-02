import { z } from "zod";

// What was unread at the end of a check (src/agent/commands/check.ts): each unread chat with its preview (a new message
// changes it) and, from the recent reads of the feed (newest first, up to KEEP), the ids of the unread Activity items
// and of the missed calls (Teams shows those as read, new or not), and whether any feed was read (a row of an earlier
// release, without it, was written after one). New is an id the recent reads did not have; an item a read shows takes
// the state it has there, one the read leaves out keeps the state of the reads before (a shorter read leaves out the
// older items). Feed items carry no time: an older item that only a longer read shows counts as new too. A row without
// calls, from an earlier release, pushes no missed call: the check only records them. The missed calls of an account
// always on count those as told (src/agent/jobs/missed-calls.ts).
export const Seen = z.object({
  chats: z.array(z.string()).catch([]),
  activity: z.array(z.string()).catch([]),
  calls: z.array(z.string()).optional().catch(undefined),
  read: z.boolean().catch(true),
});

// ids kept, newest first
const KEEP = 200;

// ids newest first: the ones of this read, then the ones of the earlier reads, up to KEEP
export const union = (now: string[], before: string[] | undefined) => [...new Set([...now, ...(before ?? [])])].slice(0, KEEP);
