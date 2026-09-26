import json, os, sqlite3, tempfile, time, unittest

TMP = tempfile.mkdtemp(prefix="teamsrelay-agent-test-")
os.environ["DB_PATH"] = os.path.join(TMP, "1", "messages.db")
os.environ["APP_DB"] = os.path.join(TMP, "app.db")
os.environ["ACCOUNT"] = "1"

import agent  # noqa: E402  (reads its paths from the environment at import)


def set_chats(*names):
    with sqlite3.connect(agent.DB_PATH) as c:
        c.execute("DELETE FROM chats")
        for i, n in enumerate(names):
            c.execute("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention) VALUES(?,?,?,?,?,?,?)", (n, "", i, 0, "", 0, 0))


class SameChat(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        agent.db_init()

    def test_equal_names(self):
        set_chats("Luca Bianchi")
        self.assertTrue(agent.same_chat("Luca Bianchi", "Luca Bianchi"))

    def test_empty_title(self):
        self.assertFalse(agent.same_chat("", "Luca Bianchi"))

    def test_other_chat_that_extends_the_name(self):
        set_chats("Luca Bianchini", "Luca Bianchi")
        self.assertFalse(agent.same_chat("Luca Bianchini", "Luca Bianchi"))
        self.assertFalse(agent.same_chat("Luca Bianchi", "Luca Bianchini"))

    def test_title_longer_than_stored_name(self):
        long_name = "Project " + "x" * 70
        set_chats(long_name[:60])
        self.assertTrue(agent.same_chat(long_name, long_name[:60]))

    def test_title_with_suffix_not_in_the_list(self):
        set_chats("Mario Rossi")
        self.assertTrue(agent.same_chat("Mario Rossi (External)", "Mario Rossi"))

    def test_unrelated_title(self):
        set_chats("Mario Rossi", "Anna Verdi")
        self.assertFalse(agent.same_chat("Anna Verdi", "Mario Rossi"))


class Page:
    def __init__(self, url):
        self.url = url


class Context:
    def __init__(self, *urls):
        self.pages = [Page(u) for u in urls]


class TeamsTab(unittest.TestCase):
    """Outside Edge, Defender for Cloud Apps proxies the session and appends its suffix to every host."""

    def test_teams_hosts(self):
        for url in ("https://teams.microsoft.com/v2/", "https://teams.cloud.microsoft/", "https://teams.live.com/v2/"):
            self.assertTrue(agent.is_teams(Page(url)), url)

    def test_teams_behind_the_cloud_apps_proxy(self):
        for url in ("https://teams.cloud.microsoft.mcas.ms/", "https://teams.microsoft.com.mcas-gov.us/v2/",
                    "https://teams.cloud.microsoft.mcas-gov.ms/v2/?McasCtx=4&McasTsid=28"):
            self.assertTrue(agent.is_teams(Page(url)), url)

    def test_other_pages(self):
        for url in ("https://teams.microsoft.com/v2/serviceworker.js", "https://teams.microsoft.com.example.net/",
                    "https://outlook.office.com.mcas.ms/mail/", "chrome://newtab/"):
            self.assertFalse(agent.is_teams(Page(url)), url)

    def test_teams_tab_wins_over_the_login_tab(self):
        ctx = Context("https://login.microsoftonline.com/common/oauth2/authorize", "https://teams.cloud.microsoft.mcas.ms/")
        self.assertEqual(agent.teams_page(ctx).url, "https://teams.cloud.microsoft.mcas.ms/")

    def test_login_tab_while_signing_in(self):
        ctx = Context("chrome://newtab/", "https://login.microsoftonline.com/common/oauth2/authorize")
        self.assertEqual(agent.teams_page(ctx).url, "https://login.microsoftonline.com/common/oauth2/authorize")


class Parking(unittest.TestCase):
    """The Teams page counts as seen by the user: while the app shows no chat, Teams stays on the self chat."""

    SELF = "Mario Rossi (You)"

    @classmethod
    def setUpClass(cls):
        agent.db_init()

    def viewing(self, chat, age):
        return json.dumps({"chat": chat, "ts": int(time.time()) - age})

    def test_chat_on_screen_in_the_app(self):
        self.assertEqual(agent.wanted_chat("Anna Verdi", self.viewing("Anna Verdi", 10), time.time(), self.SELF), "Anna Verdi")

    def test_nobody_looking_for_a_while(self):
        self.assertEqual(agent.wanted_chat("Anna Verdi", self.viewing("Anna Verdi", agent.PARK_AFTER + 5), time.time(), self.SELF), self.SELF)

    def test_never_looked_at(self):
        self.assertEqual(agent.wanted_chat("Anna Verdi", "", time.time(), self.SELF), self.SELF)
        self.assertEqual(agent.wanted_chat("Anna Verdi", "{", time.time(), self.SELF), self.SELF)

    def test_no_chat_opened_yet(self):
        self.assertEqual(agent.wanted_chat("", "", time.time(), self.SELF), self.SELF)

    def test_without_a_self_chat_the_open_one_stays(self):
        self.assertEqual(agent.wanted_chat("Anna Verdi", "", time.time(), ""), "Anna Verdi")

    def test_self_chat_found_in_the_list(self):
        set_chats("Anna Verdi", self.SELF, "Luca Bianchi")
        self.assertEqual(agent.self_chat(), self.SELF)
        set_chats("Anna Verdi")
        self.assertEqual(agent.self_chat(), "")


class OwnerPush(unittest.TestCase):
    """Slot 1 belongs to u1, slot 2 to u2: the agent of slot 1 notifies u1's devices only."""

    @classmethod
    def setUpClass(cls):
        agent.db_init()
        with sqlite3.connect(agent.APP_DB) as c:
            c.execute("CREATE TABLE IF NOT EXISTS teams_accounts(slot INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, added INTEGER NOT NULL)")
            c.execute("CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, sub TEXT NOT NULL, created INTEGER NOT NULL)")
            c.execute("DELETE FROM teams_accounts"); c.execute("DELETE FROM push_subscriptions")
            c.executemany("INSERT INTO teams_accounts VALUES(?,?,0)", [(1, "u1"), (2, "u2")])
            c.executemany("INSERT INTO push_subscriptions VALUES(?,?,?,0)",
                          [("https://push/u1-phone", "u1", "{}"), ("https://push/u1-pc", "u1", "{}"), ("https://push/u2-phone", "u2", "{}")])

    def test_targets_are_the_owner_devices(self):
        self.assertEqual(sorted(ep for ep, _ in agent.push_targets()), ["https://push/u1-pc", "https://push/u1-phone"])
        self.assertEqual(agent.push_count(), 2)

    def test_no_label_with_a_single_account(self):
        self.assertEqual(agent.acc_label(), "")

    def test_label_when_the_owner_has_more_accounts(self):
        with sqlite3.connect(agent.APP_DB) as c: c.execute("INSERT INTO teams_accounts VALUES(3, 'u1', 0)")
        agent.set_state("me", '{"tenant": "Contoso"}')
        try:
            self.assertEqual(agent.acc_label(), "Contoso")
        finally:
            with sqlite3.connect(agent.APP_DB) as c: c.execute("DELETE FROM teams_accounts WHERE slot=3")

    def test_app_db_tables_are_not_created_by_the_agent(self):
        with sqlite3.connect(agent.APP_DB) as c:
            tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn("push_subs", tables)


if __name__ == "__main__":
    unittest.main()
