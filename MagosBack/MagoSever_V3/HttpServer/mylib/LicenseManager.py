import base64
import hashlib
import json
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple


LICENSE_SCHEMA = "magos-license-v1"
LICENSE_INDEX_FILE = "license_index.json"
LICENSE_FILE_SUFFIX = ".dat"

# Fixed 4 AI agent IDs controlled by license.
AGENT_LICENSE_TARGETS = {
    "7593560214197338163": "ai_cantonese",
    "7600626708147994665": "ai_reading_cantonese",
    "7615218352574955546": "ai_reading_english",
    "7615651238067535922": "ai_reading_mandarin",
}

# RSA public key used by client-side verification.
# Private key must stay in issuer environment only.
RSA_PUBLIC_E = 65537
RSA_PUBLIC_N_HEX = (
    "45382ca906c3feae8e46af39f80267a75e35b8ddf805d87b5f0f9f6d9bd532d94441284e630c6555"
    "f33967871dde31e25183ca53809e0ade18e93d8954e8c4b1e8df2b1c0b83a17bf0c6c1500dae4d34"
    "bea156ecb57f56cea84442408efd8dafb59a2fc7659ff013641c226a9402eda7b7f1f084599daf64"
    "18fd1b3cc8b62da2c5ecc690aebff882285e12bbb6af6c5f0b4ec8421c843bf8404e3876db3ad0052"
    "567c16e8ae5dbfcad5ae84fa2dacfd571f8f102c72e49a1df9c7128e9d3f63ed75e5bec6733ab98db"
    "4c9eed5f8aa2cd7f3ef5699b580aeb3c9b260b177b4002310401fcf022a452ee7944767b4f4ac9aa4"
    "da22da2d46856e4293343be4880ed"
)
_SHA256_DER_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


