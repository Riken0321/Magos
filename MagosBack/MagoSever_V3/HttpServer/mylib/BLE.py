# -*- coding: utf-8 -*-
import logging
import asyncio
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
import time
from datetime import datetime
import os
import shutil
import threading
import sys

# ====== 璁惧閰嶇疆 ======
# DEVICE_ADDR = "A0:DD:6C:86:47:C2"  # 鏇挎崲涓轰綘鐨凟SP32C3 MAC鍦板潃
NOTIFY_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  # 閫氱煡鐗瑰緛
WRITE_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  # 鍐欏叆鐗瑰緛
# 璁惧钃濈墮鍚嶇О
# DEVICE_NAME = "BLE_1"  # 鏇挎崲涓轰换鎰忚澶囧悕绉?
# ====== 鍗忚瀹氫箟 ======
HEADER = b"\xaa\x55"  # 甯уご
FOOTER = b"\x0d\x0a"  # 甯у熬


import json
from contextlib import nullcontext

_ble_logger = logging.getLogger(__name__)


class MusicManager:
    def __init__(self, data_json_path=None, slot_id="A", manifest_lock=None):
        self.data_json_path = data_json_path
        self.slot_id = str(slot_id or "A").strip().upper() or "A"
        self.manifest_lock = manifest_lock
        self.current_id_counter = 1
        self.music_list = []  # List of {'name':..., 'url':...}
        self.seen_names = set()
        
        # Fallback path if not provided
        if not self.data_json_path:
            self.data_json_path = self._default_manifest_path()

    def _default_manifest_path(self):
        http_server_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        static_path = os.path.join(http_server_dir, "static", "data.json")
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(http_server_dir)))
        runtime_path = os.path.join(repo_root, "magos_runtime", "data.json")

        candidates = []
        if getattr(sys, "frozen", False):
            # 与 Flask `_music_manifest_paths` 顺序一致；exe 旁文件由服务端启动时优先创建，避免写入 _MEI 临时目录。
            exe_dir = os.path.dirname(sys.executable)
            if exe_dir:
                candidates.append(os.path.join(exe_dir, "data.json"))
            candidates.append(runtime_path)
            candidates.append(static_path)
        else:
            candidates.append(static_path)
            candidates.append(runtime_path)

        for path in candidates:
            if os.path.exists(path):
                return path
        return candidates[0] if candidates else static_path

    def start_sync(self):
        """Reset for new sync session"""
        self.current_id_counter = 1
        self.music_list = []
        self.seen_names = set()
        print("[Music] Sync started. List reset.")
        # Write empty list immediately to clear frontend
        self.save_to_json()
        return self.music_list

    def _normalize_music_name(self, raw_name):
        clean_name = str(raw_name or "").strip()
        if clean_name.lower().endswith('.mp3'):
            clean_name = clean_name[:-4].strip()
        return clean_name

    def add_music(self, raw_name, auto_save=False):
        """Add music item with sequential ID"""
        if not raw_name:
            return self.music_list

        clean_name = self._normalize_music_name(raw_name)
        name_key = clean_name.lower()
        if not clean_name:
            return self.music_list

        # Dedup check by normalized music name (name-core strategy).
        if name_key in self.seen_names:
            print(f"[Music] Duplicate ignored by name: {clean_name}")
            return self.music_list

        self.seen_names.add(name_key)

        existing_ids = {
            int(str(item.get("url")))
            for item in self.music_list
            if isinstance(item, dict) and str(item.get("url", "")).isdigit()
        }

        # Always assign sequential IDs by receive order.
        # Do not derive ID from filename, even if filename is numeric.
        while self.current_id_counter in existing_ids:
            self.current_id_counter += 1
        music_id = str(self.current_id_counter)
        self.current_id_counter += 1
        
        # Add to list
        entry = {
            "name": clean_name,
            "url": music_id,
            # "filename": raw_name # Internal use only
        }
        self.music_list.append(entry)

        # Stabilize display/play order by numeric id to avoid tail swapping.
        self.music_list.sort(
            key=lambda item: int(str(item.get("url"))) if str(item.get("url", "")).isdigit() else 10**9
        )
        
        print(f"[Music] Added: {clean_name} (ID: {music_id})")
        
        if auto_save:
            self.save_to_json()
        return self.music_list

    def snapshot(self):
        return [dict(item) for item in self.music_list if isinstance(item, dict)]

    def save_to_json(self):
        """Atomic write to data.json"""
        try:
            lock_ctx = self.manifest_lock if self.manifest_lock is not None else nullcontext()
            with lock_ctx:
                existing_data = {}
                existing_music_map = {}
                if os.path.exists(self.data_json_path):
                    try:
                        with open(self.data_json_path, 'r', encoding='utf-8') as f:
                            existing_data = json.load(f)
                    except:
                        existing_data = {}

                if not isinstance(existing_data, dict):
                    existing_data = {}

                music_by_slot = existing_data.get("music_by_slot")
                if not isinstance(music_by_slot, dict):
                    music_by_slot = {}

                normalized_by_slot = {}
                for key, value in music_by_slot.items():
                    slot_key = str(key or "").strip().upper()
                    if not slot_key:
                        continue
                    normalized_by_slot[slot_key] = value if isinstance(value, list) else []
                music_by_slot = normalized_by_slot

                legacy_music = existing_data.get("music", [])
                if not isinstance(legacy_music, list):
                    legacy_music = []
                if self.slot_id not in music_by_slot and legacy_music:
                    # 兼容旧格式：默认将 legacy music 归入当前写入槽位。
                    music_by_slot[self.slot_id] = [dict(item) for item in legacy_music if isinstance(item, dict)]

                existing_music = music_by_slot.get(self.slot_id, [])
                if isinstance(existing_music, list):
                    for item in existing_music:
                        if not isinstance(item, dict):
                            continue
                        name = self._normalize_music_name(item.get("name"))
                        if not name:
                            continue
                        existing_music_map[name.lower()] = dict(item)

                next_music = []
                for item in self.music_list:
                    if not isinstance(item, dict):
                        continue
                    name = self._normalize_music_name(item.get("name"))
                    if not name:
                        continue
                    merged = dict(item)
                    existing_item = existing_music_map.get(name.lower()) or {}
                    existing_url = str(existing_item.get("url") or "").strip()
                    # Keep existing playable URL when available, avoid downgrading to numeric sync IDs.
                    if existing_url and not str(existing_url).isdigit():
                        merged["url"] = existing_url
                    next_music.append(merged)

                music_by_slot[self.slot_id] = next_music
                existing_data["music_by_slot"] = music_by_slot
                # 兼容旧前端：保留 A 槽镜像在 music 顶层。
                existing_data["music"] = list(music_by_slot.get("A", []))

                # Atomic Write
                dir_name = os.path.dirname(self.data_json_path)
                if not os.path.exists(dir_name):
                    os.makedirs(dir_name)

                # Windows environments may block NamedTemporaryFile unexpectedly.
                # Use a same-directory temp path and atomic replace.
                base_name = os.path.basename(self.data_json_path)
                temp_name = os.path.join(
                    dir_name, f".{base_name}.{int(time.time() * 1000)}.{os.getpid()}.tmp"
                )
                with open(temp_name, "w", encoding="utf-8") as tf:
                    json.dump(existing_data, tf, ensure_ascii=False, indent=2)

                # Replace
                os.replace(temp_name, self.data_json_path)
                print(
                    f"[Music] Saved {len(self.music_list)} songs to {self.data_json_path} (slot={self.slot_id})"
                )
                
        except Exception as e:
            print(f"[Music] Save failed: {e}")
            if 'temp_name' in locals() and os.path.exists(temp_name):
                try:
                    os.remove(temp_name)
                except:
                    pass

