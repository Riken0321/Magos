import json
import os
import platform
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional


MODIFIER_ORDER = ["ctrl", "shift", "alt", "cmd"]
MODIFIER_ALIASES = {
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "cmd": "cmd",
    "command": "cmd",
    "meta": "cmd",
    "super": "cmd",
    "win": "cmd",
    "windows": "cmd",
}
KEY_ALIASES = {
    "esc": "esc",
    "escape": "esc",
    "return": "enter",
    "enter": "enter",
    "space": "space",
    "spacebar": "space",
    "tab": "tab",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "insert": "insert",
    "home": "home",
    "end": "end",
    "pageup": "pageup",
    "pagedown": "pagedown",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _normalize_key_token(raw: str) -> str:
    token = str(raw or "").strip().lower()
    if not token:
        return ""

    if token in KEY_ALIASES:
        return KEY_ALIASES[token]

    if token.startswith("f") and token[1:].isdigit():
        idx = int(token[1:])
        if 1 <= idx <= 24:
            return f"f{idx}"

    if len(token) == 1:
        return token

    return token


def _token_from_char(char_value) -> str:
    if not isinstance(char_value, str) or not char_value:
        return ""

    # Ctrl+A..Ctrl+Z may arrive as ASCII control chars 0x01..0x1A.
    if len(char_value) == 1:
        code = ord(char_value)
        if 1 <= code <= 26:
            return chr(ord("a") + code - 1)
        if not char_value.isprintable():
            return ""

    return _normalize_key_token(char_value)


def _token_from_vk(vk_value) -> str:
    try:
        vk = int(vk_value)
    except Exception:
        return ""

    # A..Z
    if 65 <= vk <= 90:
        return chr(vk + 32)
    # 0..9
    if 48 <= vk <= 57:
        return chr(vk)
    # F1..F24
    if 112 <= vk <= 135:
        return f"f{vk - 111}"
    return ""


def _display_token(token: str) -> str:
    if len(token) == 1 and token.isalpha():
        return token.upper()
    mapping = {
        "esc": "Esc",
        "enter": "Enter",
        "space": "Space",
        "tab": "Tab",
        "backspace": "Backspace",
        "delete": "Delete",
        "insert": "Insert",
        "home": "Home",
        "end": "End",
        "pageup": "PageUp",
        "pagedown": "PageDown",
        "up": "Up",
        "down": "Down",
        "left": "Left",
        "right": "Right",
    }
    if token in mapping:
        return mapping[token]
    if token.startswith("f") and token[1:].isdigit():
        return token.upper()
    return token


def normalize_key_binding(raw_binding) -> Dict[str, object]:
    """
    Return normalized key binding payload:
    {
      normalized: "ctrl+q",
      display: "Ctrl+Q",
      modifiers: ["ctrl"],
      key: "q"
    }
    """
    if isinstance(raw_binding, dict):
        candidate = str(
            raw_binding.get("normalized")
            or raw_binding.get("display")
            or raw_binding.get("value")
            or ""
        ).strip()
    else:
        candidate = str(raw_binding or "").strip()

    if not candidate:
        raise ValueError("Key binding is required")

    raw_parts = [part for part in candidate.replace(" ", "").split("+") if part]
    if not raw_parts:
        raise ValueError("Invalid key binding")

    modifiers: List[str] = []
    modifier_set = set()
    key_token = ""
    for part in raw_parts:
        lower = part.lower()
        if lower in MODIFIER_ALIASES:
            mod = MODIFIER_ALIASES[lower]
            if mod not in modifier_set:
                modifier_set.add(mod)
                modifiers.append(mod)
            continue
        key_token = _normalize_key_token(part)

    if not key_token:
        # support candidate that only contains one token not mapped as modifier
        last_token = _normalize_key_token(raw_parts[-1])
        if last_token and raw_parts[-1].lower() not in MODIFIER_ALIASES:
            key_token = last_token

    if not key_token:
        raise ValueError("Key binding must contain a non-modifier key")

    ordered_mods = [mod for mod in MODIFIER_ORDER if mod in modifier_set]
    normalized = "+".join(ordered_mods + [key_token])
    display_parts = []
    for mod in ordered_mods:
        if mod == "ctrl":
            display_parts.append("Ctrl")
        elif mod == "shift":
            display_parts.append("Shift")
        elif mod == "alt":
            display_parts.append("Alt")
        elif mod == "cmd":
            display_parts.append("Cmd")
    display_parts.append(_display_token(key_token))

    return {
        "normalized": normalized,
        "display": "+".join(display_parts),
        "modifiers": ordered_mods,
        "key": key_token,
    }


@dataclass
class ShortcutAction:
    id: str
    name: str
    key_binding: Dict[str, object]
    actions: List[Dict[str, object]]
    execution_code: str
    created_at: str
    updated_at: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "key_binding": self.key_binding,
            "actions": self.actions,
            "execution_code": self.execution_code,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "ShortcutAction":
        return cls(
            id=str(data.get("id") or "").strip(),
            name=str(data.get("name") or "").strip(),
            key_binding=dict(data.get("key_binding") or {}),
            actions=list(data.get("actions") or []),
            execution_code=str(data.get("execution_code") or ""),
            created_at=str(data.get("created_at") or now_iso()),
            updated_at=str(data.get("updated_at") or now_iso()),
        )


class ShortcutActionRepository:
    def __init__(self, base_dir: str):
        self._lock = threading.Lock()
        self._store_path = self._resolve_store_path(base_dir)
        self._items: Dict[str, ShortcutAction] = {}
        self._load()

    @property
    def store_path(self) -> str:
        return self._store_path

    def _resolve_store_path(self, base_dir: str) -> str:
        candidates = []
        if getattr(sys, "frozen", False):
            exe_dir = os.path.dirname(getattr(sys, "executable", "") or "")
            if exe_dir:
                candidates.append(os.path.join(exe_dir, "magos_runtime"))

        candidates.append(os.path.join(base_dir, "runtime"))
        candidates.append(os.path.join(os.path.expanduser("~"), "magos_runtime"))
        candidates.append(os.path.join(os.getcwd(), "magos_runtime"))
        candidates.append(os.path.join(tempfile.gettempdir(), "magos_runtime"))

        for folder in candidates:
            if self._ensure_writable(folder):
                return os.path.join(folder, "shortcut_actions.json")
        raise RuntimeError("No writable runtime directory for shortcut actions")

    def _ensure_writable(self, folder: str) -> bool:
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, f".probe_{uuid.uuid4().hex}.tmp")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(probe)
            return True
        except Exception:
            return False

    def _load(self) -> None:
        with self._lock:
            self._items = {}
            if not os.path.exists(self._store_path):
                return
            try:
                with open(self._store_path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
            except Exception:
                return

            raw_items = []
            if isinstance(payload, dict):
                raw_items = payload.get("shortcut_actions") or []
            elif isinstance(payload, list):
                raw_items = payload

            for item in raw_items:
                if not isinstance(item, dict):
                    continue
                obj = ShortcutAction.from_dict(item)
                if not obj.id or not obj.name or not obj.execution_code:
                    continue
                try:
                    obj.key_binding = normalize_key_binding(obj.key_binding)
                except Exception:
                    continue
                self._items[obj.id] = obj

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._store_path), exist_ok=True)
        payload = {
            "version": 1,
            "shortcut_actions": [item.to_dict() for item in self._items.values()],
        }
        tmp_path = f"{self._store_path}.tmp.{uuid.uuid4().hex}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self._store_path)

    def list_items(self) -> List[ShortcutAction]:
        with self._lock:
            return [ShortcutAction.from_dict(item.to_dict()) for item in self._items.values()]

    def get_item(self, shortcut_id: str) -> Optional[ShortcutAction]:
        sid = str(shortcut_id or "").strip()
        if not sid:
            return None
        with self._lock:
            item = self._items.get(sid)
            return ShortcutAction.from_dict(item.to_dict()) if item else None

    def find_by_binding(self, normalized_binding: str) -> Optional[ShortcutAction]:
        target = str(normalized_binding or "").strip().lower()
        if not target:
            return None
        with self._lock:
            for item in self._items.values():
                kb = item.key_binding or {}
                if str(kb.get("normalized") or "").lower() == target:
                    return ShortcutAction.from_dict(item.to_dict())
        return None

    def create_item(
        self,
        name: str,
        key_binding,
        actions: List[Dict[str, object]],
        execution_code: str,
    ) -> ShortcutAction:
        shortcut_name = str(name or "").strip()
        if not shortcut_name:
            raise ValueError("Shortcut action name is required")
        if len(shortcut_name) > 64:
            raise ValueError("Shortcut action name is too long (max 64 chars)")

        code = str(execution_code or "")
        if not code.strip():
            raise ValueError("Execution code is required")

        kb = normalize_key_binding(key_binding)
        normalized = str(kb.get("normalized") or "")
        with self._lock:
            for item in self._items.values():
                exists = str(item.key_binding.get("normalized") or "")
                if exists == normalized:
                    raise ValueError("Key binding already exists")

            shortcut_id = uuid.uuid4().hex
            now = now_iso()
            normalized_actions = []
            for action in actions or []:
                if not isinstance(action, dict):
                    continue
                normalized_actions.append(
                    {
                        "type": str(action.get("type") or "action"),
                        "label": str(action.get("label") or action.get("raw") or ""),
                        "raw": str(action.get("raw") or ""),
                    }
                )

            item = ShortcutAction(
                id=shortcut_id,
                name=shortcut_name,
                key_binding=kb,
                actions=normalized_actions,
                execution_code=code,
                created_at=now,
                updated_at=now,
            )
            self._items[shortcut_id] = item
            self._save()
            return ShortcutAction.from_dict(item.to_dict())

    def delete_item(self, shortcut_id: str) -> bool:
        sid = str(shortcut_id or "").strip()
        if not sid:
            return False
        with self._lock:
            if sid not in self._items:
                return False
            self._items.pop(sid, None)
            self._save()
            return True

    def update_bindings(self, shortcut_id: str, key_binding) -> ShortcutAction:
        sid = str(shortcut_id or "").strip()
        if not sid:
            raise ValueError("Invalid shortcut id")
        kb = normalize_key_binding(key_binding)
        with self._lock:
            target = self._items.get(sid)
            if not target:
                raise ValueError("Shortcut action not found")
            for item in self._items.values():
                if item.id == sid:
                    continue
                if str(item.key_binding.get("normalized") or "") == kb["normalized"]:
                    raise ValueError("Key binding already exists")
            target.key_binding = kb
            target.updated_at = now_iso()
            self._save()
            return ShortcutAction.from_dict(target.to_dict())


