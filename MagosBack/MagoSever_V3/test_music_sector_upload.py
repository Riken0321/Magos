# -*- coding: utf-8 -*-
import asyncio
import os
import tempfile
import threading
import time

from HttpServer.mylib.MusicTransferManager import (
    MUSIC_CMD_CHAR_UUID,
    MUSIC_DATA_CHAR_UUID,
    PACKET_PAYLOAD_SIZE,
    SECTOR_SIZE,
    MusicTransferManager,
)


class _MockCharacteristic:
    def __init__(self, uuid):
        self.uuid = uuid


class _MockGattDataCharacteristic:
    def __init__(self, uuid: str, max_write_without_response_size: int):
        self.uuid = uuid
        self.max_write_without_response_size = max_write_without_response_size


class _MockServices:
    def __init__(self, data_char):
        self._data_char = data_char

    def get_characteristic(self, uuid):
        if str(uuid).upper() == str(self._data_char.uuid).upper():
            return self._data_char
        return None


class FakeBLEController:
    def __init__(self):
        self.client = None
        self.is_connected = True
        self.music_ack_event = None
        self.music_ack_data = None

    def notification_handler(self, characteristic, data):
        uuid_upper = str(characteristic.uuid).upper()
        if (
            uuid_upper.startswith("00006021")
            or uuid_upper.startswith("00006020")
            or uuid_upper == "6021"
            or uuid_upper == "6020"
        ):
            if self.music_ack_event:
                self.music_ack_data = bytes(data)
                self.music_ack_event.set()


class FakeBleakClient:
    def __init__(self, max_write_without_response_size: int = 512, expose_caps: bool = True):
        self._notify_callbacks = {}
        self.command_packets = []
        self.data_packets = []
        self.end_sector_packets = []
        self.acked_sectors = []
        self._last_seq_by_sector = {}
        self.write_count = 0
        self.max_write_without_response_size = max_write_without_response_size
        if expose_caps:
            self.mtu_size = self.max_write_without_response_size + 3
            self.services = _MockServices(
                _MockGattDataCharacteristic(
                    MUSIC_DATA_CHAR_UUID,
                    max_write_without_response_size=self.max_write_without_response_size,
                )
            )
        else:
            self.mtu_size = None
            self.services = None

    async def start_notify(self, uuid, callback):
        self._notify_callbacks[str(uuid).upper()] = callback

    async def stop_notify(self, uuid):
        self._notify_callbacks.pop(str(uuid).upper(), None)

    async def write_gatt_char(self, uuid, data, response=False):
        uuid_upper = str(uuid).upper()
        self.write_count += 1
        packet = bytes(data)
        if uuid_upper == MUSIC_CMD_CHAR_UUID.upper():
            self.command_packets.append(packet)
            return

        if uuid_upper != MUSIC_DATA_CHAR_UUID.upper():
            raise RuntimeError(f"Unexpected UUID write: {uuid_upper}")

        if len(packet) > self.max_write_without_response_size:
            raise OSError("[WinError -2147024809] 参数错误。")

        self.data_packets.append(packet)
        if len(packet) < 3:
            raise RuntimeError("Invalid music data packet length")

        sector = int.from_bytes(packet[0:2], "big")
        seq = packet[2]

        # Sequence sanity in same sector
        last_seq = self._last_seq_by_sector.get(sector, None)
        if seq == 0xFF:
            self.end_sector_packets.append(packet)
        else:
            if last_seq is None:
                if seq != 0:
                    raise RuntimeError(f"Sector {sector} first seq should be 0, got {seq}")
            else:
                if last_seq != 0xFF and seq != (last_seq + 1):
                    raise RuntimeError(
                        f"Sector {sector} seq not incremental: last={last_seq}, current={seq}"
                    )
        self._last_seq_by_sector[sector] = seq

        if seq == 0xFF:
            # ACK format: AA55 + sector(2B BE) + status(1B)
            ack = b"\xAA\x55" + sector.to_bytes(2, "big") + b"\x00"
            self.acked_sectors.append(sector)
            callback = self._notify_callbacks.get(MUSIC_DATA_CHAR_UUID.upper())
            if callback:
                # Delay ACK slightly so manager has entered wait_for_ack path.
                threading.Timer(
                    0.01,
                    lambda: callback(_MockCharacteristic(MUSIC_DATA_CHAR_UUID), bytearray(ack)),
                ).start()


