"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function Settings({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 10) return setMsg("New password: at least 10 characters");
    setBusy(true);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (error) return setMsg(error.message || "Password not changed");
    setCurrent("");
    setNext("");
    setMsg("Password changed. Other devices have been signed out.");
  }

  async function signOutOthers() {
    const { error } = await authClient.revokeOtherSessions();
    setMsg(error ? error.message || "Failed" : "Other devices signed out");
  }

  return (
    <div className="page">
      <div className="card">
        <div className="topnav">
          <Link href="/">‹ Back to the app</Link>
          <button className="btn small ghost" onClick={() => void authClient.signOut().then(() => router.replace("/login"))}>
            Sign out
          </button>
        </div>
        <h1>Settings</h1>
        <p className="hint">
          {user.name} · {user.email}
        </p>
        <h2>Password</h2>
        <form onSubmit={changePassword}>
          <input className="field" type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <input className="field" type="password" placeholder="New password (at least 10 characters)" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          <button className="btn" disabled={busy}>
            Change password
          </button>
        </form>
        <h2>Devices</h2>
        <button className="btn ghost" onClick={() => void signOutOthers()}>
          Sign out every other device
        </button>
        <div className="err">{msg}</div>
      </div>
    </div>
  );
}