class GlobalShortcutListener:
    """
    Cross-platform global shortcut listener based on pynput.
    Requires Accessibility permission on macOS.
    """

    def __init__(
        self,
        on_trigger: Callable[[str], None],
        debounce_sec: float = 0.35,
    ):
        self._on_trigger = on_trigger
        self._debounce_sec = max(0.0, float(debounce_sec))
        self._listener = None
        self._running = False
        self._lock = threading.Lock()
        self._bindings = set()
        self._pressed_modifiers = set()
        self._last_trigger_at: Dict[str, float] = {}
        self._last_error = ""

    @property
    def last_error(self) -> str:
        return self._last_error

    @property
    def running(self) -> bool:
        return self._running

    def update_bindings(self, bindings: Iterable[str]) -> None:
        normalized = set()
        for item in bindings or []:
            text = str(item or "").strip().lower()
            if text:
                normalized.add(text)
        with self._lock:
            self._bindings = normalized

    def start(self, bindings: Iterable[str]) -> bool:
        self.update_bindings(bindings)
        _inject_local_vendor_path()
        try:
            from pynput import keyboard
        except Exception as e:
            self._last_error = f"pynput unavailable: {e}"
            self._running = False
            return False

        try:
            self._listener = keyboard.Listener(
                on_press=self._on_press,
                on_release=self._on_release,
            )
            self._listener.daemon = True
            self._listener.start()
            self._running = True
            self._last_error = ""
            return True
        except Exception as e:
            self._listener = None
            self._running = False
            self._last_error = str(e)
            return False

    def stop(self) -> None:
        if self._listener:
            try:
                self._listener.stop()
            except Exception:
                pass
        self._listener = None
        self._running = False

    def _compose_binding(self, key_token: str) -> str:
        ordered_mods = [m for m in MODIFIER_ORDER if m in self._pressed_modifiers]
        return "+".join(ordered_mods + [key_token])

    def _on_press(self, key) -> None:
        token = self._key_to_token(key)
        if not token:
            return

        if token in {"ctrl", "shift", "alt", "cmd"}:
            self._pressed_modifiers.add(token)
            return

        binding = self._compose_binding(token)
        now_ts = time.monotonic()
        if self._debounce_sec > 0:
            last_ts = self._last_trigger_at.get(binding, 0.0)
            if now_ts - last_ts < self._debounce_sec:
                return

        with self._lock:
            if binding not in self._bindings:
                return

        self._last_trigger_at[binding] = now_ts
        try:
            self._on_trigger(binding)
        except Exception:
            pass

    def _on_release(self, key) -> None:
        token = self._key_to_token(key)
        if token in {"ctrl", "shift", "alt", "cmd"}:
            self._pressed_modifiers.discard(token)

    def _key_to_token(self, key) -> str:
        try:
            from pynput import keyboard
        except Exception:
            return ""

        # KeyCode path
        char = getattr(key, "char", None)
        token = _token_from_char(char)
        if token:
            return token

        # Some platforms/combos only expose vk for KeyCode.
        vk = getattr(key, "vk", None)
        token = _token_from_vk(vk)
        if token:
            return token

        # Key path
        if not isinstance(key, keyboard.Key):
            return ""

        key_map = {
            keyboard.Key.ctrl: "ctrl",
            keyboard.Key.ctrl_l: "ctrl",
            keyboard.Key.ctrl_r: "ctrl",
            keyboard.Key.shift: "shift",
            keyboard.Key.shift_l: "shift",
            keyboard.Key.shift_r: "shift",
            keyboard.Key.alt: "alt",
            keyboard.Key.alt_l: "alt",
            keyboard.Key.alt_r: "alt",
            keyboard.Key.alt_gr: "alt",
            keyboard.Key.cmd: "cmd",
            keyboard.Key.cmd_l: "cmd",
            keyboard.Key.cmd_r: "cmd",
            keyboard.Key.esc: "esc",
            keyboard.Key.enter: "enter",
            keyboard.Key.space: "space",
            keyboard.Key.tab: "tab",
            keyboard.Key.backspace: "backspace",
            keyboard.Key.delete: "delete",
            keyboard.Key.insert: "insert",
            keyboard.Key.home: "home",
            keyboard.Key.end: "end",
            keyboard.Key.page_up: "pageup",
            keyboard.Key.page_down: "pagedown",
            keyboard.Key.up: "up",
            keyboard.Key.down: "down",
            keyboard.Key.left: "left",
            keyboard.Key.right: "right",
        }
        if key in key_map:
            return key_map[key]

        name = str(key).replace("Key.", "").strip().lower()
        return _normalize_key_token(name)


def macos_accessibility_hint() -> str:
    if platform.system().lower() != "darwin":
        return ""
    return "macOS requires Accessibility permission for global shortcuts."


def _inject_local_vendor_path() -> None:
    try:
        current_file = Path(__file__).resolve()
        candidates = [
            current_file.parent.parent.parent / "_vendor",  # .../MagoSever_V3/_vendor
            Path.cwd() / "_vendor",
        ]
        for candidate in candidates:
            if not candidate.exists() or not candidate.is_dir():
                continue
            candidate_text = str(candidate)
            if candidate_text not in sys.path:
                sys.path.insert(0, candidate_text)
    except Exception:
        pass
