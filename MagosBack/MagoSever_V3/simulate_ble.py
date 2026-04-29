import requests
import time
import json
import random

# 配置
SERVER_URL = "http://127.0.0.1:5500"
SIMULATE_API = f"{SERVER_URL}/api/debug/simulate_ble"
MUSIC_DATA_API = f"{SERVER_URL}/api/music_data"

def string_to_hex_frame(filename):
    """构建符合协议的 Hex 字符串"""
    # 协议: [AA 55] [B6] [03] [Len] [Data] [0D 0A]
    # Header
    frame = b'\xaa\x55'
    # OpCode (B6 for System Info)
    frame += b'\xb6'
    # Target (03 for Music Name)
    frame += b'\x03'
    
    # Data
    name_bytes = filename.encode('utf-8')
    length = len(name_bytes)
    frame += bytes([length])
    frame += name_bytes
    
    # Footer
    frame += b'\x0d\x0a'
    
    return frame.hex()

def main():
    # 生成随机测试文件名，确保每次都能看到变化
    rand_id = random.randint(1, 99)
    target_file = f"{rand_id}.test_song.mp3"
    
    hex_data = string_to_hex_frame(target_file)
    
    print(f"--- Magos Backend Simulation Tool ---")
    print(f"Target File: {target_file}")
    print(f"Injecting Payload: {hex_data}")
    
    # 1. 发送模拟数据
    try:
        resp = requests.post(SIMULATE_API, json={"hex_data": hex_data}, timeout=2)
        if resp.status_code == 200:
            print(f"✅ Injection Successful: {resp.json()}")
        else:
            print(f"❌ Injection Failed: {resp.text}")
            return
    except Exception as e:
        print(f"❌ Connection Failed: {e}")
        return

    # 2. 等待处理
    print("\nWaiting for backend processing (1s)...")
    time.sleep(1)

    # 3. 验证结果
    print(f"\nChecking API {MUSIC_DATA_API}...")
    try:
        resp = requests.get(MUSIC_DATA_API, timeout=2)
        data = resp.json()
        print(f"Current Server Data: {json.dumps(data, indent=2, ensure_ascii=False)}")
        
        # 简单验证
        items = data.get("music", []) if isinstance(data, dict) else data
        if not isinstance(items, list): items = []
        
        found = False
        for item in items:
            name = item.get("name", "") if isinstance(item, dict) else str(item)
            if target_file in name:
                found = True
                break
        
        if found:
            print(f"✅ SUCCESS: '{target_file}' found in server response.")
        else:
            print(f"❌ FAILURE: '{target_file}' NOT found.")
            
    except Exception as e:
        print(f"❌ Verification Failed: {e}")

if __name__ == "__main__":
    main()