class LicenseError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class LicenseRecord:
    license_id: str
    filename: str
    agent_id: str
    customer_name: str
    issued_at: str
    expires_at: Optional[str]
    imported_at: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "license_id": self.license_id,
            "filename": self.filename,
            "agent_id": self.agent_id,
            "customer_name": self.customer_name,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "imported_at": self.imported_at,
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, object]) -> "LicenseRecord":
        return cls(
            license_id=str(payload.get("license_id") or "").strip(),
            filename=str(payload.get("filename") or "").strip(),
            agent_id=str(payload.get("agent_id") or "").strip(),
            customer_name=str(payload.get("customer_name") or "").strip(),
            issued_at=str(payload.get("issued_at") or "").strip(),
            expires_at=(
                str(payload.get("expires_at") or "").strip()
                if payload.get("expires_at") is not None
                else None
            ),
            imported_at=str(payload.get("imported_at") or "").strip(),
        )


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def canonical_payload_bytes(payload: Dict[str, object]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _safe_filename(name: str) -> str:
    text = str(name or "").strip()
    if not text:
        return ""
    out = []
    for ch in text:
        if ch.isalnum() or ch in ("-", "_", "."):
            out.append(ch)
        else:
            out.append("_")
    safe = "".join(out).strip("._")
    return safe[:120]


def _parse_iso_utc(value: Optional[str]) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _is_expired(expires_at: Optional[str]) -> bool:
    dt = _parse_iso_utc(expires_at)
    if dt is None:
        return False
    return dt.timestamp() < time.time()


def rsa_pkcs1v15_sha256_verify(
    payload_bytes: bytes,
    signature_b64: str,
    n_hex: str = RSA_PUBLIC_N_HEX,
    e: int = RSA_PUBLIC_E,
) -> bool:
    try:
        signature = base64.b64decode(str(signature_b64 or "").strip(), validate=True)
        n = int(n_hex, 16)
        if n <= 0 or e <= 1:
            return False
        k = (n.bit_length() + 7) // 8
        if len(signature) != k:
            return False

        sig_int = int.from_bytes(signature, "big")
        em_int = pow(sig_int, e, n)
        em = em_int.to_bytes(k, "big")

        digest = hashlib.sha256(payload_bytes).digest()
        t = _SHA256_DER_PREFIX + digest
        if len(t) + 11 > k:
            return False

        ps_len = k - len(t) - 3
        expected = b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + t
        return em == expected
    except Exception:
        return False


def rsa_pkcs1v15_sha256_sign(
    payload_bytes: bytes,
    d_hex: str,
    n_hex: str,
    e: int = RSA_PUBLIC_E,
) -> str:
    n = int(str(n_hex).strip(), 16)
    d = int(str(d_hex).strip(), 16)
    if n <= 0 or d <= 0:
        raise ValueError("Invalid private key")

    k = (n.bit_length() + 7) // 8
    digest = hashlib.sha256(payload_bytes).digest()
    t = _SHA256_DER_PREFIX + digest
    if len(t) + 11 > k:
        raise ValueError("RSA modulus too short for SHA-256 signature")

    ps_len = k - len(t) - 3
    em = b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + t
    em_int = int.from_bytes(em, "big")
    sig_int = pow(em_int, d, n)
    signature = sig_int.to_bytes(k, "big")
    return base64.b64encode(signature).decode("ascii")


class LicenseManager:
    def __init__(self, app_name: str = "Magos", fallback_base_dir: str = ""):
        self._lock = threading.Lock()
        self._store_dir = self._resolve_store_dir(app_name, fallback_base_dir)
        self._index_path = os.path.join(self._store_dir, LICENSE_INDEX_FILE)
        self._records: Dict[str, LicenseRecord] = {}
        self._agent_access: Dict[str, bool] = {k: False for k in AGENT_LICENSE_TARGETS}
        self._reload_locked()

    @property
    def store_dir(self) -> str:
        return self._store_dir

    @property
    def index_path(self) -> str:
        return self._index_path

    def _resolve_store_dir(self, app_name: str, fallback_base_dir: str) -> str:
        candidates = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(os.path.join(appdata, app_name, "licenses"))
        localappdata = os.environ.get("LOCALAPPDATA")
        if localappdata:
            candidates.append(os.path.join(localappdata, app_name, "licenses"))
        home = os.path.expanduser("~")
        if home:
            candidates.append(
                os.path.join(home, "AppData", "Roaming", app_name, "licenses")
            )
        if fallback_base_dir:
            candidates.append(os.path.join(fallback_base_dir, "runtime", "licenses"))
        candidates.append(os.path.join(os.getcwd(), "runtime", "licenses"))
        candidates.append(os.path.join(tempfile.gettempdir(), "magos", "licenses"))

        for folder in candidates:
            if self._ensure_writable_dir(folder):
                return folder
        raise RuntimeError("No writable directory available for license storage")

    def _ensure_writable_dir(self, folder: str) -> bool:
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, f".probe_{uuid.uuid4().hex}.tmp")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(probe)
            return True
        except Exception:
            return False

    def _reload_locked(self) -> None:
        self._records = {}
        raw_items: List[Dict[str, object]] = []
        if os.path.exists(self._index_path):
            try:
                with open(self._index_path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                if isinstance(payload, dict) and isinstance(payload.get("items"), list):
                    raw_items = payload.get("items") or []
            except Exception:
                raw_items = []

        valid_records: Dict[str, LicenseRecord] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            rec = LicenseRecord.from_dict(item)
            if (
                not rec.license_id
                or not rec.filename
                or rec.agent_id not in AGENT_LICENSE_TARGETS
            ):
                continue
            path = os.path.join(self._store_dir, rec.filename)
            if not os.path.exists(path):
                continue
            try:
                with open(path, "rb") as f:
                    blob = f.read()
                normalized = self._validate_license_blob(blob)
                if normalized["payload"]["license_id"] != rec.license_id:
                    continue
            except LicenseError:
                continue
            except Exception:
                continue
            valid_records[rec.license_id] = rec

        self._records = valid_records
        self._recompute_agent_access_locked()
        self._save_index_locked()

    def _recompute_agent_access_locked(self):
        access = {k: False for k in AGENT_LICENSE_TARGETS}
        for rec in self._records.values():
            if rec.agent_id in access and not _is_expired(rec.expires_at):
                access[rec.agent_id] = True
        self._agent_access = access

    def _save_index_locked(self) -> None:
        payload = {
            "version": 1,
            "items": [
                rec.to_dict()
                for rec in sorted(
                    self._records.values(), key=lambda x: (x.imported_at, x.license_id)
                )
            ],
        }
        tmp = f"{self._index_path}.tmp.{uuid.uuid4().hex}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._index_path)

    def _validate_license_blob(self, blob: bytes) -> Dict[str, object]:
        try:
            text = blob.decode("utf-8")
        except Exception:
            raise LicenseError("invalid_format", "License file must be UTF-8 JSON")
        try:
            data = json.loads(text)
        except Exception:
            raise LicenseError("invalid_format", "License file JSON is invalid")

        if not isinstance(data, dict):
            raise LicenseError("invalid_format", "License file root must be an object")

        if str(data.get("schema") or "").strip() != LICENSE_SCHEMA:
            raise LicenseError("invalid_format", "Unsupported license schema")

        payload = data.get("payload")
        signature = str(data.get("signature") or "").strip()
        if not isinstance(payload, dict) or not signature:
            raise LicenseError(
                "invalid_format", "License file must include payload and signature"
            )

        payload_bytes = canonical_payload_bytes(payload)
        if not rsa_pkcs1v15_sha256_verify(payload_bytes, signature):
            raise LicenseError("invalid_signature", "License signature verification failed")

        license_id = str(payload.get("license_id") or "").strip()
        customer_name = str(payload.get("customer_name") or "").strip()
        agent_id = str(payload.get("agent_id") or "").strip()
        issued_at = str(payload.get("issued_at") or "").strip()
        expires_at_raw = payload.get("expires_at")
        expires_at = (
            str(expires_at_raw or "").strip() if expires_at_raw is not None else None
        )

        if not license_id:
            raise LicenseError("invalid_format", "license_id is required")
        if not customer_name:
            raise LicenseError("invalid_format", "customer_name is required")
        if agent_id not in AGENT_LICENSE_TARGETS:
            raise LicenseError("agent_mismatch", "License agent_id is not supported")
        if not issued_at or _parse_iso_utc(issued_at) is None:
            raise LicenseError("invalid_format", "issued_at must be ISO-8601 UTC string")
        if expires_at is not None and expires_at != "" and _parse_iso_utc(expires_at) is None:
            raise LicenseError("invalid_format", "expires_at must be ISO-8601 UTC string")
        if _is_expired(expires_at):
            raise LicenseError("expired", "License has expired")

        normalized_doc = {
            "schema": LICENSE_SCHEMA,
            "payload": {
                "license_id": license_id,
                "customer_name": customer_name,
                "agent_id": agent_id,
                "issued_at": issued_at,
                "expires_at": expires_at if expires_at else None,
            },
            "signature": signature,
        }
        return normalized_doc

    def import_license_blob(
        self, filename_hint: str, blob: bytes
    ) -> Tuple[bool, str, str, Dict[str, object]]:
        with self._lock:
            try:
                normalized = self._validate_license_blob(blob)
            except LicenseError as e:
                return (False, e.code, e.message, {})

            payload = normalized["payload"]
            license_id = payload["license_id"]
            safe_name = _safe_filename(license_id) or f"license_{uuid.uuid4().hex}"
            filename = f"{safe_name}{LICENSE_FILE_SUFFIX}"
            target_path = os.path.join(self._store_dir, filename)
            imported_at = now_iso()

            file_payload = json.dumps(
                normalized, ensure_ascii=False, indent=2
            ).encode("utf-8")
            tmp_path = f"{target_path}.tmp.{uuid.uuid4().hex}"
            with open(tmp_path, "wb") as f:
                f.write(file_payload)
            os.replace(tmp_path, target_path)

            rec = LicenseRecord(
                license_id=license_id,
                filename=filename,
                agent_id=payload["agent_id"],
                customer_name=payload["customer_name"],
                issued_at=payload["issued_at"],
                expires_at=payload.get("expires_at"),
                imported_at=imported_at,
            )
            self._records[license_id] = rec
            self._recompute_agent_access_locked()
            self._save_index_locked()
            return (True, "", "", rec.to_dict())

    def delete_license(self, license_id: str) -> bool:
        key = str(license_id or "").strip()
        if not key:
            return False
        with self._lock:
            rec = self._records.pop(key, None)
            if rec is None:
                return False
            path = os.path.join(self._store_dir, rec.filename)
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
            self._recompute_agent_access_locked()
            self._save_index_locked()
            return True

    def is_agent_allowed(self, agent_id: str) -> bool:
        key = str(agent_id or "").strip()
        with self._lock:
            return bool(self._agent_access.get(key, False))

    def list_licenses(self) -> List[Dict[str, object]]:
        with self._lock:
            return [
                rec.to_dict()
                for rec in sorted(
                    self._records.values(), key=lambda x: (x.imported_at, x.license_id)
                )
            ]

    def status(self) -> Dict[str, object]:
        with self._lock:
            items = [
                rec.to_dict()
                for rec in sorted(
                    self._records.values(), key=lambda x: (x.imported_at, x.license_id)
                )
            ]
            customers = []
            expires_at_values: List[str] = []
            for rec in self._records.values():
                if rec.customer_name and rec.customer_name not in customers:
                    customers.append(rec.customer_name)
                if rec.expires_at and not _is_expired(rec.expires_at):
                    expires_at_values.append(rec.expires_at)
            entitlements = [
                agent_id for agent_id, granted in self._agent_access.items() if granted
            ]
            licensed = len(entitlements) > 0
            return {
                "status": "success",
                "licensed": licensed,
                "customer_name": ", ".join(customers),
                "license_id": items[-1]["license_id"] if items else "",
                "expires_at": min(expires_at_values) if expires_at_values else "",
                "entitlements": {"agents": entitlements},
                "agent_access": dict(self._agent_access),
                "items": items,
                "store_dir": self._store_dir,
            }
