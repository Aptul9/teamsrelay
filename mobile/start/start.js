// First page of the app, bundled with it: it keeps the address of the TeamsRelay server and opens it. The server
// page then runs in the app window as in a browser, signed in with its own session, without access to Tauri.
import { relayOrigin } from "./relay.js";

const KEY = "relay";
const $ = (id) => document.getElementById(id);

function saved() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

// After the form, Back from the server page comes here, where the address can be changed. The automatic open at
// start replaces this page: Chrome keeps no history entry for a page that leaves while it loads.
function open(origin, replace) {
  $("target").textContent = origin;
  $("opening").hidden = false;
  $("relay-form").hidden = true;
  if (replace) location.replace(origin + "/");
  else location.assign(origin + "/");
}

function showForm() {
  $("relay").value = saved();
  $("opening").hidden = true;
  $("relay-form").hidden = false;
}

$("relay-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const origin = relayOrigin($("relay").value);
  if (!origin) {
    $("error").textContent = "Enter the https:// address of your TeamsRelay server.";
    return;
  }
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // storage refused: the address lasts for this start
  }
  open(origin, false);
});
$("relay").addEventListener("input", () => ($("error").textContent = ""));

// Back from the server page, or #change: the form with the address in use; otherwise straight to the server
const back = performance.getEntriesByType("navigation")[0]?.type === "back_forward";
if (saved() && !back && location.hash !== "#change") open(saved(), true);
else showForm();
addEventListener("pageshow", (e) => e.persisted && showForm());
