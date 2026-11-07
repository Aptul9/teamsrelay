import { describe, expect, it } from "vitest";
import * as forms from "../../scripts/mcas-auth-forms.mjs";
import * as probe from "../../scripts/mcas-auth-probe.mjs";

const { bootstrapUrl, configuration } = forms;
const origin = "https://teams.cloud.microsoft.mcas.ms";
const bootstrap = "https://mcas-proxyweb.mcas.ms/js-bootstrap.js";
const script = (src: string) => `<script defer src="${src}"></script>`;

describe("shared MCAS form parsers", () => {
  it.each(["mcasForm", "mcasContinuation", "mcasRestore", "mcasMoved", "authorizationCode", "configuration", "bootstrapUrl"] as const)("preserves the diagnostic export %s", (name) => {
    expect(typeof forms[name]).toBe("function");
    expect(probe[name]).toBe(forms[name]);
  });
});

describe("literal MCAS configuration", () => {
  it("extracts the login assignment with whitespace around its operator", () => {
    expect(configuration('<script>var $Config \n = \t {"url":"https://login.microsoftonline.com","nested":{"items":[1,true,null]}};</script>', "$Config")).toEqual({ url: "https://login.microsoftonline.com", nested: { items: [1, true, null] } });
  });

  it("extracts the wrapper call with whitespace before its parenthesis", () => {
    expect(configuration('__JSWRAPPER.initWrapperFixer \n ( {"enabled":true} );', "__JSWRAPPER.initWrapperFixer")).toEqual({ enabled: true });
  });

  it("balances nested braces while respecting escaped strings", () => {
    const value = { nested: { text: 'escaped quote: " and backslash: \\ and braces: } {', items: [{ key: "}" }] } };
    expect(configuration(`$Config=${JSON.stringify(value)};`, "$Config")).toEqual(value);
  });

  it.each([
    "",
    '$Config = {"incomplete":true;',
    '$Config = {"unterminated":"};',
    "$Config = {'singleQuoted':true};",
    "$Config = {unquoted:true};",
    '$Config = {"trailing":true,};',
    '$Config = {"value":undefined};',
    '$Config = {"value":(()=>{throw new Error("injection")})()};',
    '$Config = JSON.parse("{}");',
    '$Config = {"value":1} || globalThis.injected();',
    '$Config = [{"array":true}];',
    "$Config = null;",
    "$Config = true;",
    '$Config = "text";',
    '$Config == {"comparison":true};',
    '$ConfigOther = {"prefix":true};',
  ])("rejects missing or non-JSON assignment %s", (source) => {
    expect(() => configuration(source, "$Config")).toThrow();
  });

  it.each([
    '__JSWRAPPER.initWrapperFixer({"value":1}, {"extra":true});',
    '__JSWRAPPER.initWrapperFixer({"value":1} || injected());',
    '__JSWRAPPER.initWrapperFixer({"value":1};',
  ])("rejects a wrapper argument that is not one literal object %s", (source) => {
    expect(() => configuration(source, "__JSWRAPPER.initWrapperFixer")).toThrow();
  });

  it.each([
    ["$Config", '$Config={"one":1};\n$Config = {"two":2};'],
    ["$Config", '$Config=invalid;\n$Config={"valid":true};'],
    ["__JSWRAPPER.initWrapperFixer", '__JSWRAPPER.initWrapperFixer({"one":1});\n__JSWRAPPER.initWrapperFixer ({"two":2});'],
  ])("rejects duplicate markers for %s", (marker, source) => {
    expect(() => configuration(source, marker)).toThrow();
  });

  it("rejects unknown markers", () => {
    expect(() => configuration('other={"value":1};', "other")).toThrow();
  });

  it("does not execute JavaScript supplied in place of a JSON value", () => {
    const target = globalThis as typeof globalThis & { __mcasConfigurationInjected?: boolean };
    try {
      expect(() => configuration('$Config={"value":(globalThis.__mcasConfigurationInjected=true)};', "$Config")).toThrow();
      expect(target.__mcasConfigurationInjected).toBeUndefined();
    } finally {
      delete target.__mcasConfigurationInjected;
    }
  });

  it("bounds source to two MiB of UTF-8 text", () => {
    const prefix = "$Config={};";
    expect(configuration(prefix + " ".repeat(2 * 1024 * 1024 - prefix.length), "$Config")).toEqual({});
    expect(() => configuration(prefix + " ".repeat(2 * 1024 * 1024), "$Config")).toThrow();
    expect(() => configuration(prefix + "é".repeat(1024 * 1024), "$Config")).toThrow();
  });
});

