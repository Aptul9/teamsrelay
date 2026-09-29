// Pictures of the chat list with the presence of the person, for test/avatar-presence.test.ts: one per case, each in
// an element named by its case.
import { createRoot } from "react-dom/client";
import { Avatar } from "@/components/Avatar";

const cases: [string, { presence?: string; muted?: boolean }][] = [
  ["available", { presence: "available" }],
  ["busy", { presence: "busy" }],
  ["dnd", { presence: "dnd" }],
  ["away", { presence: "away" }],
  ["offline", { presence: "offline" }],
  ["ooo", { presence: "ooo" }],
  ["none", {}],
  ["unknown", { presence: "weird" }],
  ["muted", { muted: true }],
  ["muted-away", { presence: "away", muted: true }],
];

createRoot(document.getElementById("root")!).render(
  <div>
    {cases.map(([id, p]) => (
      <div key={id} id={id}>
        <Avatar name="Anna Rossi" acc={1} presence={p.presence} muted={p.muted} />
      </div>
    ))}
  </div>,
);
