# -*- coding: utf-8 -*-
import asyncio
import os
import struct
import tempfile

from HttpServer.mylib.MagosOTA import (
    ACK_SUCCESS,
    CMD_OTA_END,
    COMMAND_CHAR_UUID,
    MagosOTAManager,
    RECV_FW_CHAR_UUID,
)


class _MockCharacteristic:
    def __init__(self, uuid):
        self.uuid = uuid


class FakeBLEController:
    def __init__(self):
        self.ota_ack_event = None
        self.ota_ack_data = None
        self.ota_transfer_raw_progress = 0
        self.ota_status = "idle"
        self.pause_state = []

    def set_battery_update_pause(self, paused, duration=0):
        self.pause_state.append((paused, duration))

    def notification_handler(self, characteristic, data):
        uuid_upper = str(characteristic.uuid).upper()
        if uuid_upper.startswith("00008020") or uuid_upper.startswith("00008022"):
            if self.ota_ack_event:
                self.ota_ack_data = bytes(data)
                self.ota_ack_event.set()


class FakeBleakClient:
    def __init__(self):
        self._callbacks = {}
        self.write_log = []
        self.mtu_size = 247

    async def start_notify(self, uuid, callback):
        self._callbacks[str(uuid).upper()] = callback

    async def stop_notify(self, uuid):
        self._callbacks.pop(str(uuid).upper(), None)

    async def write_gatt_char(self, uuid, data, response=False):
        uuid_upper = str(uuid).upper()
        packet = bytes(data)
        self.write_log.append((uuid_upper, packet))

        if uuid_upper == COMMAND_CHAR_UUID.upper():
            cmd_id = struct.unpack_from("<H", packet, 0)[0]
            if cmd_id == CMD_OTA_END:
                # Simulate real-world error from user logs.
                raise Exception(
                    f"Could not write value {packet!r} to characteristic 0015: Unreachable"
                )
            return

        if uuid_upper == RECV_FW_CHAR_UUID.upper():
            if len(packet) >= 3 and packet[2] == 0xFF:
                sector = struct.unpack_from("<H", packet, 0)[0]
                ack = struct.pack("<H H H", sector, ACK_SUCCESS, sector + 1)
                cb = self._callbacks.get(RECV_FW_CHAR_UUID.upper())
                if cb:
                    loop = asyncio.get_running_loop()
                    loop.call_later(
                        0.01,
                        cb,
                        _MockCharacteristic(RECV_FW_CHAR_UUID),
                        bytearray(ack),
                    )
            return


async def _run():
    with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tf:
        tf.write(os.urandom(10_000))
        firmware_path = tf.name

    try:
        client = FakeBleakClient()
        ctrl = FakeBLEController()
        ota = MagosOTAManager(client=client, file_path=firmware_path)
        ota.set_controller(ctrl)

        ok = await ota.start_ota()
        if not ok:
            raise AssertionError("OTA should succeed when END is unreachable after full sectors")
        if ctrl.ota_status != "done":
            raise AssertionError(f"OTA status mismatch, expected done, got {ctrl.ota_status}")
        if ctrl.ota_transfer_raw_progress != 100:
            raise AssertionError(f"OTA progress mismatch, expected 100, got {ctrl.ota_transfer_raw_progress}")

        print("[PASS] OTA end-unreachable handling test passed")
    finally:
        if os.path.exists(firmware_path):
            os.remove(firmware_path)


if __name__ == "__main__":
    asyncio.run(_run())
