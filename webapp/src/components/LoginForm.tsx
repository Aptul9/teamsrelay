"use client";

import { useState } from "react";
import { Logo } from "./Avatar";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(error.status === 429 ? "Too many attempts, try again in a few minutes" : "Wrong email or password");
      return;
    }
    // full navigation: the remote desktop is served by Caddy, outside the Next.js router
    window.location.href = next;
  }

  return (
    <div className="page center">
      <form className="card narrow" onSubmit={submit}>
        <div className="biglogo">
          <Logo size={30} />
        </div>
        <h1>TeamsRelay</h1>
        <input className="field" type="email" placeholder="Email" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="field" type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="err">{error}</div>
      </form>
    </div>
  );
}