def _assert_result(client: FakeBleakClient, file_size: int):
    expected_sectors = (file_size + SECTOR_SIZE - 1) // SECTOR_SIZE
    if expected_sectors <= 0:
        expected_sectors = 1

    if len(client.acked_sectors) != expected_sectors:
        raise AssertionError(
            f"ACK sector count mismatch: expected={expected_sectors}, got={len(client.acked_sectors)}"
        )

    if client.acked_sectors != list(range(expected_sectors)):
        raise AssertionError(
            f"ACK sector index mismatch: expected={list(range(expected_sectors))}, got={client.acked_sectors}"
        )

    if len(client.end_sector_packets) != expected_sectors:
        raise AssertionError(
            f"End packet count mismatch: expected={expected_sectors}, got={len(client.end_sector_packets)}"
        )

    if any(len(pkt) > client.max_write_without_response_size for pkt in client.data_packets):
        raise AssertionError(
            "Found packet larger than transport max_write_without_response_size"
        )

    # command packets: SET_FILENAME + START + END
    if len(client.command_packets) < 3:
        raise AssertionError(
            f"Command packet count mismatch: expected>=3, got={len(client.command_packets)}"
        )

    # validate first packet command codes
    cmd_codes = []
    for frame in client.command_packets[:3]:
        if len(frame) < 5:
            raise AssertionError(f"Invalid command frame: {frame.hex()}")
        if frame[0:2] != b"\xAA\x55" or frame[-2:] != b"\x0D\x0A":
            raise AssertionError(f"Invalid command frame header/footer: {frame.hex()}")
        cmd_codes.append(frame[2])

    # SET_FILENAME(0x02), START(0x01), END(0x03)
    if cmd_codes[0] != 0x02 or cmd_codes[1] != 0x01 or cmd_codes[2] != 0x03:
        raise AssertionError(f"Unexpected command order: {cmd_codes}")

    # Protocol v2: SET_FILENAME payload should not include .mp3 suffix.
    set_filename_frame = client.command_packets[0]
    name_len = set_filename_frame[3]
    name_payload = set_filename_frame[4 : 4 + name_len].decode("utf-8", errors="ignore")
    if name_payload.lower().endswith(".mp3"):
        raise AssertionError(f"SET_FILENAME must not carry .mp3 in protocol v2, got: {name_payload}")


def _start_loop_thread():
    loop = asyncio.new_event_loop()

    def _run():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return loop, thread


def run_test():
    loop, _thread = _start_loop_thread()
    manager = MusicTransferManager()
    controller = FakeBLEController()

    try:
        rounds = [
            {"size": SECTOR_SIZE + (PACKET_PAYLOAD_SIZE * 2) + 123, "max_wwr": 512, "expose_caps": True},
            {"size": 1200, "max_wwr": 244, "expose_caps": True},  # Simulate MTU=247 => max write value 244
            {"size": SECTOR_SIZE + 1, "max_wwr": 185, "expose_caps": True},
            {"size": 500, "max_wwr": 244, "expose_caps": False},  # Force fallback after E_INVALIDARG
            {"size": SECTOR_SIZE * 2 + 33, "max_wwr": 244, "expose_caps": True},
        ]

        for idx, config in enumerate(rounds, start=1):
            file_size = int(config["size"])
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as tf:
                file_path = tf.name
                tf.write(os.urandom(file_size))

            client = FakeBleakClient(
                max_write_without_response_size=int(config["max_wwr"]),
                expose_caps=bool(config.get("expose_caps", True)),
            )
            controller.client = client

            transfer_id = manager.start_transfer(
                file_path=file_path,
                remote_name=f"sector_test_music_{idx}.mp3",
                ble_controller=controller,
                loop=loop,
            )

            deadline = time.time() + 60
            final_payload = None
            while time.time() < deadline:
                payload = manager.get_status(transfer_id)
                if payload and payload.get("transfer_status") in ("done", "error"):
                    final_payload = payload
                    break
                time.sleep(0.1)

            if not final_payload:
                raise AssertionError(f"Transfer round {idx} timeout, last={manager.get_status(transfer_id)}")
            if final_payload.get("transfer_status") != "done":
                raise AssertionError(f"Transfer round {idx} failed: {final_payload}")

            _assert_result(client, file_size)
            print(
                f"[PASS] round={idx} transfer_id={transfer_id} size={file_size} "
                f"sectors={client.acked_sectors} packets={len(client.data_packets)} "
                f"max_wwr={client.max_write_without_response_size}"
            )

            for _ in range(10):
                try:
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    break
                except Exception:
                    time.sleep(0.1)

        print("[PASS] Sector music upload test passed (multi-round)")
    finally:
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:
            pass


if __name__ == "__main__":
    run_test()
