# -*- coding: utf-8 -*-
import asyncio
import hashlib
import logging
import os
import re
import sys
import tempfile
import threading
import time

import requests

from . import MagosOTA


logger = logging.getLogger("OTAService")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


class OTAService:
    RELEASE_LATEST_API = "https://gitee.com/api/v5/repos/beibaichuan-nitrate/magos/releases/latest"
    RELEASE_LIST_API = "https://gitee.com/api/v5/repos/beibaichuan-nitrate/magos/releases"

    def __init__(self, ble_worker):
        self.ble_worker = ble_worker

        if getattr(sys, "frozen", False):
            self.base_dir = os.path.dirname(sys.executable)
        else:
            self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        self.ota_dir = self._resolve_writable_ota_dir()
        self.firmware_bin_path = None
        self.current_release_tag = ""
        self.current_asset_url = ""

    def start_cloud_update(self, on_update_callback, force_update=False):
        """
        启动云端更新流程
        on_update_callback: func(progress: float, message: str, status: str)
        status: 'running' | 'done' | 'error'
        """
        try:
            on_update_callback(0, "正在请求云端...", "running")

            if not self.ble_worker or not self.ble_worker.is_connected():
                raise Exception("请先连接 Magos 机器人")

            on_update_callback(3, "正在检查最新版本...", "running")
            asset = self._resolve_latest_bin_asset()
            self.current_release_tag = asset["tag"]
            self.current_asset_url = asset["url"]

            self._validate_version_policy(asset["tag"], force_update)
            self._download_bin_asset(asset, on_update_callback)
            self._flash_firmware(on_update_callback)
            on_update_callback(100, "更新完成", "done")

        except requests.exceptions.RequestException as exc:
            logger.error(f"Network error: {exc}")
            on_update_callback(0, f"网络错误: {str(exc)}", "error")
        except Exception as exc:
            logger.error(f"OTA process failed: {exc}")
            on_update_callback(0, f"更新失败: {str(exc)}", "error")
        finally:
            self._cleanup()

    def _resolve_writable_ota_dir(self):
        candidates = [
            os.path.join(self.base_dir, "云端OTA"),
            os.path.join(os.path.expanduser("~"), "magos_runtime", "云端OTA"),
            os.path.join(os.getcwd(), "magos_runtime", "云端OTA"),
            os.path.join(tempfile.gettempdir(), "magos_runtime", "云端OTA"),
        ]

        for directory in candidates:
            if self._can_write_dir(directory):
                logger.info(f"Using OTA directory: {directory}")
                return directory

        raise Exception("无法创建 OTA 缓存目录")

    def _can_write_dir(self, directory):
        try:
            os.makedirs(directory, exist_ok=True)
            probe_path = os.path.join(directory, f".ota_probe_{int(time.time() * 1000)}_{os.getpid()}.tmp")
            with open(probe_path, "w", encoding="utf-8") as probe_file:
                probe_file.write("ok")
            os.remove(probe_path)
            return True
        except Exception:
            return False

    def _pick_bin_asset(self, release_obj):
        assets = release_obj.get("assets") if isinstance(release_obj, dict) else []
        if not isinstance(assets, list):
            return None

        for asset in assets:
            if not isinstance(asset, dict):
                continue
            name = str(asset.get("name") or "")
            url = str(asset.get("browser_download_url") or "")
            if (name.lower().endswith(".bin") or url.lower().endswith(".bin")) and url:
                return {
                    "name": name or "firmware.bin",
                    "url": url,
                    "tag": str(release_obj.get("tag_name") or "latest"),
                }
        return None

    def _resolve_latest_bin_asset(self):
        errors = []
        for api_url, is_list in ((self.RELEASE_LATEST_API, False), (self.RELEASE_LIST_API, True)):
            try:
                response = requests.get(api_url, timeout=15)
                response.raise_for_status()
                payload = response.json()
                releases = payload if is_list and isinstance(payload, list) else [payload]
                for release_obj in releases:
                    asset = self._pick_bin_asset(release_obj)
                    if asset:
                        return asset
            except Exception as exc:
                errors.append(f"{api_url}: {exc}")
                logger.warning(f"Resolve release asset failed from {api_url}: {exc}")

        detail = " | ".join(errors) if errors else "No release payload"
        raise Exception(f"未找到可用 .bin 固件资产，请先在 Gitee Release 上传 .bin。详情: {detail}")

    def _extract_semver(self, raw_version):
        if raw_version is None:
            return None
        text = str(raw_version).strip()
        match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", text)
        if not match:
            return None
        major = int(match.group(1))
        minor = int(match.group(2) or 0)
        patch = int(match.group(3) or 0)
        return major, minor, patch

    def _validate_version_policy(self, cloud_tag, force_update):
        ble_handle = self.ble_worker.ble_handle if self.ble_worker else None
        local_version_text = getattr(ble_handle, "firmware_version", None) if ble_handle else None
        cloud_semver = self._extract_semver(cloud_tag)
        local_semver = self._extract_semver(local_version_text)

        logger.info(f"Version check - cloud: {cloud_tag}, local: {local_version_text}, force: {force_update}")

        if not cloud_semver:
            logger.warning("Cloud release tag is not semantic version, skip version gate.")
            return
        if not local_semver:
            logger.warning("Local firmware version missing/unparseable, skip version gate.")
            return

        if force_update:
            logger.warning("Force update enabled, skip version gate.")
            return

        if cloud_semver == local_semver:
            raise Exception(f"已是最新版本（本机 {local_version_text}，云端 {cloud_tag}）")
        if cloud_semver < local_semver:
            raise Exception(f"禁止降级（本机 {local_version_text}，云端 {cloud_tag}）")

    def _reset_download(self):
        if self.firmware_bin_path and os.path.exists(self.firmware_bin_path):
            try:
                os.remove(self.firmware_bin_path)
                logger.info(f"Deleted stale firmware file: {self.firmware_bin_path}")
            except Exception as exc:
                logger.warning(f"Failed to delete stale firmware file: {exc}")

    def _download_bin_asset(self, asset, callback):
        callback(5, "正在获取最新固件信息...", "running")

        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", asset["name"]) or "latest_firmware.bin"
        if not safe_name.lower().endswith(".bin"):
            safe_name = f"{safe_name}.bin"
        self.firmware_bin_path = os.path.join(self.ota_dir, safe_name)

        callback(8, f"发现固件 {asset['name']} ({asset['tag']})", "running")
        self._reset_download()

        downloaded = 0
        total_size = 0
        last_report_time = 0.0

        with requests.get(asset["url"], stream=True, timeout=60, allow_redirects=True) as response:
            response.raise_for_status()
            total_size = int(response.headers.get("content-length", 0) or 0)

            with open(self.firmware_bin_path, "wb") as output_file:
                for chunk in response.iter_content(chunk_size=8192):
                    if not chunk:
                        continue
                    output_file.write(chunk)
                    downloaded += len(chunk)

                    now = time.time()
                    if now - last_report_time > 0.5:
                        if total_size > 0:
                            percent = 10 + (downloaded / total_size) * 25
                        else:
                            pseudo_total = 2 * 1024 * 1024
                            percent = 10 + min((downloaded / pseudo_total) * 25, 24)
                        callback(percent, f"下载中 ({downloaded / 1024:.0f}KB)...", "running")
                        last_report_time = now

        self._validate_downloaded_bin(self.firmware_bin_path, downloaded, total_size)
        logger.info(
            f"Firmware download complete - path: {self.firmware_bin_path}, size: {downloaded}, "
            f"md5: {self._calculate_md5(self.firmware_bin_path)}"
        )
        callback(35, "固件下载完成，准备烧录...", "running")

    def _validate_downloaded_bin(self, file_path, downloaded_size, reported_total):
        if not os.path.exists(file_path):
            raise Exception("固件下载失败：本地文件不存在")

        local_size = os.path.getsize(file_path)
        if local_size <= 0 or downloaded_size <= 0:
            raise Exception("固件下载失败：文件为空")
        if reported_total > 0 and local_size != reported_total:
            raise Exception("固件下载不完整，请重试")

        with open(file_path, "rb") as firmware_file:
            header = firmware_file.read(64).lower()
        if b"<!doctype html" in header or b"<html" in header:
            raise Exception("下载内容不是固件二进制文件，请检查 Release 资产链接")

    def _flash_firmware(self, callback):
        callback(40, "准备无线烧录...", "running")

        if not self.ble_worker or not self.ble_worker.is_connected():
            raise Exception("请先连接 Magos 机器人")
        if not self.firmware_bin_path or not os.path.exists(self.firmware_bin_path):
            raise Exception("固件文件不存在，无法开始 OTA")

        client = self.ble_worker.ble_handle.client
        loop = self.ble_worker.loop
        if not client or not loop:
            raise Exception("BLE Client 未初始化")

        ble_handle = self.ble_worker.ble_handle
        ble_handle.ota_transfer_raw_progress = 0

        logger.info("Sending OTA start command...")
        self.ble_worker.send_ota_start_command()
        time.sleep(1.0)

        ota_manager = MagosOTA.MagosOTAManager(client, self.firmware_bin_path)
        ota_manager.set_controller(ble_handle)

        stop_monitor = threading.Event()

        def monitor_progress():
            while not stop_monitor.is_set():
                raw_progress = float(getattr(ble_handle, "ota_transfer_raw_progress", 0) or 0)
                raw_progress = max(0.0, min(100.0, raw_progress))
                mapped_progress = 40 + (raw_progress * 0.59)
                callback(mapped_progress, f"正在无线烧录 ({int(mapped_progress)}%)...", "running")
                if ble_handle.ota_status in ["done", "error"]:
                    break
                time.sleep(0.2)

        monitor_thread = threading.Thread(target=monitor_progress, daemon=True)
        monitor_thread.start()

        try:
            future = asyncio.run_coroutine_threadsafe(ota_manager.start_ota(), loop)
            success = future.result()
            if not success:
                raise Exception("BLE 传输失败")
        finally:
            stop_monitor.set()
            monitor_thread.join()

    def _cleanup(self):
        try:
            if self.firmware_bin_path and os.path.exists(self.firmware_bin_path):
                os.remove(self.firmware_bin_path)
            logger.info("Cleanup complete")
        except Exception as exc:
            logger.warning(f"Cleanup failed: {exc}")

    def _calculate_md5(self, file_path):
        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as firmware_file:
            for chunk in iter(lambda: firmware_file.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
