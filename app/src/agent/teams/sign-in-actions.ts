import type { Page } from "playwright-core";
import { cdpClick, ownerInput, withInput } from "./input";
import { watchInput } from "./scripts/page-state";
import { signInPage } from "./scripts/sign-in";
import { SEL, TEXTS } from "./selectors";

// Teams' own Sign in while Teams says to sign in again: one real click (its popup opens only for a trusted click).
// False when Teams does not say it, or shows none or several, or all of it is covered.
export async function pressTeamsSignIn(page: Page): Promise<boolean> {
  return withInput(page, async () => {
    const at = (await page.evaluate(signInPage, { s: SEL, t: TEXTS }).catch(() => null))?.teams.at;
    if (!at) return false;
    await cdpClick(page, at);
    return true;
  });
}

// What became of Microsoft's page: asks, a field to type in (nothing pressed); owner, the owner's input on it (nothing
// pressed); account or button, pressed; null, nothing to press yet (loading, redirecting, or first seen).
export type MicrosoftPress = "asks" | "owner" | "account" | "button";

// Microsoft's sign-in page: the tile of this account, else its one Sign in or Continue, with one real click. The page
// is watched for the owner's input from the first look on, and pressed at a later one only, when no input of the owner
// came meanwhile: someone signing in there by hand keeps it.
export async function pressMicrosoft(page: Page, email: string): Promise<MicrosoftPress | null> {
  if ((await page.evaluate(watchInput).catch(() => null)) !== "already") return null;
  return withInput(page, async () => {
    const owner = await ownerInput(page).catch(() => []);
    if (owner.length) return "owner";
    const r = (await page.evaluate(signInPage, { s: SEL, t: TEXTS, email }).catch(() => null))?.microsoft;
    if (!r) return null;
    if (r.asks) return "asks";
    const at = r.account ?? r.button;
    if (!at) return null;
    await cdpClick(page, at);
    return r.account ? "account" : "button";
  });
}
