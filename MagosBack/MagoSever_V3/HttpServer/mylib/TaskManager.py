import threading
import time
import ctypes
import inspect

class TaskManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(TaskManager, cls).__new__(cls)
                cls._instance._init()
            return cls._instance

    def _init(self):
        self.current_thread = None
        self.pause_event = threading.Event()
        self.stop_event = threading.Event()
        self.pause_event.set() # 初始状态为非暂停（set为True表示放行）
        self.is_running = False
        self.status_code = "idle" # 新增状态码：idle, running, paused, done, error

    def start_task(self, target_func, *args, **kwargs):
        """启动新任务，如果已有任务在运行，先停止它"""
        self.stop_task()
        
        # 重置状态
        self.stop_event.clear()
        self.pause_event.set() # 确保开始时是不暂停的
        self.is_running = True
        self.status_code = "running" # 状态变更为 running
        
        # 创建新线程
        self.current_thread = threading.Thread(
            target=self._run_wrapper,
            args=(target_func,) + args,
            kwargs=kwargs,
            daemon=True
        )
        self.current_thread.start()
        return True

    def _run_wrapper(self, target_func, *args, **kwargs):
        try:
            target_func(*args, **kwargs)
            # 正常执行完毕，状态设为 done
            self.status_code = "done"
        except SystemExit:
            print("任务被强制终止")
            self.status_code = "idle" # 强制终止归为 idle
        except Exception as e:
            print(f"任务执行出错: {e}")
            self.status_code = "error" # 出错设为 error
        finally:
            # 只有当当前线程是自己时才重置状态，防止stop_task在启动新任务时把新任务的状态重置了
            # 但在这里，只要线程结束，我们就可以认为任务结束了。
            # 为了配合前端状态轮询，我们需要一个更准确的状态标志。
            # 简单的 is_running 可能在任务刚结束但前端还没轮询时就变回 False 了。
            self.is_running = False
            self.current_thread = None

    def pause_task(self):
        """暂停当前任务"""
        if self.is_running:
            self.pause_event.clear() # 设置为False，阻塞wait
            self.status_code = "paused" # 更新状态码
            print("任务已暂停")
            return True
        return False

    def resume_task(self):
        """恢复当前任务"""
        if self.is_running:
            self.pause_event.set() # 设置为True，放行
            self.status_code = "running" # 更新状态码
            print("任务已恢复")
            return True
        return False

    def stop_task(self):
        """停止当前任务"""
        if self.is_running and self.current_thread:
            print("正在停止任务...")
            self.stop_event.set() # 设置停止标志
            self.pause_event.set() # 确保暂停的任务能继续运行以响应停止
            
            # 尝试强制终止线程（仅作为最后的手段，优先依赖check_status）
            # self._async_raise(self.current_thread.ident, SystemExit)
            
            # 等待线程结束，设置超时防止死锁
            if self.current_thread and self.current_thread.is_alive():
                self.current_thread.join(timeout=2.0)
            
            self.is_running = False
            self.status_code = "idle" # 停止后设为 idle
            self.current_thread = None
            print("任务已停止")
            return True
        return False

    def check_status(self):
        """
        在耗时操作中调用此方法，用于响应暂停和停止
        返回: True 继续执行, False 应停止执行
        """
        if self.stop_event.is_set():
            # 抛出异常以中断执行流，或者返回False由调用者处理
            # 这里选择返回False，由调用者决定如何退出
            return False
            
        # 如果暂停了，这里会阻塞，直到resume
        self.pause_event.wait()
        
        # 再次检查停止，因为在暂停期间可能被停止
        if self.stop_event.is_set():
            return False
            
        return True

    def smart_sleep(self, duration):
        """
        可中断的睡眠，支持暂停和停止
        """
        start_time = time.time()
        while time.time() - start_time < duration:
            if not self.check_status():
                return False
            # 短暂睡眠以保持响应性
            time.sleep(0.1) 
        return True

    # 辅助方法：强制终止线程（慎用）
    def _async_raise(self, tid, exctype):
        tid = ctypes.c_long(tid)
        if not inspect.isclass(exctype):
            exctype = type(exctype)
        res = ctypes.pythonapi.PyThreadState_SetAsyncExc(tid, ctypes.py_object(exctype))
        if res == 0:
            return # 无效的线程ID
        elif res != 1:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(tid, None)
            raise SystemError("PyThreadState_SetAsyncExc failed")
