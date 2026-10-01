// The consent screen of an MCP client signing in (src/components/OAuthConsent.tsx), on a page of its own for
// test/consent-page.test.ts: window.show(props) renders it as the page /consent does.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OAuthConsent, type OAuthConsentProps } from "@/components/OAuthConsent";

type TestWindow = Window & { show?: (p: OAuthConsentProps) => void };
const w = window as TestWindow;

function Page() {
  const [props, setProps] = useState<OAuthConsentProps | null>(null);
  useEffect(() => {
    w.show = setProps;
  }, []);
  return props ? <OAuthConsent {...props} /> : null;
}

createRoot(document.getElementById("root")!).render(<Page />);
