import tempfile
import unittest
from pathlib import Path

from HttpServer.mylib.ShortcutActions import (
    ShortcutActionRepository,
    _token_from_char,
    _token_from_vk,
    normalize_key_binding,
)


class ShortcutActionsTests(unittest.TestCase):
    def test_normalize_combination_key(self):
        binding = normalize_key_binding("Ctrl + Shift + Q")
        self.assertEqual(binding["normalized"], "ctrl+shift+q")
        self.assertEqual(binding["display"], "Ctrl+Shift+Q")
        self.assertEqual(binding["modifiers"], ["ctrl", "shift"])
        self.assertEqual(binding["key"], "q")

    def test_normalize_single_key(self):
        binding = normalize_key_binding("Escape")
        self.assertEqual(binding["normalized"], "esc")
        self.assertEqual(binding["display"], "Esc")

    def test_repository_rejects_duplicate_binding(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = ShortcutActionRepository(str(Path(temp_dir)))
            repo.create_item(
                name="A1",
                key_binding="Ctrl+Q",
                actions=[{"type": "motion", "label": "x", "raw": "x"}],
                execution_code='print("a1")',
            )
            with self.assertRaises(ValueError):
                repo.create_item(
                    name="A2",
                    key_binding="ctrl + q",
                    actions=[{"type": "motion", "label": "y", "raw": "y"}],
                    execution_code='print("a2")',
                )

    def test_repository_persistence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            repo = ShortcutActionRepository(str(base))
            created = repo.create_item(
                name="PersistCase",
                key_binding="Alt+F2",
                actions=[{"type": "python", "label": "hello", "raw": 'print("x")'}],
                execution_code='print("persist")',
            )

            repo_reload = ShortcutActionRepository(str(base))
            loaded = repo_reload.get_item(created.id)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.name, "PersistCase")
            self.assertEqual(loaded.key_binding.get("normalized"), "alt+f2")

    def test_ctrl_character_to_letter_token(self):
        self.assertEqual(_token_from_char("\x11"), "q")
        self.assertEqual(_token_from_char("\x01"), "a")

    def test_vk_to_token(self):
        self.assertEqual(_token_from_vk(81), "q")
        self.assertEqual(_token_from_vk(113), "f2")


if __name__ == "__main__":
    unittest.main()
