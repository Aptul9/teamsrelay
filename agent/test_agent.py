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


if __name__ == "__main__":
    unittest.main()
