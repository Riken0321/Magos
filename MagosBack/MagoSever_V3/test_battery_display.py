import requests
import json
import time

BASE_URL = "http://127.0.0.1:5500"

def test_set_battery_display(mode):
    url = f"{BASE_URL}/api/robot/battery_display"
    payload = {"display_mode": mode}
    headers = {'Content-Type': 'application/json'}
    
    print(f"\n[测试] 尝试设置电量显示: {'显示 (1)' if mode==1 else '不显示 (0)'}")
    try:
        response = requests.post(url, data=json.dumps(payload), headers=headers)
        
        if response.status_code == 200:
            print(f"[成功] 服务器返回: {response.json()}")
        else:
            print(f"[失败] 状态码: {response.status_code}, 响应: {response.text}")
            
    except requests.exceptions.ConnectionError:
        print("[错误] 无法连接到服务器，请确认 Flask 后端已启动！")

if __name__ == "__main__":
    print("=== 开始模拟前端测试 ===")
    
    # 测试开启
    test_set_battery_display(1)
    
    # 休息一下
    time.sleep(1)
    
    # 测试关闭
    test_set_battery_display(0)
    
    print("\n=== 测试结束 ===")