describe("MCAS bootstrap script URL", () => {
  it("returns null when no bootstrap script exists", () => {
    expect(bootstrapUrl("<html></html>", origin)).toBeNull();
    expect(bootstrapUrl('<script>const src="https://mcas-proxyweb.mcas.ms/js-bootstrap.js";</script>', origin)).toBeNull();
    expect(bootstrapUrl(script("https://other.test/application.js"), origin)).toBeNull();
    expect(bootstrapUrl('<script data-src="https://mcas-proxyweb.mcas.ms/js-bootstrap.js"></script>', origin)).toBeNull();
  });

  it("extracts a unique URL from raw HTML without execution", () => {
    expect(bootstrapUrl(`<html>${script("https://other.test/application.js")}${script(bootstrap)}</html>`, origin)).toBe(bootstrap);
  });

  it("resolves script URLs against the supplied origin", () => {
    expect(bootstrapUrl(script("/js-bootstrap.js?version=1"), "https://mcas-proxyweb.mcas.ms")).toBe(`${bootstrap}?version=1`);
    expect(bootstrapUrl(script("//mcas-proxyweb.mcas.ms/js-bootstrap.js"), origin)).toBe(bootstrap);
  });

  it("decodes named and numeric attribute entities", () => {
    expect(bootstrapUrl('<SCRIPT SRC=\'https&#58;//mcas-proxyweb.mcas.ms/js-bootstrap.js?a=1&amp;b=&#x32;\'></SCRIPT>', origin)).toBe(`${bootstrap}?a=1&b=2`);
  });

  it("reads unquoted script attributes without treating attribute contents as src", () => {
    expect(bootstrapUrl(`<script defer src=${bootstrap}></script>`, origin)).toBe(bootstrap);
    expect(bootstrapUrl(`<script data-note="src='${bootstrap}'"></script>`, origin)).toBeNull();
  });

  it("ignores scripts inside HTML comments or inline script text", () => {
    expect(bootstrapUrl(`<!-- ${script(bootstrap)} -->`, origin)).toBeNull();
    expect(bootstrapUrl(`<script>const text = ${JSON.stringify(script(bootstrap))};</script>`, origin)).toBeNull();
  });

  it("accepts repeated identical URLs and the default HTTPS port", () => {
    expect(bootstrapUrl(script(bootstrap) + script(bootstrap.replace(".ms/", ".ms:443/")), origin)).toBe(bootstrap);
  });

  it.each([
    "https://other.test/js-bootstrap.js",
    "https://mcas-proxyweb.mcas.ms.other.test/js-bootstrap.js",
    "http://mcas-proxyweb.mcas.ms/js-bootstrap.js",
    "https://user@mcas-proxyweb.mcas.ms/js-bootstrap.js",
    "https://user:password@mcas-proxyweb.mcas.ms/js-bootstrap.js",
    "https://mcas-proxyweb.mcas.ms:444/js-bootstrap.js",
    "https://mcas-proxyweb.mcas.ms/other.js",
    "https://mcas-proxyweb.mcas.ms/nested/js-bootstrap.js",
  ])("rejects an unapproved bootstrap target %s", (url) => {
    expect(() => bootstrapUrl(script(url), origin)).toThrow();
  });

  it("rejects distinct bootstrap matches", () => {
    expect(() => bootstrapUrl(script(`${bootstrap}?version=1`) + script(`${bootstrap}?version=2`), origin)).toThrow();
  });
});
