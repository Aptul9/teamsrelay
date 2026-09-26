import os, sqlite3, tempfile, unittest

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
