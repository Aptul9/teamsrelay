import { LOGIN_HOSTS, PROXY_SUFFIX, TEAMS_HOSTS } from "../teams/selectors";

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(PROXY_SUFFIX, "");
  } catch {
    return "";
  }
}

export function isTeamsUrl(url: string): boolean {
  return TEAMS_HOSTS.includes(hostOf(url)) && !url.includes("serviceworker");
}

export function isLoginUrl(url: string): boolean {
  return LOGIN_HOSTS.includes(hostOf(url));
}

// The Teams tab; without one, the Microsoft sign-in tab (account just added, or session expired)
export function pickTeamsPage<P extends { url(): string }>(pages: readonly P[]): P | null {
  let login: P | null = null;
  for (const p of pages) {
    const url = p.url();
    if (isTeamsUrl(url)) return p;
    if (!login && isLoginUrl(url)) login = p;
  }
  return login;
}
