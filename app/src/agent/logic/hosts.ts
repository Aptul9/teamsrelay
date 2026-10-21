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

// Pages that show nothing: a tab just opened, an error page of the browser
export const BLANK = /^(about:|chrome:|edge:|chrome-error:)/;

// Whether the DevTools list of targets (/json/list) holds a page that shows something
export function showsPage(targets: readonly { type?: string; url?: string }[]): boolean {
  return targets.some((t) => t.type === "page" && !!t.url && !BLANK.test(t.url));
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
