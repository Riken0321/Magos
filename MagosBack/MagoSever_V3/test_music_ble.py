import requests
import time
import json
import os

BASE_URL = "http://localhost:5500"
SIMULATE_URL = f"{BASE_URL}/api/debug/simulate_ble"

# User provided hex strings
TEST_CASES = [
    {
        "hex": "aa55b60309312e62646a2e6d70330d0a",
        "expected_name": "1.bdj.mp3"
    },
    {
        "hex": "aa55b6030b322e68617070792e6d70330d0a",
        "expected_name": "2.happy.mp3"
    },
    {
        "hex": "aa55b603313322466c79206d6520746f20746865206d6f6f6e2028204672616e662053696e6174726120284c797269637329266d70330d0a",
        "expected_name": '3"Fly me to the moon ( Frank Sinatra (Lyrics)&mp3'
    }
]

def send_hex(hex_str):
    print(f"Sending HEX: {hex_str}")
    try:
        resp = requests.post(SIMULATE_URL, json={"hex_data": hex_str}, timeout=5)
        print(f"Response: {resp.status_code} - {resp.text}")
        return resp.status_code == 200
    except Exception as e:
        print(f"Request failed: {e}")
        return False

def check_data_json():
    # Read local file directly since we are on the same machine
    json_path = os.path.join("HttpServer", "static", "data.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                print("Current data.json content:")
                print(json.dumps(data, indent=2, ensure_ascii=False))
                return data
        except Exception as e:
            print(f"Failed to read data.json: {e}")
    else:
        print("data.json not found")
    return None

def main():
    print("Starting Music BLE Simulation Test...")
    
    # 1. Clear data.json or ensure it exists
    # We can't clear it easily via API, but we can just append and check
    
    for case in TEST_CASES:
        print("-" * 50)
        if send_hex(case["hex"]):
            print("Wait for processing...")
            time.sleep(1) # Wait for file write
            data = check_data_json()
            
            # Verify
            found = False
            if data and "music" in data:
                for item in data["music"]:
                    if item.get("name") == case["expected_name"]:
                        found = True
                        break
            
            if found:
                print(f"SUCCESS: Found {case['expected_name']}")
            else:
                print(f"FAILURE: {case['expected_name']} not found in data.json")
        else:
            print("Skipping check due to send failure")
            
    print("-" * 50)
    print("Test Complete")

if __name__ == "__main__":
    main()
