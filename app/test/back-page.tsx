// A list, a chat over it and the remote desktop over either, as App.tsx shows them on a phone, for test/back.test.ts:
// the buttons open and close each level as the app does, and window.loaded tells the page from one loaded again.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useBack } from "@/lib/back";

(window as Window & { loaded?: number }).loaded = Math.random();

function Page() {
  const [chat, setChat] = useState(false);
  const [desktop, setDesktop] = useState(false);
  useBack(desktop ? (chat ? 2 : 1) : chat ? 1 : 0, (to) => {
    if (to < 2) setDesktop(false);
    if (to < 1) setChat(false);
  });
  return (
    <>
      <p id="shown">{desktop ? "desktop" : chat ? "chat" : "list"}</p>
      <button type="button" onClick={() => setChat(true)}>
        Open chat
      </button>
      <button type="button" onClick={() => setChat(false)}>
        Arrow
      </button>
      <button type="button" onClick={() => setDesktop(true)}>
        Desktop
      </button>
      <button
        type="button"
        onClick={() => {
          setChat(false);
          setDesktop(false);
        }}
      >
        Chats tab
      </button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
