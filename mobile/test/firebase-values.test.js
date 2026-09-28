import assert from "node:assert/strict";
import { test } from "node:test";
import { firebaseValues } from "../scripts/firebase-values.mjs";

// google-services.json as the Firebase console gives it, with a second Android app of the same project (values made up)
const json = JSON.stringify({
  project_info: { project_number: "123456789012", project_id: "teamsrelay-test", storage_bucket: "teamsrelay-test.firebasestorage.app" },
  client: [
    {
      client_info: { mobilesdk_app_id: "1:123456789012:android:0000", android_client_info: { package_name: "com.example.other" } },
      api_key: [{ current_key: "other-key" }],
    },
    {
      client_info: { mobilesdk_app_id: "1:123456789012:android:abcd", android_client_info: { package_name: "io.github.aptul9.teamsrelay" } },
      oauth_client: [],
      api_key: [{ current_key: "AIzaTestKey<&>" }],
    },
  ],
  configuration_version: "1",
});

test("writes the values of the TeamsRelay app, as the Firebase SDK reads them", () => {
  const xml = firebaseValues(json);
  assert.match(xml, /<string name="google_app_id" translatable="false">1:123456789012:android:abcd<\/string>/);
  assert.match(xml, /<string name="gcm_defaultSenderId" translatable="false">123456789012<\/string>/);
  assert.match(xml, /<string name="google_api_key" translatable="false">AIzaTestKey&lt;&amp;&gt;<\/string>/);
  assert.match(xml, /<string name="project_id" translatable="false">teamsrelay-test<\/string>/);
  assert.doesNotMatch(xml, /other/);
});

test("refuses a file without the app, or without one of the values", () => {
  assert.throws(() => firebaseValues(json, "io.example.missing"), /no Android app io.example.missing/);
  const noKey = JSON.parse(json);
  noKey.client[1].api_key = [];
  assert.throws(() => firebaseValues(JSON.stringify(noKey)), /google_api_key/);
});
