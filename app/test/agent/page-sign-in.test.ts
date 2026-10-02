// The sign-in screens as the agent reads them before its one press after a sign-out (jobs/sign-in.ts), in Chrome, on
// fixtures REBUILT BY HAND: none of these screens was ever read on an account here. Teams' own Sign in while Teams says
// to sign in again; on Microsoft's page this account's tile, or a lone Sign in or Continue; nothing on a page that asks
// for a field, nothing when two could be meant.
import { describe, expect, it } from "vitest";
import { signInPage } from "@/agent/teams/scripts/sign-in";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();
const EMAIL = "test.user@contoso.example";
// one page of the Microsoft sign-in, by the id of its template
const microsoft = (id: string) => fixture("sign-in-microsoft.html").match(new RegExp(`<template id="${id}">([\\s\\S]*?)</template>`))![1];
// the text of what a point of the page is: the button, tile or input found there
const hit = (at: { x: number; y: number } | null) =>
  chrome.page.evaluate((p) => {
    if (!p) return null;
    const e = document.elementFromPoint(p.x, p.y);
    const target = e && (e.closest('[role="button"],button,a,input') as HTMLElement | HTMLInputElement | null);
    if (!target) return null;
    return ((target as HTMLInputElement).value || target.getAttribute("data-test-id") || target.textContent || "").replace(/\s+/g, " ").trim();
  }, at);
const scan = (email = EMAIL) => chrome.page.evaluate(signInPage, { s: SEL, t: TEXTS, email });
const teams = async () => (await scan()).teams;
const onMicrosoft = async (email = EMAIL) => (await scan(email)).microsoft;
const visibleButtons = async () => (await scan()).buttons;

describe("Teams asking to sign in again", () => {
  it("gives a point of its one Sign in button", async () => {
    await chrome.page.setContent(fixture("sign-in-teams.html"));
    const r = await teams();
    expect(r).toMatchObject({ asks: true, found: 1 });
    expect(await hit(r.at)).toBe("Sign in");
  });

  it("gives nothing while Teams does not say to sign in again", async () => {
    await chrome.page.setContent(fixture("sign-in-teams.html").replace("We need you to sign in again.", "Welcome back."));
    expect(await teams()).toEqual({ asks: false, found: 1, at: null });
  });

  it("gives nothing with two Sign in buttons, or with its button all covered", async () => {
    await chrome.page.setContent(fixture("sign-in-teams.html").replace("</nav>", '<button type="button">Sign in</button></nav>'));
    expect(await teams()).toEqual({ asks: true, found: 2, at: null });
    await chrome.page.setContent(
      `<style>.banner button { width: 80px; height: 30px }</style>${fixture("sign-in-teams.html")}<div id="cover" style="position:fixed;inset:0;background:#fff"></div>`,
    );
    expect((await teams()).at).toBeNull();
  });
});

describe("the Microsoft sign-in page", () => {
  it("gives this account's tile of the account picker, never another account's nor Use another account", async () => {
    await chrome.page.setContent(microsoft("pick-account"));
    const r = await onMicrosoft();
    expect(r).toMatchObject({ asks: false, accounts: 1, button: null });
    expect(await hit(r.account)).toBe(EMAIL);
  });

  it("takes the email as a whole word: a longer email that holds it is another account", async () => {
    await chrome.page.setContent(microsoft("pick-account"));
    expect(await onMicrosoft("user@contoso.example")).toMatchObject({ accounts: 0, account: null });
    expect(await onMicrosoft("")).toMatchObject({ accounts: 0, account: null });
  });

  it("gives nothing on a page that asks for a password or a code", async () => {
    for (const id of ["password", "code"]) {
      await chrome.page.setContent(microsoft(id));
      expect(await onMicrosoft()).toEqual({ asks: true, accounts: 0, account: null, buttons: 0, button: null });
    }
  });

  it("gives the one Continue of a page that asks for nothing", async () => {
    await chrome.page.setContent(microsoft("continue"));
    const r = await onMicrosoft();
    expect(r).toMatchObject({ asks: false, accounts: 0, account: null, buttons: 1 });
    expect(await hit(r.button)).toBe("Continue");
  });

  it("gives nothing on Stay signed in, whose Yes and No are not a sign-in", async () => {
    await chrome.page.setContent(microsoft("stay-signed-in"));
    expect(await onMicrosoft()).toEqual({ asks: false, accounts: 0, account: null, buttons: 0, button: null });
  });

  it("gives nothing with two Continue", async () => {
    await chrome.page.setContent(microsoft("continue").replace("<a href=\"#\">Cancel</a>", "<button>Continue</button>"));
    expect(await onMicrosoft()).toMatchObject({ buttons: 2, button: null });
  });
});

describe("buttons of a page, for the log", () => {
  it("lists the buttons, tiles and links on screen by their text, once each", async () => {
    await chrome.page.setContent(microsoft("pick-account"));
    expect(await visibleButtons()).toEqual(["Test User test.user@contoso.example ...", "...", "Someone Else xtest.user@contoso.example", "Use another account"]);
    await chrome.page.setContent(microsoft("password"));
    expect(await visibleButtons()).toEqual(["Forgot my password", "Sign in"]);
  });
});
