import { describe, expect, it } from "vitest";
import { authorizationCode, mcasContinuation, mcasForm, mcasMoved, mcasRestore } from "../../scripts/mcas-auth-probe.mjs";

const form = (action: string, value = "header.payload.signature") => `<html><form method="post" action="${action}"><input type="hidden" name="id_token" value="${value}"><input type="submit" value="Submit"></form></html>`;
const gateway = "https://nposervices-onmicrosoft-com.access.mcas.ms/aad_login";

describe("MCAS diagnostic form parser", () => {
  it("takes the observed hidden id_token form without exposing other fields", () => {
    expect(mcasForm(form(gateway))).toEqual({ action: gateway, idToken: "header.payload.signature" });
  });

  it("decodes entities before checking the destination", () => {
    expect(mcasForm(form(gateway.replace("https:", "https&#58;"), "a&#46;b&#46;c"))).toEqual({ action: gateway, idToken: "a.b.c" });
  });

  it.each(["https://other.test/aad_login", "http://nposervices-onmicrosoft-com.access.mcas.ms/aad_login", "https://user@nposervices-onmicrosoft-com.access.mcas.ms/aad_login", "https://nposervices-onmicrosoft-com.access.mcas.ms:444/aad_login", "https://nposervices-onmicrosoft-com.access.mcas.ms/other", "https://nposervices-onmicrosoft-com.access.mcas.ms.evil.test/aad_login"])("rejects an unrelated or unsafe form target %s", (action) => {
    expect(() => mcasForm(form(action))).toThrow();
  });

  it("rejects multiple forms and missing tokens", () => {
    expect(() => mcasForm(form(gateway) + form(gateway))).toThrow();
    expect(() => mcasForm(form(gateway, ""))).toThrow();
    expect(() => mcasForm(form(gateway).replace('method="post"', 'method="get"'))).toThrow();
  });
});

describe("diagnostic authorization callbacks", () => {
  it("reads query and fragment code responses with the same state check", () => {
    expect(authorizationCode("https://teams.cloud.microsoft/v2/authv2?code=c&state=s", "s")).toBe("c");
    expect(authorizationCode("https://teams.cloud.microsoft/v2/authv2#code=c&state=s", "s")).toBe("c");
  });

  it("rejects a wrong state or unrelated callback", () => {
    expect(() => authorizationCode("https://teams.cloud.microsoft/v2/authv2#code=c&state=other", "s")).toThrow();
    expect(() => authorizationCode("https://other.test/v2/authv2?code=c&state=s", "s")).toThrow();
    expect(() => authorizationCode("https://teams.cloud.microsoft/other?code=c&state=s", "s")).toThrow();
  });
});

describe("MCAS Object Moved response", () => {
  it("takes only the observed proxied Teams redirect without executing script", () => {
    const html = '<title>Object Moved</title><script>window.location.replace("https://teams.cloud.microsoft.mcas.ms/?tenantId=tenant");</script>';
    expect(mcasMoved(html)).toBe("https://teams.cloud.microsoft.mcas.ms/?tenantId=tenant");
  });

  it.each(["https://other.test/", "http://teams.cloud.microsoft.mcas.ms/", "https://user@teams.cloud.microsoft.mcas.ms/", "https://teams.cloud.microsoft.mcas.ms:444/", "https://teams.cloud.microsoft.mcas.ms/other"])("rejects unexpected moved target %s", (url) => {
    expect(() => mcasMoved(`<title>Object Moved</title><script>window.location.replace(${JSON.stringify(url)});</script>`)).toThrow();
  });
});

describe("MCAS session context restoration", () => {
  const host = "nposervices-onmicrosoft-com.access.mcas.ms";
  const finish = `https://${host}/finalize_login?lfqs=signed-context`;
  const restore = `https://inline.cdn.mcas.ms/proxyweb/1.67.98/html/session-context-restore.html#action=post&redirect_uri=${encodeURIComponent(finish)}`;

  it("models the published post action with empty client session storage", () => {
    expect(mcasRestore(restore, host)).toEqual({ action: finish, fields: { contextData: "" } });
  });

  it("preserves the actual client URL and timestamp context when supplied", () => {
    const context = JSON.stringify({ context: [{ type: "sessionStorage", name: "cxtrestore_url", value: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s" }, { type: "sessionStorage", name: "cxtrestore_time", value: "1000" }] });
    expect(mcasRestore(restore, host, context)).toEqual({ action: finish, fields: { contextData: context } });
  });

  it("rejects unrelated CDN pages, gateway changes and unsupported actions", () => {
    expect(() => mcasRestore(restore.replace("inline.cdn.mcas.ms", "other.test"), host)).toThrow();
    expect(() => mcasRestore(restore.replace("action=post", "action=store"), host)).toThrow();
    expect(() => mcasRestore(restore, "other.access.mcas.ms")).toThrow();
    expect(() => mcasRestore(restore.replace("1.67.98", "unknown"), host)).toThrow();
  });
});

describe("MCAS monitored-session continuation", () => {
  const page = (overrides: Record<string, unknown> = {}) => `<script>var context = ${JSON.stringify({ TITLE_ID: "PROXYWEB_MONITORED_ACCESS_MESSAGE", DESCRIPTION_ID: "PROXYWEB_MONITORED_ACCESS_DESCRIPTION", DISPLAY_DISCLAIMER: true, REDIRECT_TO_SUFFIX_METHOD: "POST", REDIRECT_TO_SUFFIX_URL: gateway, ADDITIONAL_HIDDEN_FIELDS: '<input type="hidden" name="id_token" value="a.b.c"><input type="hidden" name="appLoginCookies" value=""><input type="hidden" name="contextData" value="">', ...overrides })};</script>`;

  it("continues the normal monitored session without bypass or optional recording fields", () => {
    expect(mcasContinuation(page())).toEqual({ action: gateway, fields: { id_token: "a.b.c", appLoginCookies: "", contextData: "", continueToSessionControl: "true", isTopFrame: "true", jsNativeBrokerMainWindowDomain: "" } });
  });

  it.each([{ WAIT_FOR_APP_ONBOARDING: true }, { APP_ONBOARDING_SHOW_CONTINUE: true }, { BYPASS_NON_SUFFIX_SUPPORTED_APP_FOR_ADMIN: true }, { SECOND_LOGIN_INFORMATION_PAGE_ENABLED: true }, { TITLE_ID: "OTHER_PAGE" }, { CUSTOMIZED_BODY: "new terms" }, { REDIRECT_TO_SUFFIX_URL: "https://other.test/aad_login" }])("rejects unsupported interstitials %j", (overrides) => {
    expect(() => mcasContinuation(page(overrides))).toThrow();
  });

  it("rejects hidden fields requesting a session-control bypass", () => {
    expect(() => mcasContinuation(page({ ADDITIONAL_HIDDEN_FIELDS: '<input type="hidden" name="id_token" value="a.b.c"><input type="hidden" name="requestBypass" value="true">' }))).toThrow();
  });
});
