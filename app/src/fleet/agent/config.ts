// The fleet agent's configuration, read from fleet.config.json (holds the cmdapi token and the ssh authorized keys, so
// it is never committed). One hub VM; cmdapi and ssh are independent components, each off unless enabled, and an
// enabled component must carry what it needs (a VM loopback port, plus a token for cmdapi or at least one key for ssh).
import { z } from "zod";
import { ConfigError, issuesText, readJsonFile } from "@/shared/env";

const Port = z.number().int().min(1).max(65535);

const Cmdapi = z.object({
  enabled: z.boolean().default(false),
  // the VM loopback port this host's cmdapi is published on by its reverse tunnel
  vmPort: Port.optional(),
  // the port cmdapi listens on locally (loopback)
  localPort: Port.default(8765),
  token: z.string().default(""),
  cwd: z.string().default(""),
  timeout: z.number().positive().default(600),
});

const Ssh = z.object({
  enabled: z.boolean().default(false),
  // "library": the embedded ssh2 server. "system": a tunnel to the host's own sshd on
  // localPort (default 22), a real OS login shell, which needs sshd installed on the host.
  mode: z.enum(["library", "system"]).default("library"),
  vmPort: Port.optional(),
  // the local port the tunnel targets; the agent defaults it by mode (2022 for library, 22 for system)
  localPort: Port.optional(),
  hostKeyFile: z.string().default("state/fleet/ssh_host_key"),
  // OpenSSH public key lines allowed to log in (library mode; system mode leaves auth to the host's sshd)
  authorizedKeys: z.array(z.string()).default([]),
});

const Schema = z
  .object({
    // ssh alias of the hub VM (an entry in this user's ~/.ssh/config), shared by every component's tunnel
    vm: z.string().min(1),
    // run a second agent on this host: shifts the local port of every component we bind by N (the VM port stays the
    // explicit per-host one, so a fleet clash still fails loudly). System-mode ssh is the host's own sshd, not ours, so
    // it does not shift.
    instance: z.coerce.number().int().min(0).default(0),
    // a missing section means the component is absent: default to its fully-defaulted (disabled) form
    cmdapi: Cmdapi.default(() => Cmdapi.parse({})),
    ssh: Ssh.default(() => Ssh.parse({})),
  })
  .superRefine((c, ctx) => {
    if (c.cmdapi.enabled) {
      if (!c.cmdapi.vmPort) ctx.addIssue({ code: "custom", message: "cmdapi.vmPort is required when cmdapi.enabled", path: ["cmdapi", "vmPort"] });
      if (c.cmdapi.token.length < 16) ctx.addIssue({ code: "custom", message: "cmdapi.token (>= 16 chars) is required when cmdapi.enabled", path: ["cmdapi", "token"] });
      if (c.cmdapi.localPort + c.instance > 65535) ctx.addIssue({ code: "custom", message: "cmdapi.localPort + instance exceeds 65535", path: ["cmdapi", "localPort"] });
    }
    if (c.ssh.enabled) {
      if (!c.ssh.vmPort) ctx.addIssue({ code: "custom", message: "ssh.vmPort is required when ssh.enabled", path: ["ssh", "vmPort"] });
      // library mode runs our own server and needs the keys; system mode leaves auth to the host's sshd
      if (c.ssh.mode === "library") {
        if (c.ssh.authorizedKeys.length === 0) {
          ctx.addIssue({ code: "custom", message: "ssh.authorizedKeys needs at least one key in library mode", path: ["ssh", "authorizedKeys"] });
        }
        if ((c.ssh.localPort ?? 2022) + c.instance > 65535) {
          ctx.addIssue({ code: "custom", message: "ssh.localPort + instance exceeds 65535", path: ["ssh", "localPort"] });
        }
      }
    }
  });

export type AgentConfig = z.infer<typeof Schema>;

// The local port a component binds, once the instance offset is applied. Only ports we bind shift: system-mode ssh
// tunnels to the host's own sshd on a fixed port, so it is left alone.
export function cmdapiLocalPort(c: AgentConfig): number {
  return c.cmdapi.localPort + c.instance;
}
export function sshLocalPort(c: AgentConfig): number {
  const base = c.ssh.localPort ?? (c.ssh.mode === "system" ? 22 : 2022);
  return c.ssh.mode === "system" ? base : base + c.instance;
}

export function parseAgentConfig(obj: unknown): AgentConfig {
  const r = Schema.safeParse(obj);
  if (!r.success) throw new ConfigError(issuesText(r.error));
  return r.data;
}

export const loadAgentConfigFile = (file: string): AgentConfig => parseAgentConfig(readJsonFile(file, "fleet config"));
