// The Change server entries of the web app on a page of their own, for test/change-server.test.ts: the account menu
// (/menu) and the sign-in page (/login?next=...), the start page of the Android app taken as the web app takes it.
import { createRoot } from "react-dom/client";
import { AccountMenu } from "@/components/AccountMenu";
import { LoginForm } from "@/components/LoginForm";
import { useAppStart } from "@/lib/android-app";
import type { Account } from "@/lib/client";

const account: Account = {
  slot: 2,
  name: "Test User",
  email: "test.user@contoso.example",
  tenant: "Contoso Srl",
  av: "",
  teams: "ok",
  overall: "green",
  stopped: false,
  unread: 0,
  unreadActivity: [],
  missedCalls: [],
  added: 1790000000,
  desktop: "",
  checkEvery: 0,
  checked: 0,
  checkResult: "",
  nextCheck: 0,
  checking: false,
};

const none = () => undefined;

function Menu() {
  const appPage = useAppStart();
  return (
    <AccountMenu
      user={{ name: "Test User", email: "test.user@contoso.example", role: "user" }}
      accounts={[account]}
      current={account}
      unreadOf={() => ({ chats: 0, notifications: 0, calls: 0 })}
      others={0}
      canAdd={false}
      addLabel="Add a Teams account"
      adding={false}
      onSelect={none}
      onAdd={none}
      onOpenDesktop={none}
      onRemove={none}
      onSignOut={none}
      appPage={appPage}
    />
  );
}

const next = new URLSearchParams(location.search).get("next") ?? "/";
createRoot(document.getElementById("root")!).render(location.pathname === "/login" ? <LoginForm next={next} /> : <Menu />);
