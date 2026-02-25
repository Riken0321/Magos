import sys
import os
import asyncio
import threading
import time

# Add current directory to sys.path to ensure imports work
sys.path.append(os.getcwd())

try:
    from HttpServer.mylib import BLE, Magos
except ImportError:
    # Fallback if running from a different directory structure
    sys.path.append(os.path.join(os.getcwd(), "MagoSever_V3"))
    from HttpServer.mylib import BLE, Magos

def test_emoji_frames():
    print("=== Testing Emoji Data Frames (Separated Protocols) ===")
    
    # Setup Loop
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    
    # Setup BLE
    ble_handle = BLE.BLEController()
    ble_worker = BLE.BLEWorker(ble_handle, loop)
    
    # Setup Magos
    magos = Magos.MagosRobot(ble_worker)
    
    print("说明：")
    print("1. 猪家族 (8, 9, 10) -> 特殊协议 (AA 55 B4 01 01 XX 0D 0A)")
    print("2. 常规表情 (其他) -> 新协议 (AA 55 09 FF 01 XX 0D 0A)")
    
    # Test Cases
    test_cases = [
        (8, "猪爸爸 (前端ID 8) -> 目标: [AA 55] [B4] [01] [01] [00] [0D 0A]"),
        (9, "猪妈妈 (前端ID 9) -> 目标: [AA 55] [B4] [01] [01] [01] [0D 0A]"),
        (10, "猪儿子 (前端ID 10) -> 目标: [AA 55] [B4] [01] [01] [02] [0D 0A]"),
        (4, "兴奋 (前端ID 4) -> 目标: [AA 55] [09] [FF] [01] [04] [0D 0A]"),
        (3, "常规 ID 3 -> 目标: [AA 55] [09] [FF] [01] [03] [0D 0A]")
    ]
    
    for index, desc in test_cases:
        print(f"\n---------------------------------------------------------------")
        print(f"[测试] 调用 magos.change_emoji({index})")
        print(f"       预期: {desc}")
        try:
            magos.change_emoji(index)
            # Give a small delay for print output to flush
            time.sleep(0.1)
        except Exception as e:
            print(f"Error: {e}")
            
    print("\n---------------------------------------------------------------")
    print("=== Test Finished ===")
    
    # Force exit to avoid hanging threads
    os._exit(0)

if __name__ == "__main__":
    test_emoji_frames()
