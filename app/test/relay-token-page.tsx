// The dialog with the token of an account on another computer, on a page of its own for test/relay-token.test.ts:
// window.show(token, server) opens it as the app does with the answer of the server.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RelayTokenDialog } from "@/components/RelayToken";

type TestWindow = Window & { show?: (token: string, server: string) => void };
const w = window as TestWindow;

function Page() {
  const [joined, setJoined] = useState<{ token: string; server: string } | null>(null);
  useEffect(() => {
    w.show = (token, server) => setJoined({ token, server });
  }, []);
  return <RelayTokenDialog token={joined?.token ?? null} server={joined?.server ?? ""} onClose={() => setJoined(null)} />;
}

createRoot(document.getElementById("root")!).render(<Page />);
