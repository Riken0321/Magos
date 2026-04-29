import PyInstaller.__main__
import os
import subprocess
import sys
import re
import importlib
import importlib.metadata
import importlib.util

# Define paths
base_path = os.path.abspath(os.path.dirname(__file__))
repo_root = os.path.abspath(os.path.join(base_path, '..', '..'))
frontend_build_script = os.path.join(repo_root, 'build_frontend.py')
vendor_path = os.path.join(base_path, '_vendor')
# 统一输出到仓库根下 dist/（不再使用 MagoSever_V3/build、MagoSever_V3/dist）
dist_dir = os.path.join(repo_root, 'dist')
work_dir = os.path.join(dist_dir, 'pyi_work')
warn_file_path = os.path.join(work_dir, 'MagosServer', 'warn-MagosServer.txt')

EXPECTED_PACKAGE_VERSIONS = {
    "bleak": "2.1.1",
    "pynput": "1.7.7",
    "winrt-runtime": "3.2.1",
    "winrt-Windows.Devices.Bluetooth": "3.2.1",
    "winrt-Windows.Devices.Bluetooth.Advertisement": "3.2.1",
    "winrt-Windows.Devices.Enumeration": "3.2.1",
    "winrt-Windows.Devices.Radios": "3.2.1",
    "winrt-Windows.Foundation": "3.2.1",
    "winrt-Windows.Storage.Streams": "3.2.1",
}

REQUIRED_IMPORT_MODULES = [
    "pynput",
    "bleak",
    "winrt.windows.devices.bluetooth",
    "winrt.windows.devices.bluetooth.advertisement",
    "winrt.windows.devices.enumeration",
    "winrt.windows.devices.radios",
    "winrt.windows.foundation",
    "winrt.windows.storage.streams",
]

CRITICAL_FROZEN_MODULES = {
    "bleak",
    "bleak.backends.winrt.scanner",
    "winrt.windows.devices.bluetooth",
    "winrt.windows.devices.bluetooth.advertisement",
    "winrt.windows.devices.enumeration",
    "winrt.windows.devices.radios",
    "winrt.windows.foundation",
    "winrt.windows.storage.streams",
}


def ensure_module_available(module_name: str) -> None:
    spec = importlib.util.find_spec(module_name)
    if spec is None:
        raise RuntimeError(
            f"Required module not found for packaging: {module_name}. "
            f"Install it to the active environment or {vendor_path}."
        )


def ensure_package_version(package_name: str, expected_version: str) -> None:
    try:
        current = importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError(
            f"Required package is missing: {package_name}=={expected_version}"
        ) from exc
    if str(current).strip() != str(expected_version).strip():
        raise RuntimeError(
            f"Version mismatch for {package_name}: expected {expected_version}, got {current}"
        )


def run_dependency_checks() -> None:
    for module_name in REQUIRED_IMPORT_MODULES:
        ensure_module_available(module_name)
    for package_name, expected_version in EXPECTED_PACKAGE_VERSIONS.items():
        ensure_package_version(package_name, expected_version)


def validate_pyinstaller_warning_file() -> None:
    if not os.path.exists(warn_file_path):
        raise RuntimeError(f"PyInstaller warning file not found: {warn_file_path}")

    with open(warn_file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    missing_modules = set()
    for match in re.finditer(r"missing module named (.+?) - imported by", content):
        raw_name = match.group(1).strip()
        normalized = raw_name.strip("'\"").strip()
        if normalized:
            missing_modules.add(normalized)

    unresolved = sorted(CRITICAL_FROZEN_MODULES.intersection(missing_modules))
    if unresolved:
        raise RuntimeError(
            "Critical BLE modules are missing in frozen analysis: "
            + ", ".join(unresolved)
        )


if os.path.isdir(vendor_path) and vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)
    os.environ["PYTHONPATH"] = (
        vendor_path + os.pathsep + os.environ.get("PYTHONPATH", "")
    ).strip(os.pathsep)

run_dependency_checks()

os.makedirs(dist_dir, exist_ok=True)

# 使用仓库内 MagosServer.spec（含 datas/hiddenimports/excludes），避免以 app.py 直跑时 PyInstaller 覆盖 spec。
spec_path = os.path.join(base_path, "MagosServer.spec")
if not os.path.isfile(spec_path):
    raise FileNotFoundError(f"PyInstaller spec not found: {spec_path}")

args = [
    spec_path,
    "--clean",
    "--noconfirm",
    f"--distpath={dist_dir}",
    f"--workpath={work_dir}",
]

# Run
print("Starting frontend build+deploy before PyInstaller...")
if not os.path.exists(frontend_build_script):
    raise FileNotFoundError(f"Frontend build script not found: {frontend_build_script}")

subprocess.run(
    [sys.executable, frontend_build_script],
    cwd=repo_root,
    check=True,
)

print("Starting PyInstaller build...")
print(f"Command args: {args}")
PyInstaller.__main__.run(args)
validate_pyinstaller_warning_file()
print("Dependency self-check passed.")
exe_out = os.path.join(dist_dir, "MagosServer.exe")
print(f"Done. Output: {exe_out}")
