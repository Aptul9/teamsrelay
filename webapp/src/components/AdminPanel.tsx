"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, call, post } from "@/lib/client";

type UserRow = { id: string; name: string; email: string; role: string; banned: boolean; slots: number[] };
type Data = { users: UserRow[]; slotCount: number; free: number };

// Users of this server. An administrator sees who owns which slot, never the chats of other users.
export function AdminPanel({ selfId }: { selfId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });

  const load = useCallback(async () => {
    try {
      setData(await call<Data>("/api/admin/users", undefined, 0));
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Users not loaded");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    call<Data>("/api/admin/users", undefined, 0).then(
      (d) => alive && setData(d),
      (e) => alive && setMsg(e instanceof ApiError ? e.message : "Users not loaded"),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function act(label: string, fn: () => Promise<unknown>) {
    setMsg("");
    try {
      await fn();
      setMsg(label);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed");
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await act(`User ${form.email} created`, () => post("/api/admin/users", form, 0));
    setForm({ name: "", email: "", password: "", role: "user" });
  }

  function setPassword(u: UserRow) {
    const password = prompt(`New password for ${u.email} (at least 10 characters). Every device of the user is signed out.`);
    if (password) void act("Password changed", () => post(`/api/admin/users/${u.id}/password`, { password }, 0));
  }

  function remove(u: UserRow) {
    if (!confirm(`Delete ${u.email}?\n\nTheir Teams accounts on this server are signed out and wiped.`)) return;
    void act("User deleted", () => call(`/api/admin/users/${u.id}`, { method: "DELETE" }, 0));
  }

  function freeSlot(u: UserRow, slot: number) {
    if (!confirm(`Free slot ${slot} of ${u.email}?\n\nThe Teams session and data of that account are deleted.`)) return;
    void act(`Slot ${slot} freed`, () => call(`/api/accounts/${slot}`, { method: "DELETE" }, 0));
  }

  return (
    <div className="page">
      <div className="card">
        <div className="topnav">
          <Link href="/">‹ Back to the app</Link>
          {data && (
            <span className="hint">
              Slots in use: {data.slotCount - data.free} of {data.slotCount}
            </span>
          )}
        </div>
        <h1>Users</h1>
        {!data ? (
          <div className="hint">Loading…</div>
        ) : (
          <table className="users">
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="who">
                    <b>
                      {u.name}
                      {u.role === "admin" && <span className="tag">admin</span>}
                    </b>
                    <span>{u.email}</span>
                    <span>{u.slots.length ? `Teams accounts: slot ${u.slots.join(", ")}` : "No Teams account"}</span>
                  </td>
                  <td>
                    <div className="acts">
                      <button className="btn small ghost" onClick={() => setPassword(u)}>
                        Set password
                      </button>
                      <button className="btn small ghost" onClick={() => void act("Devices signed out", () => call(`/api/admin/users/${u.id}/sessions`, { method: "DELETE" }, 0))}>
                        Sign out devices
                      </button>
                      {u.slots.map((s) => (
                        <button key={s} className="btn small danger" onClick={() => freeSlot(u, s)}>
                          Free slot {s}
                        </button>
                      ))}
                      {u.id !== selfId && (
                        <button className="btn small danger" onClick={() => remove(u)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h2>New user</h2>
        <form onSubmit={create}>
          <div className="form-grid">
            <input className="field" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input className="field" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <input className="field" type="password" placeholder="Password (at least 10 characters)" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            <select className="field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          <div style={{ height: 10 }} />
          <button className="btn">Create user</button>
        </form>
        <div className="err">{msg}</div>
      </div>
    </div>
  );
}
