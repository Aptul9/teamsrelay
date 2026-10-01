// The AI clients card of Settings on a page of its own, for test/ai-clients.test.ts; the server is played by the test.
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { AiClients } from "@/components/AiClients";

createRoot(document.getElementById("root")!).render(
  <>
    <AiClients />
    <Toaster />
  </>,
);
