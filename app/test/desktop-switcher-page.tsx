// The desktop tab with its switcher of the accounts (/remote) on a page of its own, for test/desktop-switcher.test.ts:
// the accounts of one user, the one asked for in ?account=N.
import { createRoot } from "react-dom/client";
import { DesktopSwitcher } from "@/components/DesktopSwitcher";
import type { Account } from "@/lib/client";

const base: Account = {
  slot: 0,
  name: "",
  email: "",
  tenant: "",
  av: "",
  teams: "ok",
  overall: "green",
  stopped: false,
  unread: 0,
  unreadActivity: [],
  missedCalls: [],
  activityIds: [],
  added: 1790000000,
  desktop: "",
  checkEvery: 0,
  checked: 0,
  checkResult: "",
  nextCheck: 0,
  checking: false,
  relay: false,
  host: "",
  relaySeen: 0,
};

const accounts: Account[] = [
  { ...base, slot: 1, name: "Test User", email: "test.user@contoso.example", tenant: "Contoso Cruises", desktop: "/api/desktop/1" },
  { ...base, slot: 2, name: "User Test", email: "user.test@fabrikam.example", tenant: "", desktop: "/api/desktop/2" },
  { ...base, slot: 3, name: "Relay User", tenant: "Relay Srl", relay: true },
  { ...base, slot: 4, name: "Stopped User", tenant: "Stopped Srl", stopped: true, desktop: "/api/desktop/4" },
  { ...base, slot: 5, name: "Checked User", tenant: "Checked Srl", checkEvery: 3600, desktop: "/api/desktop/5" },
];

const initial = Number(new URLSearchParams(location.search).get("account"));
createRoot(document.getElementById("root")!).render(<DesktopSwitcher accounts={accounts} initial={initial} />);
