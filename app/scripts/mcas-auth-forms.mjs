import assert from "node:assert/strict";

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
const decode = (s) => s.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_, hex, decimal, name) => name ? ENTITIES[name.toLowerCase()] : String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/\b([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [m[1].toLowerCase(), decode(m[3])]));
const hiddenInputs = (html) => [...html.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => attributes(tag)).filter((input) => input.type?.toLowerCase() === "hidden");

function gatewayAction(value) {
  const action = new URL(value);
  assert(action.protocol === "https:" && !action.username && !action.password && (!action.port || action.port === "443") && /^[a-z0-9-]+\.access\.mcas\.ms$/i.test(action.hostname) && action.pathname === "/aad_login", "unexpected MCAS form destination");
  return action.href;
}

export function mcasForm(html) {
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)];
  assert.equal(forms.length, 1, "one MCAS form required");
  const form = attributes(forms[0][0].slice(0, forms[0][0].indexOf(">") + 1));
  assert.equal(form.method?.toLowerCase(), "post", "MCAS form must use POST");
  const action = gatewayAction(form.action);
  const tokens = hiddenInputs(forms[0][1]).filter((input) => input.name === "id_token");
  assert(tokens.length === 1 && tokens[0].value && tokens[0].value.length < 30000, "one MCAS id_token required");
  return { action, idToken: tokens[0].value };
}

export function mcasContinuation(html) {
  let c;
  try { c = JSON.parse(html.match(/var context\s*=\s*(\{[\s\S]*?\});/)?.[1] ?? ""); } catch { throw new Error("invalid MCAS continuation context"); }
  assert(c.TITLE_ID === "PROXYWEB_MONITORED_ACCESS_MESSAGE" && c.DESCRIPTION_ID === "PROXYWEB_MONITORED_ACCESS_DESCRIPTION" && c.DISPLAY_DISCLAIMER === true && !c.CUSTOMIZED_TITLE && !c.CUSTOMIZED_BODY && !c.WAIT_FOR_APP_ONBOARDING && !c.APP_ONBOARDING_SHOW_CONTINUE && !c.BYPASS_NON_SUFFIX_SUPPORTED_APP_FOR_ADMIN && !c.SECOND_LOGIN_INFORMATION_PAGE_ENABLED, "unsupported MCAS interstitial");
  assert.equal(c.REDIRECT_TO_SUFFIX_METHOD, "POST", "MCAS continuation must use POST");
  const inputs = hiddenInputs(c.ADDITIONAL_HIDDEN_FIELDS ?? "");
  assert(inputs.length > 0 && inputs.every((input) => ["id_token", "appLoginCookies", "contextData"].includes(input.name)), "unsupported MCAS continuation field");
  const fields = Object.fromEntries(inputs.map((input) => [input.name, input.value ?? ""]));
  assert(fields.id_token && new Set(inputs.map((input) => input.name)).size === inputs.length, "one MCAS id_token required");
  return { action: gatewayAction(c.REDIRECT_TO_SUFFIX_URL), fields: { ...fields, continueToSessionControl: "true", isTopFrame: "true", jsNativeBrokerMainWindowDomain: "" } };
}

export function mcasRestore(value, gateway, contextData = "") {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname === "inline.cdn.mcas.ms" && url.pathname === "/proxyweb/1.67.98/html/session-context-restore.html", "unexpected MCAS context-restorer");
  const params = new URLSearchParams(url.hash.slice(1));
  assert(params.get("action") === "post" && params.getAll("action").length === 1 && params.getAll("redirect_uri").length === 1, "unsupported MCAS context-restorer action");
  const target = new URL(params.get("redirect_uri"));
  assert(target.protocol === "https:" && !target.username && !target.password && !target.port && target.hostname === gateway && target.pathname === "/finalize_login", "unexpected MCAS context-restorer target");
  return { action: target.href, fields: { contextData } };
}

export function mcasMoved(html) {
  assert(/<title>\s*Object Moved\s*<\/title>/i.test(html), "unexpected MCAS moved response");
  const matches = [...html.matchAll(/window\.location\.replace\(\s*("(?:\\.|[^"\\])*")\s*\)/g)];
  assert.equal(matches.length, 1, "one literal MCAS redirect required");
  const url = new URL(JSON.parse(matches[0][1]));
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && ["teams.cloud.microsoft.mcas.ms", "teams.microsoft.com.mcas.ms"].includes(url.hostname) && url.pathname === "/", "unexpected MCAS moved destination");
  return url.href;
}

export function authorizationCode(value, expectedState) {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && ["teams.cloud.microsoft", "teams.cloud.microsoft.mcas.ms", "teams.microsoft.com.mcas.ms"].includes(url.hostname) && url.pathname === "/v2/authv2", "unexpected authorization callback");
  const params = url.searchParams.has("code") ? url.searchParams : new URLSearchParams(url.hash.slice(1));
  assert(params.get("state") === expectedState, "authorization state mismatch");
  assert(params.get("code"), "authorization code missing");
  return params.get("code");
}

export function configuration(source, marker) {
  assert(typeof source === "string" && Buffer.byteLength(source, "utf8") <= 2 * 1024 * 1024, "configuration source exceeds two MiB");
  const pattern = marker === "$Config" ? /(?<![\w$.])\$Config\s*=(?!=|>)/g : marker === "__JSWRAPPER.initWrapperFixer" ? /(?<![\w$.])__JSWRAPPER\.initWrapperFixer\s*\(/g : null;
  assert(pattern, "unsupported configuration marker");
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, "one configuration marker required");
  let start = matches[0].index + matches[0][0].length;
  while (/\s/.test(source[start] ?? "")) start++;
  assert.equal(source[start], "{", "configuration must be a JSON object");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const tail = source.slice(i + 1).trimStart();
      assert(marker === "$Config" ? !tail || tail.startsWith(";") || /^<\/script\s*>/i.test(tail) : tail.startsWith(")"), "configuration must be one JSON object");
      return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new Error("invalid configuration JSON object");
}

export function bootstrapUrl(html, origin) {
  const urls = new Set();
  for (const [, tag] of html.matchAll(/<!--[\s\S]*?-->|(<script\b(?:[^"'<>]|"[^"]*"|'[^']*')*>)(?:[\s\S]*?<\/script\s*>|$)/gi)) {
    if (!tag) continue;
    const attribute = [...tag.matchAll(/\s+([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g)].find((m) => m[1].toLowerCase() === "src");
    const src = attribute ? decode(attribute[2] ?? attribute[3] ?? attribute[4]) : "";
    if (!src) continue;
    const url = new URL(src, origin);
    if (!url.pathname.endsWith("/js-bootstrap.js") && url.hostname !== "mcas-proxyweb.mcas.ms") continue;
    assert(url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname === "mcas-proxyweb.mcas.ms" && url.pathname === "/js-bootstrap.js", "unexpected MCAS bootstrap destination");
    urls.add(url.href);
  }
  assert(urls.size <= 1, "one MCAS bootstrap URL required");
  return urls.values().next().value ?? null;
}
