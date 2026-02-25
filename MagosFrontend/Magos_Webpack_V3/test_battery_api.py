#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
电池状态API验证脚本
用于测试前后端电池数据交互是否正常
"""

import requests
import json
import time
from datetime import datetime

# 配置
API_URL = "http://localhost:5000/api/robot/status"  # 根据实际地址修改
POLL_INTERVAL = 2  # 轮询间隔(秒)
TEST_DURATION = 30  # 测试持续时间(秒)

def test_api_response():
    """测试API响应格式"""
    print("\n" + "="*60)
    print("电池状态API验证工具")
    print("="*60)
    print(f"目标API: {API_URL}")
    print(f"轮询间隔: {POLL_INTERVAL}秒")
    print(f"测试持续: {TEST_DURATION}秒")
    print("="*60 + "\n")
    
    start_time = time.time()
    request_count = 0
    success_count = 0
    error_count = 0
    
    while time.time() - start_time < TEST_DURATION:
        try:
            request_count += 1
            print(f"[{datetime.now().strftime('%H:%M:%S')}] 请求 #{request_count}")
            
            response = requests.get(API_URL, timeout=2)
            
            if response.status_code != 200:
                print(f"  ❌ HTTP 错误: {response.status_code}")
                error_count += 1
            else:
                success_count += 1
                data = response.json()
                
                # 验证数据格式
                required_fields = {
                    'is_connected': (bool, [True, False]),
                    'status': (str, ['idle', 'running', 'paused']),
                    'battery': (type(None), 'int_or_none')
                }
                
                print(f"  ✓ HTTP 200 OK")
                print(f"    is_connected: {data.get('is_connected')} (type: {type(data.get('is_connected')).__name__})")
                print(f"    status: {data.get('status')} (type: {type(data.get('status')).__name__})")
                print(f"    battery: {data.get('battery')} (type: {type(data.get('battery')).__name__})")
                
                # 验证字段
                if 'is_connected' not in data:
                    print("    ⚠️  警告: 缺少 is_connected 字段")
                elif not isinstance(data['is_connected'], bool):
                    print(f"    ⚠️  警告: is_connected 应为 bool, 实际为 {type(data['is_connected']).__name__}")
                
                if 'status' not in data:
                    print("    ⚠️  警告: 缺少 status 字段")
                elif data['status'] not in ['idle', 'running', 'paused']:
                    print(f"    ⚠️  警告: status '{data['status']}' 不在预期值内")
                
                battery = data.get('battery')
                if battery is not None:
                    if not isinstance(battery, int):
                        print(f"    ⚠️  警告: battery 应为 int 或 null, 实际为 {type(battery).__name__}")
                    elif not (0 <= battery <= 100):
                        print(f"    ⚠️  警告: battery 值 {battery} 超出范围 [0, 100]")
                
                print(f"  原始JSON: {json.dumps(data, ensure_ascii=False)}")
                
        except requests.exceptions.ConnectionError:
            print(f"  ❌ 连接失败: 无法连接到 {API_URL}")
            error_count += 1
        except requests.exceptions.Timeout:
            print(f"  ❌ 超时: 请求超过2秒")
            error_count += 1
        except json.JSONDecodeError as e:
            print(f"  ❌ JSON解析错误: {e}")
            error_count += 1
        except Exception as e:
            print(f"  ❌ 未知错误: {e}")
            error_count += 1
        
        print()
        if time.time() - start_time < TEST_DURATION:
            time.sleep(POLL_INTERVAL)
    
    # 统计结果
    print("\n" + "="*60)
    print("测试结果统计")
    print("="*60)
    print(f"总请求数: {request_count}")
    print(f"成功数: {success_count} ✓")
    print(f"失败数: {error_count} ❌")
    print(f"成功率: {(success_count/request_count*100):.1f}%")
    print("="*60)
    
    if error_count == 0:
        print("\n✓ 所有请求都成功！API配置正确。")
    else:
        print(f"\n✗ 有 {error_count} 个请求失败。请检查后端服务状态。")

def test_frontend_compatibility():
    """测试前端兼容性"""
    print("\n" + "="*60)
    print("前端兼容性测试")
    print("="*60)
    
    test_cases = [
        {
            "name": "标准连接状态",
            "data": {
                "is_connected": True,
                "status": "idle",
                "battery": 82
            },
            "expected": "电量：82%"
        },
        {
            "name": "低电量(20%以下)",
            "data": {
                "is_connected": True,
                "status": "idle",
                "battery": 15
            },
            "expected": "电量：15% (应显示红色)"
        },
        {
            "name": "设备断开连接",
            "data": {
                "is_connected": False,
                "status": "idle",
                "battery": None
            },
            "expected": "电量：-- (应显示灰色)"
        },
        {
            "name": "电池为null",
            "data": {
                "is_connected": True,
                "status": "idle",
                "battery": None
            },
            "expected": "电量：-- (设备已连接但未收到电量数据)"
        },
        {
            "name": "字符串boolean(兼容性测试)",
            "data": {
                "is_connected": "true",
                "status": "idle",
                "battery": "82"
            },
            "expected": "电量：82% (前端应能处理字符串类型)"
        }
    ]
    
    for i, test_case in enumerate(test_cases, 1):
        print(f"\n测试 {i}: {test_case['name']}")
        print(f"  输入: {json.dumps(test_case['data'], ensure_ascii=False)}")
        print(f"  期望输出: {test_case['expected']}")

if __name__ == "__main__":
    try:
        test_api_response()
        test_frontend_compatibility()
    except KeyboardInterrupt:
        print("\n\n测试被中断")