class BLEController:
    OP_POWER = 0xB0  # 鐢甸噺淇℃伅鎿嶄綔鐮?
    DEV_BATTERY = 0xFF  # 鐢甸噺璁惧鍦板潃
    OP_DEVICE_CONFIG = 0xB5
    TARGET_CONN_INTERVAL = 0x11

    def __init__(self, data_json_path=None, slot_id="A", manifest_lock=None):
        self.client = None
        self.received_data = bytearray()
        self.is_connected = False
        self.device_name = ""  # 瀛樺偍褰撳墠杩炴帴鐨勮澶囧悕绉?
        self.device_address = ""
        self.last_sent_time = 0
        self.send_interval = 1.0  # 榛樿鍙戦€侀棿闅?绉?
        self.ble = BleakScanner()
        self.battery_val = None  # 瀛樺偍鐢甸噺鍊?
        self.firmware_version = None # 瀛樺偍鍥轰欢鐗堟湰
        self.agent_id = None # 瀛樺偍鏅鸿兘浣揑D
        self.conn_interval_target_units = None
        self.conn_interval_target_ms = None
        self.conn_interval_rx_units = None
        self.conn_interval_rx_ms = None
        self.slot_id = str(slot_id or "A").strip().upper() or "A"
        self.music_manager = MusicManager(
            data_json_path,
            slot_id=self.slot_id,
            manifest_lock=manifest_lock,
        ) # 闊充箰绠＄悊鍣?
        self.music_update_callback = None # 闊充箰鍒楄〃鏇存柊鍥炶皟
        self._music_sync_lock = threading.Lock()
        self._music_sync_generation = 0
        self._music_sync_active = False
        self._music_sync_timer = None
        self._music_sync_timeout_sec = 1.2
        self._music_sync_started_at = 0.0
        
        # OTA ACK 浜嬩欢閫氱煡
        self.ota_ack_event = None # 鐢?MagosOTAManager 浼犲叆鐨?asyncio.Event
        self.ota_ack_data = None  # 瀛樺偍 ACK 鏁版嵁
        self.ota_progress = 0
        self.ota_transfer_raw_progress = 0
        self.ota_status = "idle" # idle, uploading, transferring, done, error

        # Music transfer ACK channel (0x6021 / 0x6020)
        self.music_ack_event = None
        self.music_ack_data = None

        # Generic write response ACK channel (for delete/write confirmation)
        self._write_response_event = threading.Event()
        self._write_response_lock = threading.Lock()
        self._last_write_response = None

        # Store persistent path
        self.data_json_path = data_json_path

        
        # 鏀瑰悕闃叉姈
        self._last_rename_time = 0
        self._last_rename_name = ""
        
        # 鐢甸噺骞虫粦婊ゆ尝鐩稿叧
        self._battery_history = []  # 鍘嗗彶鐢甸噺闃熷垪
        self._battery_history_len = 15 # 澧炲姞绐楀彛澶у皬鍒?5锛岃繘涓€姝ュ钩婊?
        self._last_display_battery = None # 涓婁竴娆℃樉绀虹殑鐢甸噺锛堢敤浜庤繜婊炴瘮杈冿級
        self._has_logged_empty = False # 鏄惁宸茬粡璁板綍杩囨病鐢电姸鎬?
        self._abnormal_count = 0 # 杩炵画寮傚父鍊艰鏁板櫒
        
        # 杩愬姩鐘舵€侀攣
        self._battery_update_paused = False # 鏄惁鏆傚仠鏇存柊鐢甸噺
        self._pause_resume_time = 0 # 棰勮鎭㈠鏇存柊鐨勬椂闂存埑
        self._scan_device_cache = {}
        self._last_scan_records = []


    def set_battery_update_pause(self, paused, duration=0):
        """
        璁剧疆鐢甸噺鏇存柊鏆傚仠鐘舵€?        paused: True/False
        duration: 濡傛灉鏄仮澶?paused=False)锛屽彲浠ユ寚瀹氶澶栫殑寤惰繜鏃堕棿(绉?锛岀瓑寰呯數鍘嬪洖鍗?        """
        self._battery_update_paused = paused
        if not paused and duration > 0:
            self._pause_resume_time = time.time() + duration
        else:
            self._pause_resume_time = 0
            
        status = "PAUSED" if paused else ("RESUMING in {}s".format(duration) if duration > 0 else "RESUMED")
        _ble_logger.debug("[BLE] Battery Update: %s", status)
    def update_music_json(self):
        """鏇存柊 static/data.json 涓殑闊充箰鍒楄〃 (Deprecated, delegated to MusicManager)"""
        try:
            self.music_manager.save_to_json()
            if self.music_update_callback:
                print("Triggering music update callback...")
                self._notify_music_update(
                    "music_sync_done",
                    {"music": self.music_manager.snapshot(), "count": len(self.music_manager.music_list)},
                )
        except Exception as e:
            print(f"Failed to update data.json: {e}")

    def _notify_music_update(self, event_name, payload=None):
        if not self.music_update_callback:
            return
        event = str(event_name or "music_sync_progress")
        payload_dict = payload if isinstance(payload, dict) else {}
        payload_dict.setdefault("event", event)
        payload_dict.setdefault("slot", self.slot_id)
        payload_dict.setdefault("music", self.music_manager.snapshot())
        payload_dict.setdefault("count", len(payload_dict.get("music", [])))
        try:
            self.music_update_callback(payload_dict)
        except TypeError:
            try:
                self.music_update_callback(payload_dict.get("music", []))
            except Exception as callback_exc:
                print(f"[Music] callback error: {callback_exc}")
        except Exception as callback_exc:
            print(f"[Music] callback error: {callback_exc}")

    def _prepare_write_response_wait(self):
        with self._write_response_lock:
            self._last_write_response = None
            self._write_response_event.clear()

    def _set_last_write_response(self, success, code, op_type, device_addr, data):
        with self._write_response_lock:
            self._last_write_response = {
                "success": bool(success),
                "code": int(code),
                "op_type": int(op_type),
                "device_addr": int(device_addr),
                "data": bytes(data or b""),
            }
            self._write_response_event.set()

    def wait_for_write_response(self, timeout=3.0):
        if not self._write_response_event.wait(timeout):
            return None
        with self._write_response_lock:
            return dict(self._last_write_response or {})

    def _cancel_music_sync_timer_locked(self):
        if self._music_sync_timer is not None:
            try:
                self._music_sync_timer.cancel()
            except Exception:
                pass
            self._music_sync_timer = None

    def _schedule_music_sync_finalize_locked(self, generation):
        self._cancel_music_sync_timer_locked()
        timeout = max(0.3, float(self._music_sync_timeout_sec))
        timer = threading.Timer(
            timeout,
            lambda: self._finalize_music_sync(generation=generation, reason="silence_timeout"),
        )
        timer.daemon = True
        self._music_sync_timer = timer
        timer.start()

    def _start_music_sync_session(self, source="device"):
        with self._music_sync_lock:
            self._music_sync_generation += 1
            generation = self._music_sync_generation
            self._music_sync_active = True
            self._music_sync_started_at = time.time()
            self.music_manager.start_sync()
            self._schedule_music_sync_finalize_locked(generation)
        print(
            f"[Music] Sync session started slot={self.slot_id} generation={generation} "
            f"path={self.music_manager.data_json_path}"
        )

        self._notify_music_update(
            "music_sync_start",
            {"source": str(source or "device"), "music": [], "count": 0, "generation": generation},
        )

    def _on_music_sync_item(self, music_name):
        started_implicitly = False
        with self._music_sync_lock:
            if not self._music_sync_active:
                self._music_sync_generation += 1
                self._music_sync_active = True
                self._music_sync_started_at = time.time()
                generation = self._music_sync_generation
                self.music_manager.start_sync()
                started_implicitly = True
            else:
                generation = self._music_sync_generation

            self.music_manager.add_music(music_name, auto_save=False)
            self._schedule_music_sync_finalize_locked(generation)
            snapshot = self.music_manager.snapshot()

        if started_implicitly:
            self._notify_music_update(
                "music_sync_start",
                {"source": "implicit", "music": [], "count": 0, "generation": generation},
            )

        self._notify_music_update(
            "music_sync_progress",
            {
                "source": "device",
                "music": snapshot,
                "count": len(snapshot),
                "generation": generation,
                "last_name": str(music_name or ""),
            },
        )

    def _finalize_music_sync(self, generation, reason="silence_timeout"):
        with self._music_sync_lock:
            if generation != self._music_sync_generation or not self._music_sync_active:
                return
            self._music_sync_active = False
            self._cancel_music_sync_timer_locked()

            try:
                self.music_manager.save_to_json()
                snapshot = self.music_manager.snapshot()
                duration_ms = int(max(0.0, (time.time() - self._music_sync_started_at) * 1000))
                print(
                    f"[Music] Sync finalized slot={self.slot_id} generation={generation} "
                    f"reason={reason} count={len(snapshot)} duration_ms={duration_ms}"
                )
            except Exception as sync_exc:
                print(
                    f"[Music] Sync finalize failed slot={self.slot_id} generation={generation} "
                    f"reason={reason} error={sync_exc}"
                )
                self._notify_music_update(
                    "music_sync_error",
                    {
                        "error": str(sync_exc),
                        "generation": generation,
                        "reason": str(reason or "unknown"),
                    },
                )
                return

        self._notify_music_update(
            "music_sync_done",
            {
                "source": "device",
                "music": snapshot,
                "count": len(snapshot),
                "generation": generation,
                "reason": str(reason or "unknown"),
            },
        )

    def notification_handler(
        self, characteristic: BleakGATTCharacteristic, data: bytearray
    ):
        """澶勭悊鎺ユ敹鍒扮殑鍘熷鏁版嵁骞惰В鏋愬崗璁抚"""
        # 鎵撳嵃鍘熷鏁版嵁
        # print(f"Raw RX: {bytes(data).hex()}")

        # === 1. 浼樺厛澶勭悊 OTA ACK 閫氶亾 (UUID: 00008020...) ===
        if str(characteristic.uuid).upper().startswith("00008020"):
            print(f"[OTA RX] ACK Received: {bytes(data).hex()}")
            if self.ota_ack_event:
                self.ota_ack_data = data
                self.ota_ack_event.set()
            return

        # === 2. 浼樺厛澶勭悊 OTA Command ACK (UUID: 00008022...) ===
        if str(characteristic.uuid).upper().startswith("00008022"):
            print(f"[OTA CMD RX] ACK Received: {bytes(data).hex()}")
            if self.ota_ack_event:
                self.ota_ack_data = data
                self.ota_ack_event.set()
            return

        # === 3. Music upload ACK channel (UUID: 0x6021 / 0x6020) ===
        uuid_upper = str(characteristic.uuid).upper()
        if (
            uuid_upper.startswith("00006021")
            or uuid_upper.startswith("00006020")
            or uuid_upper == "6021"
            or uuid_upper == "6020"
        ):
            print(f"[MUSIC RX] ACK Received: {bytes(data).hex()}")
            if self.music_ack_event:
                self.music_ack_data = data
                self.music_ack_event.set()
            return

        # === 4. 甯歌鍗忚澶勭悊 (UUID: 6E400003...) ===
        # 鍗忚瑙ｆ瀽
        self.received_data.extend(data)
        while len(self.received_data) >= 3:  # 鏈€灏忔鏌ラ暱搴︽敼涓?
            # 鏌ユ壘甯уご
            start_idx = self.received_data.find(HEADER)
            if start_idx == -1:
                self.received_data.clear()
                return

            # 绉婚櫎甯уご鍓嶇殑鏃犳晥鏁版嵁
            if start_idx > 0:
                self.received_data = self.received_data[start_idx:]
                continue

            # 妫€鏌ユ槸鍚︽湁瓒冲鐨勯暱搴︽潵鍒ゆ柇鎿嶄綔鐮?(鑷冲皯3瀛楄妭: HEADER + OP)
            if len(self.received_data) < 3:
                return

            op_code = self.received_data[2]
            
            # 鐗规畩澶勭悊锛氱數閲忎俊鎭?(鏃犳牎楠?
            if op_code == self.OP_POWER:
                # 鏈€灏忛暱搴? Header(2) + OP(1) + ADDR(1) + LEN(1) + DATA(1) + Footer(2) = 8
                if len(self.received_data) < 8:
                    return # 绛夊緟鏇村鏁版嵁
                
                # 楠岃瘉甯у熬
                if self.received_data[6:8] != FOOTER:
                     _ble_logger.debug("Invalid battery frame footer!")
                     # 鍙兘鏄敊璇暟鎹紝绉婚櫎涓€涓瓧鑺傚皾璇曢噸鏂板悓姝?                     self.received_data.pop(0)
                     continue
                
                # 鎻愬彇鐢甸噺
                battery = self.received_data[5] # Offset 5
                
                # 鏁版嵁娓呮礂涓庢护娉?                
                # --- 杩愬姩鐘舵€侀攣妫€鏌?---
                if self._battery_update_paused:
                    # 鏆傚仠鏈熼棿锛屽畬鍏ㄥ拷鐣ユ柊鏁版嵁锛屼篃涓嶆洿鏂板巻鍙茶褰曪紝淇濇寔涓婁竴娆＄殑鏄剧ず鍊间笉鍙?                    # print(f"Battery Update PAUSED (Val: {battery})")
                    self.received_data = self.received_data[8:]
                    continue
                    
                if self._pause_resume_time > 0:
                    if time.time() < self._pause_resume_time:
                         # 澶勪簬鎭㈠绛夊緟鏈燂紙鐢靛帇鍥炲崌鏈燂級锛屽悓鏍峰拷鐣?                         # print(f"Battery Update WAITING RECOVERY (Val: {battery})")
                         self.received_data = self.received_data[8:]
                         continue
                    else:
                         self._pause_resume_time = 0 # 绛夊緟缁撴潫
                # ---------------------
                
                # 鏀惧鑼冨洿闄愬埗锛屽厑璁歌秴杩?00鐨勫€煎弬涓庤绠楋紝鍥犱负骞冲潎鍊间細鑷姩骞虫粦瀹?                if 0 <= battery <= 255:
                    # 1. 寮傚父鍊煎墧闄?(Spike Rejection)
                    # 濡傛灉鏂板€间笌褰撳墠骞虫粦鍊煎樊寮傝繃澶?>15)锛屽垯瑙嗕负鍣０涓㈠純
                    # 闄ら潪杩炵画鍑虹幇澶氭(>=3)锛岃鏄庢槸鐪熷疄绐佸彉
                    is_abnormal = False
                    if self.battery_val is not None:
                        diff = abs(battery - self.battery_val)
                        if diff > 15: # 绐佸彉闃堝€?                            self._abnormal_count += 1
                            if self._abnormal_count < 3:
                                _ble_logger.debug(
                                    "Battery Spike Ignored: %s (Current: %s, Count: %s)",
                                    battery,
                                    self.battery_val,
                                    self._abnormal_count,
                                )
                                is_abnormal = True
                            else:
                                _ble_logger.debug(
                                    "Battery Spike ACCEPTED: %s (Persistent change)", battery
                                )
                                self._abnormal_count = 0
                                # 鐪熷疄绐佸彉锛屽缓璁竻绌哄巻鍙诧紝蹇€熷搷搴?                                self._battery_history.clear()
                        else:
                            self._abnormal_count = 0
                    
                    if not is_abnormal:
                        # 2. 灏嗘柊鍊煎姞鍏ュ巻鍙查槦鍒?                        self._battery_history.append(battery)
                        if len(self._battery_history) > self._battery_history_len:
                            self._battery_history.pop(0)
                        
                        # 3. 璁＄畻鍘绘瀬鍊煎钩鍧?(Trimmed Mean)
                        # 鍘绘帀鏈€澶у拰鏈€灏忕殑鍚?0%锛岄槻姝釜鍒櫔澹板奖鍝?                        if len(self._battery_history) >= 5:
                            sorted_hist = sorted(self._battery_history)
                            trim_cnt = int(len(sorted_hist) * 0.2)
                            valid_data = sorted_hist[trim_cnt : len(sorted_hist)-trim_cnt]
                            if not valid_data: valid_data = sorted_hist # 闃叉绌?                            avg_battery = int(sum(valid_data) / len(valid_data))
                        else:
                            avg_battery = int(sum(self._battery_history) / len(self._battery_history))
                        
                        # 绉婚櫎婊＄數浼樺寲绛栫暐鍜屾渶澶у€奸檺鍒讹紝鐩存帴鏄剧ず鐪熷疄璁＄畻鍊硷紙鏀寔>100锛?                        # if avg_battery >= 98:
                        #     avg_battery = 100
                        # else:
                        #     avg_battery = min(avg_battery, 100)
                        
                        # === 娌＄數璁板綍閫昏緫 ===
                        if avg_battery == 0:
                            if not self._has_logged_empty:
                                try:
                                    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                                    log_msg = f"[{timestamp}] Battery is DEAD (0%)\n"
                                    with open("battery_log.txt", "a", encoding="utf-8") as f:
                                        f.write(log_msg)
                                    _ble_logger.debug("Battery DEAD logged: %s", log_msg.strip())
                                    self._has_logged_empty = True
                                except Exception as e:
                                    _ble_logger.debug("Failed to log battery status: %s", e)
                        else:
                            # 濡傛灉鐢甸噺鎭㈠锛堟瘮濡傚厖鐢典簡锛夛紝閲嶇疆鏍囧織浣嶏紝浠ヤ究涓嬫娌＄數鏃惰兘鍐嶆璁板綍
                            if avg_battery > 5: # 鍔犱釜灏忛槇鍊奸槻姝?-1鎶栧姩瀵艰嚧閲嶅璁板綍
                                self._has_logged_empty = False
                        
                        # 4. 杩熸粸鏇存柊 (Hysteresis)
                        # 鍙湁褰撴柊璁＄畻鐨勫钩鍧囧€间笌褰撳墠鏄剧ず鍊煎樊寮傝秴杩囬槇鍊兼椂锛屾墠鏇存柊鏄剧ず
                        # 鎴栬€咃紝濡傛灉鏄涓€娆℃敹鍒版暟鎹紝鐩存帴鏇存柊
                        if self._last_display_battery is None:
                            self._last_display_battery = avg_battery
                            self.battery_val = avg_battery
                        else:
                            diff = abs(avg_battery - self._last_display_battery)
                            # 鎻愰珮闃堝€硷紝杩涗竴姝ュ噺灏慤I璺冲姩
                            threshold = 3 
                            
                            if diff >= threshold:
                                self._last_display_battery = avg_battery
                                self.battery_val = avg_battery
                                _ble_logger.debug(
                                    "!!! UI UPDATE !!! %s -> %s%%",
                                    self._last_display_battery,
                                    avg_battery,
                                )
                        
                        _ble_logger.debug(
                            "Battery Raw: %s%% | Smoothed: %s%% | Display: %s%%",
                            battery,
                            avg_battery,
                            self.battery_val,
                        )
                else:
                    _ble_logger.debug("Invalid battery value ignored: %s", battery)
                
                # Remove processed frame bytes.
                self.received_data = self.received_data[8:]
                continue
            
            # 璁惧閰嶇疆鍥炲寘 (鏃犳牎楠?
            # OpCode: 0xB5
            # 缁撴瀯: [AA 55][B5][Target][Len][Data...][0D 0A]
            if op_code == self.OP_DEVICE_CONFIG:
                # 鑷冲皯闇€瑕?Header(2)+OP(1)+Target(1)+Len(1)+Footer(2) = 7瀛楄妭
                if len(self.received_data) < 7:
                    return

                payload_len = self.received_data[4]
                total_len = 5 + payload_len + 2
                if len(self.received_data) < total_len:
                    return

                frame = self.received_data[:total_len]
                if frame[-2:] != FOOTER:
                    print("Invalid device config frame footer!")
                    self.received_data.pop(0)
                    continue

                target = frame[3]
                payload = frame[5 : 5 + payload_len]

                if target == self.TARGET_CONN_INTERVAL:
                    if payload_len != 2:
                        print(
                            f"[BLE][WARN] Conn interval frame invalid len={payload_len}, raw={frame.hex()}"
                        )
                    else:
                        interval_units = int.from_bytes(payload, "little")
                        interval_ms = interval_units * 1.25
                        self.conn_interval_rx_units = interval_units
                        self.conn_interval_rx_ms = interval_ms
                        print(
                            "[BLE][INFO] Conn interval frame recognized: "
                            f"units={interval_units}, ms={interval_ms}"
                        )
                else:
                    print(
                        f"[BLE][WARN] Unknown device config target=0x{target:02X}, "
                        f"len={payload_len}, raw={frame.hex()}"
                    )

                # Remove processed frame bytes.
                self.received_data = self.received_data[total_len:]
                continue

            # 鏈哄櫒鐗堟湰淇℃伅 (鏃犳牎楠?
            # OpCode: 0xB6
            # 缁撴瀯: [AA 55][B6][Target][Len][Data...][0D 0A]
            # Target: 0x01 (鍥轰欢鐗堟湰)
            if op_code == 0xB6:
                # 鑷冲皯闇€瑕?Header(2)+OP(1)+Target(1)+Len(1)+Footer(2) = 7瀛楄妭
                if len(self.received_data) < 7:
                    return # 绛夊緟鏇村鏁版嵁
                
                payload_len = self.received_data[4] # Offset 4
                total_len = 5 + payload_len + 2
                
                if len(self.received_data) < total_len:
                    return # 绛夊緟瀹屾暣鏁版嵁
                
                # 楠岃瘉甯у熬
                if self.received_data[total_len-2:total_len] != FOOTER:
                    print("Invalid firmware version frame footer!")
                    self.received_data.pop(0)
                    continue

                target = self.received_data[3]
                if target == 0x01: # 鍥轰欢鐗堟湰
                    try:
                        version_bytes = self.received_data[5:5+payload_len]
                        self.firmware_version = version_bytes.decode('utf-8')
                        print(f"Firmware Version Received: {self.firmware_version}")
                    except Exception as e:
                        print(f"Failed to decode firmware version: {e}")

                elif target == 0x02: # 鏅鸿兘浣揑D
                    try:
                        id_bytes = self.received_data[5:5+payload_len]
                        self.agent_id = id_bytes.decode('utf-8')
                        print(f"Agent ID Received: {self.agent_id}")
                    except Exception as e:
                        print(f"Failed to decode Agent ID: {e}")

                elif target == 0x03: # 闊充箰鍚嶇О
                    try:
                        music_bytes = self.received_data[5:5+payload_len]
                        music_name = music_bytes.decode('utf-8')
                        self._on_music_sync_item(music_name)
                             
                    except Exception as e:
                        print(f"Failed to decode Music Name: {e}")
                
                elif target == 0x04: # Start Music Sync
                    try:
                        print("[Music] Start Sync Command Received")
                        self._start_music_sync_session(source="device")
                    except Exception as e:
                        print(f"Failed to start music sync: {e}")
                
                # Remove processed frame bytes.
                self.received_data = self.received_data[total_len:]
                continue
            
            # 鍏煎鏃у崗璁抚澶勭悊 (0x81, 0x82, 0xF0 绛?
            # 鏈€灏忛暱搴? Header(2) + OP(1) + Addr(1) + Len(1) + Footer(2) = 7
            if len(self.received_data) < 7:
                 return # 绛夊緟鏇村鏁版嵁

            # 鑾峰彇鏁版嵁闀垮害
            payload_len = self.received_data[4]
            total_len = 5 + payload_len + 2  # 澶?B + 鏁版嵁 + 灏?B

            if len(self.received_data) < total_len:
                return  # 绛夊緟瀹屾暣甯?
            # Extract full frame.
            full_frame = self.received_data[:total_len]
            
            # 楠岃瘉甯у熬
            if full_frame[-2:] != FOOTER:
                print("Invalid footer!")
                self.received_data.pop(0)  # Drop one byte and re-sync.
                continue
                
            # Remove processed frame bytes.
            self.received_data = self.received_data[total_len:]

            # 灏嗚В鏋愬悗鐨勬暟鎹浆鍙戠粰 BLEWorker
            # 娉ㄦ剰锛氳繖閲岀殑閫昏緫鏄ā浠?BLEWorker._notification_handler 鐨勮涓?            # 浣嗙敱浜?BLEController 鍜?BLEWorker 鏄垎灞傜殑锛岃繖閲屽彲鑳介渶瑕佸洖璋冩垨鑰呬簨浠跺垎鍙?            # 绠€鍗曡捣瑙侊紝鎴戜滑鎵撳嵃涓€涓嬶紝璇佹槑瑙ｆ瀽鎴愬姛
            op_type = full_frame[2]
            device_addr = full_frame[3]
            payload = full_frame[5 : 5 + payload_len] if payload_len > 0 else b""
            if op_type in (0x02, 0x04):
                code = payload[0] if len(payload) > 0 else 0
                if code != 0:
                    print(f"[BLE] Write operation failed with code {code}")
                    self._set_last_write_response(False, code, op_type, device_addr, payload)
                else:
                    self._set_last_write_response(True, 0, op_type, device_addr, payload)

            _ble_logger.debug("Valid Legacy Frame: %s", full_frame.hex())
            
            # TODO: 濡傛灉闇€瑕佷笌 BLEWorker 鑱斿姩锛岄渶瑕佸湪杩欓噷璋冪敤鍥炶皟
            continue
            
            # --- 浠ヤ笅鏄師鏈殑"甯︽牎楠?閫昏緫锛岀湅鏉ユ槸涓嶅鐨勶紝鏆傛椂娉ㄩ噴鎺?---
            """
            # 甯歌鍗忚澶勭悊 (甯︽牎楠?
            # 妫€鏌ュ畬鏁村抚 (甯уご2瀛楄妭 + 闀垮害1瀛楄妭 + 鏁版嵁N瀛楄妭 + 鏍￠獙1瀛楄妭 + 甯у熬2瀛楄妭)
            if len(self.received_data) < 5:
                return  # 绛夊緟鏇村鏁版嵁

            payload_len = self.received_data[2]
            total_len = 2 + 1 + payload_len + 1 + 2  # 甯уご+闀垮害+鏁版嵁+鏍￠獙+甯у熬
            # ... (鐪佺暐)
            """

    def create_frame(self, data: bytes) -> bytearray:
        """Create protocol frame."""
        # 甯х粨鏋? [HEADER][LEN][DATA][CHECKSUM][FOOTER]
        frame = bytearray(HEADER)
        frame.append(len(data))  # 闀垮害瀛楄妭
        frame.extend(data)

        # 璁＄畻鏍￠獙鍜?(鏁版嵁閮ㄥ垎寮傛垨)
        checksum = 0
        for b in data:
            checksum ^= b
        frame.append(checksum)
        frame.extend(FOOTER)
        return frame

    @staticmethod
    def _safe_text(value):
        if value is None:
            return ""
        return str(value).strip()

    @staticmethod
    def _normalize_address(address):
        text = str(address or "").strip()
        return text.upper()

    def _build_scan_record(self, device=None, advertisement_data=None, fallback_address=""):
        address = self._normalize_address(
            getattr(device, "address", None) or fallback_address
        )
        adv_name = self._safe_text(getattr(advertisement_data, "local_name", None))
        device_name = self._safe_text(getattr(device, "name", None))
        name = adv_name or device_name
        display_name = f"{name} ({address})" if name else address

        rssi = getattr(advertisement_data, "rssi", None)
        if rssi is None:
            rssi = getattr(device, "rssi", None)
        try:
            rssi = int(rssi) if rssi is not None else None
        except (TypeError, ValueError):
            rssi = None

        if not address and not name:
            return None

        if not address:
            # Fallback for unusual backends that may hide address.
            address = name
            display_name = name

        return {
            "address": address,
            "name": name,
            "display_name": display_name,
            "rssi": rssi,
        }

    def get_cached_scan_device(self, address):
        key = self._normalize_address(address)
        if not key:
            return None
        return self._scan_device_cache.get(key)

    def get_last_scan_records(self):
        return list(self._last_scan_records)

    async def connect_directly(self, target_name=None, target_address=None, callback=None):
        """鐩存帴杩炴帴钃濈墮璁惧 (priority: address -> name)."""
        target_name = self._safe_text(target_name)
        target_address = self._normalize_address(target_address)
        device = None

        if target_address:
            device = self.get_cached_scan_device(target_address)
            if device is None:
                find_by_address = getattr(BleakScanner, "find_device_by_address", None)
                if callable(find_by_address):
                    try:
                        device = await find_by_address(target_address)
                    except TypeError:
                        try:
                            device = await find_by_address(target_address, timeout=8.0)
                        except Exception as e:
                            print(f"[BLE] find_device_by_address failed: {e}")
                    except Exception as e:
                        print(f"[BLE] find_device_by_address failed: {e}")

        if device is None and target_name:
            try:
                device = await BleakScanner.find_device_by_name(target_name)
            except Exception as e:
                print(f"[BLE] find_device_by_name failed: {e}")

        if device is None and target_address:
            try:
                await self.BLE_scan()
                device = self.get_cached_scan_device(target_address)
            except Exception as e:
                print(f"[BLE] fallback scan before connect failed: {e}")

        if device is None and target_name and self._scan_device_cache:
            name_lower = target_name.lower()
            for cached_device in self._scan_device_cache.values():
                cached_name = self._safe_text(getattr(cached_device, "name", None))
                if cached_name.lower() == name_lower:
                    device = cached_device
                    break

        if not device:
            print(f"Device not found (address={target_address}, name={target_name})")
            return False

        self.client = BleakClient(device, disconnected_callback=self.on_disconnect)
        await self.client.connect()
        # if callback:
        #     await self.client.start_notify(NOTIFY_UUID, callback)
        # else:
        await self.client.start_notify(NOTIFY_UUID, self.notification_handler)

        self.is_connected = True
        resolved_name = self._safe_text(getattr(device, "name", None)) or target_name
        resolved_address = self._normalize_address(getattr(device, "address", None)) or target_address
        self.device_name = resolved_name or resolved_address  # 璁板綍璁惧鍚?
        self.device_address = resolved_address
        print("Connected successfully!")
        return True

    async def BLE_scan(self):
        discovered = None
        scan_items = []
        cached_devices = {}

        try:
            discovered = await BleakScanner.discover(return_adv=True)
        except TypeError:
            discovered = await BleakScanner.discover()

        if isinstance(discovered, dict):
            for key, value in discovered.items():
                if isinstance(value, tuple) and len(value) >= 2:
                    device, advertisement_data = value[0], value[1]
                    fallback_address = key
                else:
                    device, advertisement_data = key, value
                    fallback_address = getattr(key, "address", "")

                record = self._build_scan_record(
                    device=device,
                    advertisement_data=advertisement_data,
                    fallback_address=fallback_address,
                )
                if not record:
                    continue
                scan_items.append(record)
                if device is not None:
                    cached_devices[record["address"]] = device
        else:
            for device in discovered or []:
                record = self._build_scan_record(device=device)
                if not record:
                    continue
                scan_items.append(record)
                cached_devices[record["address"]] = device

        deduped = {}
        for item in scan_items:
            address = self._normalize_address(item.get("address"))
            if not address:
                continue
            old = deduped.get(address)
            if old is None:
                deduped[address] = item
                continue
            old_rssi = old.get("rssi")
            new_rssi = item.get("rssi")
            if new_rssi is not None and (old_rssi is None or new_rssi > old_rssi):
                deduped[address] = item

        records = list(deduped.values())
        records.sort(
            key=lambda item: (
                str(item.get("display_name", "")).lower(),
                str(item.get("address", "")).lower(),
            )
        )

        self._scan_device_cache = cached_devices
        self._last_scan_records = records
        return records

    def on_disconnect(self, client):
        """鏂紑杩炴帴鍥炶皟"""
        print("Device disconnected!")
        self.is_connected = False
        self.device_name = ""
        self.device_address = ""
        with self._music_sync_lock:
            was_syncing = self._music_sync_active
            self._music_sync_active = False
            self._cancel_music_sync_timer_locked()
        if was_syncing:
            self._notify_music_update(
                "music_sync_error",
                {"error": "BLE disconnected during music sync"},
            )

    async def disconnectBLE(self):
        if (
            self.client
            and self.client.is_connected
        ):
            print("涓诲姩鏂紑钃濈墮杩炴帴")
            try:
                await self.client.disconnect()
            except Exception as e:
                print(f"鏂紑杩炴帴鏃跺彂鐢熼敊璇? {e}")
            print("Over")
        else:
            print("瀹㈡埛绔湰韬凡缁忔柇寮€")

    async def send_data(self, data: bytes):
        """Send bytes to BLE characteristic."""
        # print("manbo")
        if not self.is_connected or not self.client:
            _ble_logger.debug("Not connected!")
            return

        _ble_logger.debug("Sending data: %s", data.hex())
        await self.client.write_gatt_char(WRITE_UUID, data)
        _ble_logger.debug("Data sent successfully!")

    async def set_name(self, new_name: str):
        """淇敼钃濈墮璁惧鍚嶇О (Custom Protocol)"""
        if not self.is_connected or not self.client:
            print("Not connected!")
            return False
            
        try:
            # 闃叉姈妫€鏌ワ細闃叉鍓嶇閲嶅璋冪敤
            now = time.time()
            if new_name == self._last_rename_name and (now - self._last_rename_time) < 3.0:
                print(f"Rename '{new_name}' ignored (Debounce: {now - self._last_rename_time:.1f}s)")
                return True # 鍋囪鎴愬姛
                
            # Protocol: [HEADER][OP][ADDR][LEN][DATA][FOOTER]
            # OP_RENAME = 0xB2 (Custom defined)
            # ADDR = 0xFF (System/Broadcast)
            
            name_bytes = new_name.encode('utf-8')
            length = len(name_bytes)
            
            if length > 255:
                print(f"Name too long: {length} bytes")
                return False

            frame = bytearray()
            frame.extend(HEADER)
            frame.append(0xB2)  # OP_RENAME
            frame.append(0xE0)  # ADDR changed to E0 per user request
            frame.append(length)
            frame.extend(name_bytes)
            frame.extend(FOOTER)

            print(f"Sending Rename Frame: {frame.hex()}")
            
            # Reuse send_data logic but await it directly since we are async
            # Note: send_data is async in BLEController
            await self.send_data(frame)
            
            self.device_name = new_name # Update local cache
            self._last_rename_name = new_name
            self._last_rename_time = now
            
            return True
        except Exception as e:
            print(f"Failed to update device name: {e}")
            return False


