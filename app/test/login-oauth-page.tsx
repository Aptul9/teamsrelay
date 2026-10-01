// The sign-in page on a page of its own, for test/login-oauth.test.ts: as the web app renders /login.
import { createRoot } from "react-dom/client";
import { LoginForm } from "@/components/LoginForm";

createRoot(document.getElementById("root")!).render(<LoginForm next="/" />);
