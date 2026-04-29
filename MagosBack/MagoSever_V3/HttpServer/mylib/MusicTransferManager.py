# -*- coding: utf-8 -*-
import asyncio
import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, Optional


logger = logging.getLogger("MusicTransfer")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


MUSIC_CMD_CHAR_UUID = "00006020-0000-1000-8000-00805f9b34fb"
MUSIC_DATA_CHAR_UUID = "00006021-0000-1000-8000-00805f9b34fb"

CMD_START = 0x01
CMD_SET_FILENAME = 0x02
CMD_END = 0x03

PACKET_PAYLOAD_SIZE = 500
# Protocol v2: one sector max 8192 bytes, each packet carries <=500 bytes.
SECTOR_SIZE = 8192


class _PacketTooLargeError(Exception):
    def __init__(self, payload_size: int, original_exc: Exception):
        super().__init__(str(original_exc))
        self.payload_size = max(1, int(payload_size))
        self.original_exc = original_exc


class MusicTransferManager:
    """
    BLE music file uploader based on sector/packet transfer protocol.
    The manager is thread-safe for status querying from Flask threads.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._update_event = threading.Event()
        self._transfers: Dict[str, Dict[str, Any]] = {}
        self._active_transfer_id: Optional[str] = None

    def start_transfer(
        self,
        file_path: str,
        remote_name: str,
        ble_controller,
        loop,
        postprocess_callback=None,
        postprocess_context=None,
    ) -> str:
        transfer_id = str(uuid.uuid4())
        now = time.time()
        with self._lock:
            self._transfers[transfer_id] = {
                "transfer_id": transfer_id,
                "file_path": file_path,
                "remote_name": remote_name,
                "transfer_status": "queued",
                "progress": 0.0,
                "device_message": "queued",
                "error": "",
                "created_at": now,
                "updated_at": now,
                "music_version": 0,
                "postprocess_done": False,
                "postprocess_callback": postprocess_callback,
                "postprocess_context": dict(postprocess_context or {}),
            }
            self._signal_update_locked()

        if not loop:
            self._set_status(transfer_id, "error", message="BLE loop not ready", error="BLE loop not ready")
            return transfer_id

        future = asyncio.run_coroutine_threadsafe(
            self._run_transfer(transfer_id, file_path, remote_name, ble_controller),
            loop,
        )

        def _consume_result(fut):
            try:
                fut.result()
            except Exception as exc:
                logger.exception("Unhandled transfer exception: %s", exc)
                self._set_status(
                    transfer_id,
                    "error",
                    message="Unhandled transfer exception",
                    error=str(exc),
                )

        future.add_done_callback(_consume_result)
        return transfer_id

    def get_status(self, transfer_id: str) -> Dict[str, Any]:
        with self._lock:
            payload = self._transfers.get(transfer_id)
            if not payload:
                return {}
            return dict(payload)

    def get_latest_statuses(self, limit: int = 20):
        with self._lock:
            values = [dict(item) for item in self._transfers.values()]
        values.sort(key=lambda x: float(x.get("updated_at") or 0), reverse=True)
        return values[: max(1, int(limit))]

    def wait_for_update(self, timeout: float = 5.0) -> bool:
        is_set = self._update_event.wait(timeout=timeout)
        if is_set:
            self._update_event.clear()
        return is_set

    async def _run_transfer(self, transfer_id: str, file_path: str, remote_name: str, ble_controller):
        await self._wait_for_turn(transfer_id)
        try:
            await self._do_transfer(transfer_id, file_path, remote_name, ble_controller)
        finally:
            with self._lock:
                if self._active_transfer_id == transfer_id:
                    self._active_transfer_id = None
                    self._signal_update_locked()

    async def _wait_for_turn(self, transfer_id: str):
        while True:
            claimed = False
            with self._lock:
                if self._active_transfer_id is None:
                    self._active_transfer_id = transfer_id
                    claimed = True
                    self._signal_update_locked()
            if claimed:
                return
            await asyncio.sleep(0.2)

    async def _do_transfer(self, transfer_id: str, file_path: str, remote_name: str, ble_controller):
        if not ble_controller or not ble_controller.client or not ble_controller.is_connected:
            post = self._run_postprocess_callback(
                transfer_id,
                stage="error",
                base_message="Robot not connected",
                base_error="Robot not connected",
            )
            self._set_status(
                transfer_id,
                "error",
                message=post.get("message") or "Robot not connected",
                error=post.get("error") or "Robot not connected",
            )
            return
        if not os.path.exists(file_path):
            post = self._run_postprocess_callback(
                transfer_id,
                stage="error",
                base_message="File not found",
                base_error="File not found",
            )
            self._set_status(
                transfer_id,
                "error",
                message=post.get("message") or "File not found",
                error=post.get("error") or "File not found",
            )
            return

        client = ble_controller.client
        file_size = os.path.getsize(file_path)
        total_sectors = max(1, (file_size + SECTOR_SIZE - 1) // SECTOR_SIZE)
        ack_event = asyncio.Event()

        self._set_status(
            transfer_id,
            "transferring",
            progress=0.0,
            message=f"Starting transfer ({file_size} bytes)",
        )

        ble_controller.music_ack_event = ack_event
        ble_controller.music_ack_data = None
        current_payload_size = self._resolve_packet_payload_size(client)
        logger.info("Music transfer payload size initialized: %s bytes", current_payload_size)

        data_notify_started = False
        cmd_notify_started = False
        try:
            try:
                await client.start_notify(MUSIC_DATA_CHAR_UUID, ble_controller.notification_handler)
                data_notify_started = True
            except Exception as exc:
                logger.warning("Failed to start music data notify (may already be active): %s", exc)

            try:
                await client.start_notify(MUSIC_CMD_CHAR_UUID, ble_controller.notification_handler)
                cmd_notify_started = True
            except Exception as exc:
                logger.warning("Failed to start music cmd notify (may already be active): %s", exc)

            safe_remote_name = self._sanitize_remote_name(remote_name)
            await self._send_command(client, CMD_SET_FILENAME, safe_remote_name.encode("utf-8"))
            await self._send_command(client, CMD_START)

            with open(file_path, "rb") as rf:
                sector_index = 0
                while True:
                    sector_data = rf.read(SECTOR_SIZE)
                    if not sector_data:
                        break

                    ok, current_payload_size = await self._send_sector_with_retry(
                        client=client,
                        sector_index=sector_index,
                        sector_data=sector_data,
                        ack_event=ack_event,
                        ble_controller=ble_controller,
                        initial_payload_size=current_payload_size,
                        max_retries=3,
                    )
                    if not ok:
                        post = self._run_postprocess_callback(
                            transfer_id,
                            stage="error",
                            base_message=f"Sector {sector_index} failed",
                            base_error=f"Sector {sector_index} ACK timeout or invalid ACK",
                        )
                        self._set_status(
                            transfer_id,
                            "error",
                            progress=(sector_index / total_sectors) * 100.0,
                            message=post.get("message") or f"Sector {sector_index} failed",
                            error=post.get("error") or f"Sector {sector_index} ACK timeout or invalid ACK",
                        )
                        return

                    sector_index += 1
                    progress = min(100.0, (sector_index / total_sectors) * 100.0)
                    self._set_status(
                        transfer_id,
                        "transferring",
                        progress=progress,
                        message=f"Transferred sector {sector_index}/{total_sectors}",
                    )

            await self._send_command(client, CMD_END)
            post = self._run_postprocess_callback(
                transfer_id,
                stage="done",
                base_message="Music transfer completed",
                base_error="",
            )
            if not post.get("ok", True):
                self._set_status(
                    transfer_id,
                    "error",
                    progress=100.0,
                    message=post.get("message") or "Music transfer post-process failed",
                    error=post.get("error") or "Music transfer post-process failed",
                )
                return
            self._set_status(
                transfer_id,
                "done",
                progress=100.0,
                message=post.get("message") or "Music transfer completed",
            )
        except Exception as exc:
            logger.exception("Music transfer failed: %s", exc)
            post = self._run_postprocess_callback(
                transfer_id,
                stage="error",
                base_message="Music transfer failed",
                base_error=str(exc),
            )
            self._set_status(
                transfer_id,
                "error",
                message=post.get("message") or "Music transfer failed",
                error=post.get("error") or str(exc),
            )
        finally:
            ble_controller.music_ack_event = None
            ble_controller.music_ack_data = None
            if data_notify_started:
                try:
                    await client.stop_notify(MUSIC_DATA_CHAR_UUID)
                except Exception:
                    pass
            if cmd_notify_started:
                try:
                    await client.stop_notify(MUSIC_CMD_CHAR_UUID)
                except Exception:
                    pass

    async def _send_sector_with_retry(
        self,
        client,
        sector_index: int,
        sector_data: bytes,
        ack_event: asyncio.Event,
        ble_controller,
        initial_payload_size: Optional[int] = None,
        max_retries: int = 3,
    ):
        payload_size = int(initial_payload_size or self._resolve_packet_payload_size(client))
        attempt = 0
        while attempt <= max_retries:
            try:
                await self._send_sector(
                    client,
                    sector_index,
                    sector_data,
                    payload_size=payload_size,
                )
            except _PacketTooLargeError as exc:
                new_payload = min(payload_size - 1, exc.payload_size)
                if new_payload < 1:
                    new_payload = 1
                logger.warning(
                    "Sector %s packet write invalid arg with payload=%s, fallback payload=%s",
                    sector_index,
                    payload_size,
                    new_payload,
                )
                if new_payload >= payload_size:
                    attempt += 1
                    if attempt > max_retries:
                        return False, payload_size
                payload_size = new_payload
                await asyncio.sleep(0.05)
                continue

            ok = await self._wait_for_sector_ack(
                sector_index=sector_index,
                ack_event=ack_event,
                ble_controller=ble_controller,
                timeout=6.0,
            )
            if ok:
                return True, payload_size
            attempt += 1
            await asyncio.sleep(0.2)
            logger.warning("Retrying sector %s, attempt=%s", sector_index, attempt)
        return False, payload_size

    async def _send_sector(self, client, sector_index: int, sector_data: bytes, payload_size: Optional[int] = None):
        payload_size = int(payload_size or PACKET_PAYLOAD_SIZE)
        chunks = [sector_data[i:i + payload_size] for i in range(0, len(sector_data), payload_size)]
        if not chunks:
            chunks = [b""]

        for idx, chunk in enumerate(chunks):
            is_last_packet = (idx == len(chunks) - 1)
            seq = 0xFF if is_last_packet else idx
            if seq > 0xFF:
                raise ValueError(f"Packet seq out of range: {seq}")
            packet = sector_index.to_bytes(2, "big") + bytes([seq]) + chunk
            try:
                await client.write_gatt_char(MUSIC_DATA_CHAR_UUID, packet, response=False)
            except Exception as exc:
                if self._is_invalid_arg_error(exc):
                    # WinRT E_INVALIDARG usually means the payload is larger than
                    # current write-without-response capability.
                    raise _PacketTooLargeError(
                        payload_size=max(1, payload_size // 2),
                        original_exc=exc,
                    ) from exc
                raise
            if idx % 20 == 0 and idx > 0:
                await asyncio.sleep(0.001)

    async def _wait_for_sector_ack(self, sector_index: int, ack_event: asyncio.Event, ble_controller, timeout: float) -> bool:
        ack_event.clear()
        try:
            await asyncio.wait_for(ack_event.wait(), timeout)
        except asyncio.TimeoutError:
            return False

        ack = bytes(ble_controller.music_ack_data or b"")
        recv_sector, status = self._parse_sector_ack(ack)
        if recv_sector is None or status is None:
            return False
        if recv_sector != sector_index:
            return False
        return status == 0x00

    async def _send_command(self, client, cmd: int, params: bytes = b""):
        if len(params) > 255:
            raise ValueError("Command params exceeds 255 bytes")
        frame = bytearray(b"\xAA\x55")
        frame.append(cmd & 0xFF)
        frame.append(len(params) & 0xFF)
        frame.extend(params)
        frame.extend(b"\x0D\x0A")
        await client.write_gatt_char(MUSIC_CMD_CHAR_UUID, bytes(frame), response=True)

    def _resolve_packet_payload_size(self, client) -> int:
        """
        Resolve safe per-packet data payload:
        packet bytes = 2B sector + 1B seq + payload.
        Protocol allows <=500 bytes payload; actual BLE transport may be smaller.
        """
        safe_payload = PACKET_PAYLOAD_SIZE
        write_cap = None

        try:
            services = getattr(client, "services", None)
            if services:
                get_char = getattr(services, "get_characteristic", None)
                if callable(get_char):
                    ch = get_char(MUSIC_DATA_CHAR_UUID)
                    if ch is not None:
                        cap = getattr(ch, "max_write_without_response_size", None)
                        if isinstance(cap, int) and cap > 0:
                            write_cap = cap
        except Exception:
            write_cap = None

        if write_cap is None:
            mtu_size = getattr(client, "mtu_size", None)
            if isinstance(mtu_size, int) and mtu_size > 3:
                # max value bytes for write without response is generally mtu_size - 3
                write_cap = mtu_size - 3

        if isinstance(write_cap, int) and write_cap > 3:
            safe_payload = min(PACKET_PAYLOAD_SIZE, write_cap - 3)

        return max(1, safe_payload)

    def _is_invalid_arg_error(self, exc: Exception) -> bool:
        text = str(exc or "").lower()
        return (
            "invalid arg" in text
            or "invalid parameter" in text
            or "参数错误" in text
            or "-2147024809" in text
            or "0x80070057" in text
        )

    def _parse_sector_ack(self, ack: bytes):
        # Preferred format: AA 55 + Sector(2B BE) + Status(1B) [+ optional 0D 0A]
        if len(ack) >= 5 and ack[:2] == b"\xAA\x55":
            sector = int.from_bytes(ack[2:4], "big")
            status = ack[4]
            return sector, status

        # Fallback format: Sector(2B) + Status(1B)
        if len(ack) >= 3:
            sector = int.from_bytes(ack[0:2], "big")
            status = ack[2]
            return sector, status

        return None, None

    def _sanitize_remote_name(self, remote_name: str) -> str:
        base = os.path.basename(str(remote_name or "").strip())
        if not base:
            base = f"music_{int(time.time())}"

        # Protocol v2 requirement:
        # SET_FILENAME must not include trailing ".mp3";
        # firmware appends the suffix automatically.
        if base.lower().endswith(".mp3"):
            base = os.path.splitext(base)[0]

        if len(base.encode("utf-8")) > 255:
            raw = base.encode("utf-8")[:255]
            base = raw.decode("utf-8", errors="ignore").strip() or "music"
        return base

    def _set_status(
        self,
        transfer_id: str,
        transfer_status: str,
        progress: Optional[float] = None,
        message: Optional[str] = None,
        error: Optional[str] = None,
    ):
        now = time.time()
        with self._lock:
            payload = self._transfers.get(transfer_id)
            if not payload:
                return
            payload["transfer_status"] = transfer_status
            if progress is not None:
                payload["progress"] = round(float(progress), 1)
            if message is not None:
                payload["device_message"] = str(message)
            if error is not None:
                payload["error"] = str(error)
            payload["updated_at"] = now
            self._signal_update_locked()

    def _signal_update_locked(self):
        self._update_event.set()

    def _run_postprocess_callback(
        self,
        transfer_id: str,
        stage: str,
        base_message: str = "",
        base_error: str = "",
    ):
        callback = None
        context = {}
        status_snapshot = {}

        with self._lock:
            payload = self._transfers.get(transfer_id)
            if not payload:
                return {"ok": stage == "done", "message": base_message, "error": base_error}
            if payload.get("postprocess_done"):
                return {"ok": True, "message": base_message, "error": base_error}
            payload["postprocess_done"] = True
            callback = payload.get("postprocess_callback")
            context = dict(payload.get("postprocess_context") or {})
            status_snapshot = dict(payload)

        result = {"ok": True, "message": base_message, "error": base_error}
        extra = {}
        if callable(callback):
            try:
                callback_result = callback(
                    transfer_id=transfer_id,
                    stage=str(stage or ""),
                    status=status_snapshot,
                    context=context,
                )
                if isinstance(callback_result, dict):
                    result["ok"] = bool(callback_result.get("ok", True))
                    result["message"] = str(callback_result.get("message") or result["message"])
                    result["error"] = str(callback_result.get("error") or result["error"])
                    if "music_version" in callback_result:
                        try:
                            extra["music_version"] = int(callback_result.get("music_version") or 0)
                        except Exception:
                            extra["music_version"] = 0
            except Exception as callback_exc:
                logger.exception("Transfer postprocess callback failed: %s", callback_exc)
                result = {
                    "ok": False if stage == "done" else True,
                    "message": "Music transfer post-process failed",
                    "error": str(callback_exc),
                }

        if extra:
            with self._lock:
                payload = self._transfers.get(transfer_id)
                if payload:
                    payload.update(extra)
                    payload["updated_at"] = time.time()
                    self._signal_update_locked()

        return result