class BLEWorker:
    # 甯уご 甯у熬
    HEADER = b"\xaa\x55"
    FOOTER = b"\x0d\x0a"

    # 璁惧绫诲瀷瀹氫箟
    DEV_SERVO_BASE = 0x01  # 鑸垫満鍩哄湴鍧€ 鑸垫満1鍦板潃 (瀵瑰簲 MagosRobot.RightHand)
    DEV_SERVO_1 = 0x01  # 鑸垫満1鍦板潃 (瀵瑰簲 MagosRobot.RightHand)
    DEV_SERVO_2 = 0x02  # 鑸垫満2鍦板潃 (瀵瑰簲 MagosRobot.RightArm)
    DEV_SERVO_3 = 0x03  # 鑸垫満3鍦板潃 (瀵瑰簲 MagosRobot.RightShoulder)
    DEV_SERVO_4 = 0x04  # 鑸垫満4鍦板潃 (瀵瑰簲 MagosRobot.LeftHand)
    DEV_SERVO_5 = 0x05  # 鑸垫満5鍦板潃 (瀵瑰簲 MagosRobot.LeftArm)
    DEV_SERVO_6 = 0x06  # 鑸垫満6鍦板潃 (瀵瑰簲 MagosRobot.LeftShoulder)
    DEV_SERVO_7 = 0x07  # 鑸垫満7鍦板潃 (瀵瑰簲 MagosRobot.Header)
    DEV_SERVO_8 = 0x08  # 鑸垫満8鍦板潃 (瀵瑰簲 MagosRobot.Base)
    DEV_SERVO_9 = 0x09  # 鑸垫満9鍦板潃 (瀵瑰簲 MagosRobot.Body)
    DEV_SERVO_10 = 0x0A  # 鑸垫満10鍦板潃

    servo_multiple_read_addrs = [
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
        0x09,
        0x0A,
    ]  # 鎵归噺璇诲彇鑸垫満鍦板潃

    DEV_Servo_UNlock = [0xA5, 0xF5, 0x5F, 0x5A]  # 瑙ｉ櫎鑸垫満閿佹寚浠?    DEV_Servo_lock = [0x5A, 0x5F, 0xF5, 0xA5]  # 寮€鍚埖鏈洪攣鎸囦护

    DEV_CAP_KEY_BASE = 0xA1  # 鐢靛寮忔寜閿熀鍦板潃
    DEV_CAP_KEY_1 = 0xA1  # 鐢靛寮忔寜閿?鍦板潃
    DEV_CAP_KEY_2 = 0xA2  # 鐢靛寮忔寜閿?鍦板潃

    key_multiple_read_addrs = [0xA1, 0xA2]  # 鎵归噺璇诲彇鐢靛寮忔寜閿湴鍧€

    DEV_VOICE_BASE = 0xB1  # 璇煶璁惧鍩哄湴鍧€
    
    # 鏂板鐢甸噺鐩稿叧瀹氫箟
    OP_POWER = 0xB0
    DEV_BATTERY = 0xFF
    OP_RENAME = 0xB2 # 淇敼钃濈墮鍚嶇О
    OP_WIFI = 0xB3 # WIFI
    
    # OTA Trigger Command
    OP_BLE_CMD = 0xB2
    target_BLE_OTA = 0xB0

    WIFI_Rset = 0xE1 # 閲嶇疆WIFI
    WIFI_ssid = 0xE2 # WIFI鐨勫悕瀛?
    WIFI_password = 0xE3 # WIFI鐨勫瘑鐮?
    # # 淇″彿瀹氫箟 鎵弿鍒扮殑璁惧鍒楄〃
    # devices_found = pyqtSignal(list)
    # # 娣诲姞杩炴帴鐘舵€佷唬鐮?    # connection_staus_changed = pyqtSignal(bool)

    def __init__(self, ble_handle, loop):
        super().__init__()
        self.ble_handle = ble_handle  # BLE澶勭悊绫诲疄渚?
        self.loop = loop  # 浜嬩欢寰幆 鐢ㄤ簬杩炴帴鍜屾壂鎻忥紙涓昏鏄敤浜庤摑鐗欒祫婧愮殑寮傛璁块棶锛?
        self.callbacks = {}  # 璁惧绫诲瀷鍒板洖璋冨嚱鏁扮殑鏄犲皠
        self.buffer = bytearray()  # 鐢ㄤ簬瀛樺偍鎺ユ敹鐨勬暟鎹紦鍐插尯
        self._write_response_event = threading.Event()
        self._write_response_lock = threading.Lock()
        self._last_write_response = None

    async def scan(self):
        devices = await self.ble_handle.BLE_scan()
        return devices

    async def connect(self, target):
        if isinstance(target, dict):
            return await self.ble_handle.connect_directly(
                target_name=target.get("name"),
                target_address=target.get("address"),
            )
        return await self.ble_handle.connect_directly(
            target_name=target,
            target_address=target,
        )

    async def set_name(self, new_name):
        return await self.ble_handle.set_name(new_name)

    async def disconnect(self):
        print(self.is_connected())
        if self.is_connected():
            asyncio.run_coroutine_threadsafe(self.ble_handle.disconnectBLE(), self.loop)

    def send_data(self, data):
        return asyncio.run_coroutine_threadsafe(self.ble_handle.send_data(data), self.loop)

    def register_callback(self, device_type, callback):
        self.callbacks[device_type] = callback

    def is_connected(self):
        """Check BLE connection state."""
        return self.ble_handle.is_connected

    def read_single(self, device_addr):
        """Read single device status."""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x01)  # 鍗曡澶囪
        frame.append(device_addr)
        frame.append(0x00)  # 鏁版嵁闀垮害0
        frame.extend(self.FOOTER)
        self.send_data(frame)

    def set_battery_display_mode(self, enabled: bool):
        """
        鎺у埗鏈鸿韩鐢甸噺鏄剧ず寮€鍏?        鍗忚: [AA 55] [B0] [FC] [01] [00/01] [0D 0A]
        娉ㄦ剰锛氬凡绉婚櫎鏍￠獙鍜?        """
        op_code = 0xB0
        addr = 0xFC
        data_val = 0x01 if enabled else 0x00
        
        frame = bytearray()
        frame.extend(self.HEADER)     # AA 55
        frame.append(op_code)         # B0
        frame.append(addr)            # FC
        frame.append(0x01)            # Len = 1
        frame.append(data_val)        # Data
        
        # 绉婚櫎鏍￠獙鍜?        # checksum = op_code ^ addr ^ 0x01 ^ data_val
        # frame.append(checksum)        # CheckSum
        
        frame.extend(self.FOOTER)     # 0D 0A
        
        print(f"Set Battery Display: {'ON' if enabled else 'OFF'}, Frame: {frame.hex()}")
        self.send_data(frame)

    def set_battery_update_pause(self, paused, duration=0):
        """
        璁剧疆鐢甸噺鏇存柊鏆傚仠鐘舵€?(浠ｇ悊鏂规硶)
        """
        self.ble_handle.set_battery_update_pause(paused, duration)

    def send_ota_start_command(self):
        """鍙戦€?OTA 鍚姩鎸囦护"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(self.OP_BLE_CMD)
        frame.append(self.target_BLE_OTA)
        frame.append(0x01) # Length
        frame.append(0x01) # Data: 1 to Start
        frame.extend(self.FOOTER)
        print(f"Sending OTA Start: {frame.hex()}")
        self.send_data(frame)

    def send_wifi_reset(self):
        """鍙戦€乄IFI閲嶇疆鎸囦护"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(self.OP_WIFI)
        frame.append(self.WIFI_Rset)
        frame.append(0x01) # Length
        frame.append(0x01) # Data: 1 to trigger
        frame.extend(self.FOOTER)
        print(f"Sending WIFI Reset: {frame.hex()}")
        self.send_data(frame)

    def send_wifi_config(self, ssid, password):
        """鍙戦€乄IFI璐﹀彿瀵嗙爜閰嶇疆"""
        import time
        # 1. Send SSID
        ssid_bytes = ssid.encode('utf-8')
        frame_ssid = bytearray()
        frame_ssid.extend(self.HEADER)
        frame_ssid.append(self.OP_WIFI)
        frame_ssid.append(self.WIFI_ssid)
        frame_ssid.append(len(ssid_bytes))
        frame_ssid.extend(ssid_bytes)
        frame_ssid.extend(self.FOOTER)
        print(f"Sending WIFI SSID: {ssid} (Hex: {frame_ssid.hex()})")
        self.send_data(frame_ssid)
        
        time.sleep(0.2) # Avoid packet loss
        
        # 2. Send Password
        pwd_bytes = password.encode('utf-8')
        frame_pwd = bytearray()
        frame_pwd.extend(self.HEADER)
        frame_pwd.append(self.OP_WIFI)
        frame_pwd.append(self.WIFI_password)
        frame_pwd.append(len(pwd_bytes))
        frame_pwd.extend(pwd_bytes)
        frame_pwd.extend(self.FOOTER)
        # Mask password in log
        print(f"Sending WIFI Password: {'*' * len(password)} (Hex: {frame_pwd.hex()})")
        self.send_data(frame_pwd)

    def send_custom_frame(self, frame):
        """Send custom protocol frame."""
        print(f"[BLE] Sending Custom Frame: {frame.hex()}")
        self.send_data(frame)

    def write_single(self, device_addr, data):
        """Write single device command."""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x02)  # 鍗曡澶囧啓
        frame.append(device_addr)
        frame.append(len(data))
        frame.extend(data)
        frame.extend(self.FOOTER)
        self.send_data(frame)

    def request_music_sync(self):
        """
        Request device to publish a full music list snapshot.
        Frame: [AA 55] [B6] [04] [00] [0D 0A]
        """
        if not self.is_connected():
            raise RuntimeError("BLE device is not connected")

        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0xB6)
        frame.append(0x04)
        frame.append(0x00)
        frame.extend(self.FOOTER)
        print(f"[Music] Request sync frame: {frame.hex()}")
        self.send_data(frame)

    def read_multiple(self, device_addrs):
        """
        鎵归噺璇诲彇璁惧鐘舵€?        device_addrs: [device_addr1, device_addr2, ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x03)  # bulk read opcode
        frame.append(0xFF)  # bulk marker (must be own line; do not merge into comment above)

        # 鏁版嵁闀垮害 = 璁惧鏁伴噺
        frame.append(len(device_addrs))

        # 娣诲姞璁惧鍦板潃
        for device_addr in device_addrs:
            frame.append(device_addr)

        frame.extend(self.FOOTER)
        self.send_data(frame)

    def write_multiple(self, commands):
        """
        鎵归噺鎺у埗璁惧
        commands: [(device_addr, data), ...] 
        娉ㄦ剰锛歞ata 蹇呴』鏄彲杩唬瀵硅薄(濡?list, bytes, bytearray)锛屽鏋滄槸鏁存暟闇€瑕佸厛杞崲
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x04)  # bulk write opcode
        frame.append(0xFF)  # bulk marker (must be own line; was swallowed by # comment)

        # 楠岃瘉杈撳叆鏍煎紡
        if not commands:
            print("write_multiple: Empty commands")
            return

        # 澶勭悊涓ょ鍙傛暟鏍煎紡
        if isinstance(commands[0], tuple):
            # 鏍煎紡1: [(device_addr, data), ...]
            
            # 棰勫鐞嗭細纭繚 data 鏄?bytes/list 鏍煎紡锛屽鏋滄槸 int 鍒欒浆涓?2 瀛楄妭灏忕
            processed_commands = []
            for device_addr, data in commands:
                if isinstance(data, int):
                    # 鍋囪鏄埖鏈鸿搴︾瓑 int 鏁版嵁锛岄粯璁よ浆涓?2 瀛楄妭灏忕
                    # 娉ㄦ剰锛氭牴鎹疄闄呭崗璁皟鏁村瓧鑺傚簭鍜岄暱搴?                    data_bytes = data.to_bytes(2, 'little')
                    processed_commands.append((device_addr, data_bytes))
                else:
                    processed_commands.append((device_addr, data))
            
            # 璁＄畻鎬婚暱搴? 姣忎釜鍛戒护鍖呭惈 1瀛楄妭鍦板潃 + 1瀛楄妭闀垮害 + N瀛楄妭鏁版嵁
            data_len = sum(1 + 1 + len(data) for _, data in processed_commands)
            
            # 闀垮害闄愬埗妫€鏌?(濡傛灉鍗忚鐢?瀛楄妭琛ㄧず闀垮害锛屾渶澶?55)
            if data_len > 255:
                print(f"write_multiple: Data too long ({data_len} > 255)")
                # 杩欓噷鍙兘闇€瑕佹媶鍖呭彂閫侊紝鎴栬€呭崗璁敮鎸佹洿闀匡紵鍋囪鐩墠涓嶅仛鎷嗗寘锛屼粎鎵撳嵃璀﹀憡
            
            frame.append(data_len & 0xFF)
            
            for device_addr, data in processed_commands:
                frame.append(device_addr)
                frame.append(len(data))
                frame.extend(data)
        else:
            # 鏍煎紡2: [device_addr1, device_addr2, ...]
            # 杩欓噷鐨勯€昏緫鐪嬭捣鏉ヤ笉瀹屾暣鎴栨湁鐗瑰畾鐢ㄩ€旓紝鏆傛椂淇濇寔鍘熸牱锛屼絾娣诲姞绫诲瀷妫€鏌?            # 涔嬪墠鐨勪唬鐮侊細data_len = len(commands) ... for device_addr in commands: frame.append(device_addr)
            # 杩欎技涔庡彧鏄彂閫佷簡涓€涓插湴鍧€锛熻繖绗﹀悎 "鎵归噺鍐? 鍗忚鍚楋紵
            # 鍋囪杩欐槸涓轰簡鏌愮鐗规畩鐨勬棤鏁版嵁鎸囦护
            
            data_len = len(commands) 
            frame.append(data_len & 0xFF)
            for device_addr in commands:
                frame.append(device_addr)
                # frame.append(2)  # 鏁版嵁闀垮害鍥哄畾涓?
                # frame.extend([0, 0])  # 榛樿鏁版嵁

        frame.extend(self.FOOTER)
        # print("BLE.py 314鍙戦€佹暟鎹?", frame.hex())
        self.send_data(frame)

    def write_voice(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x05)  # 璇煶璁惧鎺у埗
        frame.append(0xFF)  # 鎵归噺鏍囪瘑
        frame.append(len(commands))
        for device_addr in commands:
            frame.append(device_addr)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_voices_actions(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x06)
        frame.append(0xFF)  # 鎵归噺鏍囪瘑
        frame.append(len(commands))
        frame.extend(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def return_voices_actions(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x07)
        frame.append(0xFF)  # 鎵归噺鏍囪瘑
        frame.append(1)
        frame.append(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_background_voice(self, music):
        """
        鑳屾櫙闊充箰鎾斁鍗忚:
        鎾斁: [AA 55] [08] [FF] [LEN] [UTF-8鏂囦欢鍚峕 [0D 0A]
        鍋滄: [AA 55] [08] [01] [01] [01] [0D 0A]

        鍏朵腑 DATA 涓?UTF-8 鏂囦欢鍚嶏紝缁熶竴寮哄埗涓?*.mp3銆?        int 浠呭厑璁稿仠姝㈠摠鍏?0xFF銆?        """
        if isinstance(music, int):
            if (music & 0xFF) != 0xFF:
                raise ValueError("int payload only supports stop sentinel 0xFF")
            frame = bytearray()
            frame.extend(self.HEADER)
            frame.append(0x08)
            frame.append(0x01)
            frame.append(0x01)
            frame.append(0x01)
            frame.extend(self.FOOTER)
            self.send_data(frame)
            return
        else:
            payload = self._normalize_mp3_filename(music).encode("utf-8")

        if len(payload) > 0xFF:
            raise ValueError("music payload too long, max 255 bytes")

        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x08)
        frame.append(0xFF)  # 鎵归噺鏍囪瘑
        frame.append(len(payload))
        frame.extend(payload)
        frame.extend(self.FOOTER)
        self.send_data(frame)

    def _normalize_mp3_filename(self, music_name):
        if isinstance(music_name, (bytes, bytearray)):
            raw_name = bytes(music_name).decode("utf-8", errors="ignore").strip()
        else:
            raw_name = str(music_name or "").strip()

        if not raw_name:
            raise ValueError("music filename is empty")

        file_name = os.path.basename(raw_name).strip()
        if not file_name:
            raise ValueError("music filename is empty")
        if not file_name.lower().endswith(".mp3"):
            file_name = f"{file_name}.mp3"
        return file_name

    def _prepare_write_response_wait(self):
        with self._write_response_lock:
            self._last_write_response = None
            self._write_response_event.clear()

    def _set_last_write_response(self, success, code, op_type, device_addr, data):
        with self._write_response_lock:
            self._last_write_response = {
                "success": bool(success),
                "code": int(code),
                "op_type": int(op_type),
                "device_addr": int(device_addr),
                "data": bytes(data or b""),
            }
            self._write_response_event.set()

    def wait_for_write_response(self, timeout=3.0):
        if not self._write_response_event.wait(timeout):
            return None
        with self._write_response_lock:
            return dict(self._last_write_response or {})

    def write_background_voice_delete(self, music_name, timeout=3.0, wait_ack=True):
        """
        鍒犻櫎鑳屾櫙闊充箰鏂囦欢鍗忚:
        [AA 55] [08] [02] [LEN] [UTF-8 鏂囦欢鍚峕 [0D 0A]
        """
        if not self.is_connected():
            raise RuntimeError("BLE device is not connected")

        file_name = self._normalize_mp3_filename(music_name)
        payload = file_name.encode("utf-8")
        if len(payload) > 0xFF:
            raise ValueError("music delete payload too long, max 255 bytes")

        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x08)
        frame.append(0x02)
        frame.append(len(payload))
        frame.extend(payload)
        frame.extend(self.FOOTER)

        if not wait_ack:
            self.send_data(frame)
            return {"success": True, "file_name": file_name, "ack": None}

        ack_owner = self.ble_handle if hasattr(self.ble_handle, "_prepare_write_response_wait") else self
        ack_owner._prepare_write_response_wait()
        send_future = self.send_data(frame)
        send_future.result(timeout=max(float(timeout), 0.5))

        ack = ack_owner.wait_for_write_response(timeout=timeout)
        if not ack:
            raise TimeoutError(f"delete ack timeout for {file_name}")
        if not ack.get("success"):
            code = int(ack.get("code", -1))
            raise RuntimeError(f"delete nack for {file_name}, code={code}")

        return {"success": True, "file_name": file_name, "ack": ack}

    def write_emoji(self, commands):
        """
        鍙戦€佽〃鎯?(甯歌琛ㄦ儏浣跨敤鏂板崗璁?
        鍗忚: [AA 55] [09] [FF] [01] [Data] [0D 0A]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x09)        # 09
        frame.append(0xFF)        # FF
        frame.append(0x01)        # 01
        frame.append(commands)    # 琛ㄦ儏 ID
        frame.extend(self.FOOTER)
        print(f"[TX] Sending Emoji ID: {commands}, Frame: {frame.hex()}")
        self.send_data(frame)

    def write_special_emoji(self, emoji_id):
        """
        鍙戦€佺壒娈婅〃鎯?        鍗忚: [AA 55] [B4] [01] [01] [Data] [0D 0A]
        Data: 0=鐚埜鐖? 1=鐚濡? 2=鐚効瀛?        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0xB4)        # 鎿嶄綔鐮?B4 (鏄剧ず灞?
        frame.append(0x01)        # 鐩爣鍦板潃 01
        frame.append(0x01)        # 鏁版嵁闀垮害 01
        frame.append(emoji_id)    # 鏁版嵁 (0, 1, 2)
        frame.extend(self.FOOTER)
        
        print(f"Sending Special Emoji ID: {emoji_id}, Frame: {frame.hex()}")
        self.send_data(frame)

    def write_dance(self, commands):
        """Send dance-mode command."""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x0A)
        frame.append(0xFF)  # 鎵归噺鏍囪瘑
        frame.append(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_Servo_lock(self, commands):
        """
        鎺у埗鑸垫満閿?        commands: [(device_addr, data), ...] 鎴?[device_addr1, device_addr2, ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0xA5)  # servo lock batch opcode
        frame.append(0xFF)  # bulk marker (must be own line)

        # 澶勭悊涓ょ鍙傛暟鏍煎紡
        if isinstance(commands[0], tuple):
            # 鏍煎紡1: [(device_addr, data), ...]
            data_len = sum(2 + len(data) for _, data in commands)
            frame.append(data_len)
            for device_addr, data in commands:
                frame.append(device_addr)
                frame.append(len(data))
                frame.extend(data)
        else:
            # 鏍煎紡2: [device_addr1, device_addr2, ...]
            # 涓烘瘡涓澶囧湴鍧€娣诲姞榛樿鏁版嵁[0,0]
            data_len = len(commands)  # 姣忎釜璁惧: 1瀛楄妭鍦板潃 + 1瀛楄妭闀垮害 + 1瀛楄妭鏁版嵁
            frame.append(data_len)
            for device_addr in commands:
                frame.append(device_addr)
                # frame.append(2)  # 鏁版嵁闀垮害鍥哄畾涓?
                # frame.extend([0, 0])  # 榛樿鏁版嵁

        frame.extend(self.FOOTER)
        print("BLE.py 348鍙戦€佹暟鎹?", frame.hex())
        self.send_data(frame)

    '''def write_multiple(self,commands):
        """
        鎵归噺鎺у埗璁惧
        commands: [(device_addr, data), ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x04)  # 鎵归噺鍐?        frame.append(0xFF)  # 鎵归噺鏍囪瘑

        # 璁＄畻鏁版嵁鎬婚暱搴?        data_len = sum(1 + len(data) for _, data in commands)
        frame.append(data_len)

        # 娣诲姞鍛戒护鍒楄〃
        for device_addr, data in commands:
            frame.append(device_addr)
            frame.append(len(data))
            frame.extend(data)

        frame.extend(self.FOOTER)
        self.send_data(frame)'''

    def _notification_handler(
        self, characteristic: BleakGATTCharacteristic, data: bytearray
    ):
        self.buffer.extend(data)
        print(f"ble.376 Received data: {data.hex()}")
        while len(self.buffer) >= 7:  # 鏈€灏忓抚闀垮害
            # 鏌ユ壘甯уご
            start_idx = self.buffer.find(self.HEADER)
            if start_idx == -1:
                self.buffer.clear()
                return

            if start_idx > 0:
                self.buffer = self.buffer[start_idx:]
                continue

            # 妫€鏌ユ渶灏忛暱搴?            if len(self.buffer) < 7:
                return

            # 鑾峰彇鏁版嵁闀垮害
            data_len = self.buffer[4]
            total_len = 5 + data_len + 2  # 澶?B + 鏁版嵁 + 灏?B

            if len(self.buffer) < total_len:
                return  # 绛夊緟瀹屾暣甯?
            # 鎻愬彇瀹屾暣甯?            frame = bytes(self.buffer[:total_len])
            self.buffer = self.buffer[total_len:]

            # 楠岃瘉甯у熬
            if frame[-2:] != self.FOOTER:
                print("Invalid frame footer")
                return

            # 瑙ｆ瀽甯?            self._parse_frame(frame)

    def _parse_frame(self, frame):
        op_type = frame[2]
        device_addr = frame[3]
        data_len = frame[4]
        data = frame[5 : 5 + data_len] if data_len > 0 else b""
        print(f"ble.416 data: {data.hex()}")

        # Single device response
        if op_type == 0x81:
            if device_addr in self.callbacks:
                self.callbacks[device_addr](device_addr, data)
            else:
                print(f"Received data from device {device_addr:02X}: {data.hex()}")

        # 鎵归噺鍝嶅簲
        elif op_type == 0x82:
            self._parse_bulk_data(device_addr, data)

        # 浜嬩欢涓婃姤
        elif op_type == 0xF0:
            print(f"Event from device {device_addr:02X}: {data.hex()}")
            if device_addr in self.callbacks:
                self.callbacks[device_addr](data)

        # 鍐欐搷浣滃搷搴?        elif op_type in (0x02, 0x04):
            code = data[0] if len(data) > 0 else 0
            if code != 0:
                print(f"Write operation failed with code {code}")
                self._set_last_write_response(False, code, op_type, device_addr, data)
            else:
                print("Write operation succeeded")
                self._set_last_write_response(True, 0, op_type, device_addr, data)

    def _parse_bulk_data(self, bulk_type, data):
        index = 0
        while index < len(data):
            dev_addr = data[index]
            index += 1
            dev_data_len = data[index]
            index += 1
            dev_data = data[index : index + dev_data_len]
            index += dev_data_len

            # 妫€鏌ユ槸鍚︽湁鍥炶皟鍑芥暟
            if dev_addr in self.servo_multiple_read_addrs:
                if self.DEV_SERVO_BASE in self.callbacks:
                    self.callbacks[self.DEV_SERVO_BASE](dev_addr, dev_data)
            elif dev_addr in self.key_multiple_read_addrs:
                if self.DEV_CAP_KEY_BASE in self.callbacks:
                    self.callbacks[self.DEV_CAP_KEY_BASE](dev_addr, dev_data)
            else:
                print(f"Bulk data from device {dev_addr:02X}: {dev_data.hex()}")


