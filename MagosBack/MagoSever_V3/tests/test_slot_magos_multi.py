"""多机槽位：SlotMagosMap 与 exec 环境路由（无 BLE 硬件）。"""
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from HttpServer.myFlask import SlotMagosMap


class _FakeMagos:
    def __init__(self, name):
        self.name = name


class SlotMagosMapTests(unittest.TestCase):
    def test_getitem_routes_per_slot(self):
        m = {"A": _FakeMagos("a"), "B": _FakeMagos("b")}
        sm = SlotMagosMap(m)
        self.assertIs(sm["A"], m["A"])
        self.assertIs(sm["b"], m["B"])  # 大小写不敏感

    def test_unknown_slot_keyerror(self):
        sm = SlotMagosMap({"A": _FakeMagos("a")})
        with self.assertRaises(KeyError):
            _ = sm["Z"]

    def test_exec_style_subscript_matches_generated_code(self):
        """与 Blockly 生成的 magos["A"].x 访问方式一致。"""
        calls = []

        class Track:
            def set_robot_server(self, i, a):
                calls.append(("A", i, a))

        sm = SlotMagosMap({"A": Track()})
        code = 'magos["A"].set_robot_server(0, 90)\n'
        env = {"magos": sm}
        exec(code, env, {})
        self.assertEqual(calls, [("A", 0, 90)])


if __name__ == "__main__":
    unittest.main()
