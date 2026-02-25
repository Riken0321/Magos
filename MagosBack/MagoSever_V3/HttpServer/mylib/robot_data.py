import threading

class RobotData:
    def __init__(self, num_servos=10):
        self.num_servos = num_servos
        self._delta_accumulated_angle = [0.0] * num_servos
        self._last_position_raw = [None] * num_servos
        self._last_position_angle = [0.0] * num_servos
        # 为每个舵机写死不同的原始数据范围
        # TODO:曾鴻亮
        self.raw_limits = [
            # (510, 1023),   # 舵机 0 的范围1023    右手
            (260, 773),   # 舵机 0 的范围(760,1273)    右手向上延申版
            (380,801),   # 舵机 1 的范围(177,917)   右臂
            (223, 664),   # 舵机 2 的范围1023     右肩
            # (510, 1023),   # 舵机 3 的范围  1023   左手
            (260, 773),   # 舵机 3 的范围  1023   左手向下延申版
            (317,676),   # 舵机 4 的范围    (177,917)   左臂
            (350, 900),   # 舵机 5 的范围900    左肩
            (460,540),   # 舵机 6 的范围     (460,540)   头
            # (212,494),   # 舵机 7 的范围     (212,494)   圓盤
            (405, 800),  # 舵机 7 的范围     (212,494)   圓盤改版
            (409,591),    # 舵机 8 的范围    (499,591)   底座
            (409,591)    # 舵机 9 的范围    (499,591)    身体
        ]
        # self.raw_limits = [
        #     (0,180),   # 舵机 0 的范围1023    右手
        #     (0,180),   # 舵机 1 的范围(177,917)   右连接
        #     (0,180),   # 舵机 2 的范围1023     右肩
        #     (0,180),   # 舵机 3 的范围  1023   左手
        #     (0,180),   # 舵机 4 的范围    (177,917)   左连接
        #     (0,180),   # 舵机 5 的范围1023    左肩
        #     (0,180),   # 舵机 6 的范围     (460,540)   头
        #     (0,180),   # 舵机 7 的范围     (212,494)   嘴巴
        #     (0,180),    # 舵机 8 的范围    (499,501)   底座
        #     (0,180)    # 舵机 9 的范围    (499,501)    身体
        # ]
        # 设置初始值
        for i in range(self.num_servos):
            self._last_position_raw[i] = (self.raw_limits[i][0]+self.raw_limits[i][1])/2

        # 创建锁对象
        self._lock = threading.Lock()

    def update_single_angle(self, new_position, index):
        with self._lock:  # 确保线程安全
            index = index
            if new_position is not None:  # 检查新位置是否有效
                print(f"更新舵机 {index+1} 的位置为 {new_position}")
                min_limit, max_limit = self.raw_limits[index]
                clamped_position = max(min_limit, min(new_position, max_limit))

                # 将原始位置转换为角度
                #TODO:曾鴻亮修改映射范围
                if index == 0: # 右手映射
                    # new_angle = (clamped_position * 20 - 15330)/57
                    new_angle = (clamped_position * 20 - 10330)/57
                elif index == 1: # 右臂映射
                    new_angle = (clamped_position * 180 - 72610)/421
                elif index == 2: # 右肩映射
                    new_angle = (clamped_position * 50 - 33200)/147
                elif index == 3: # 左手映射
                    # new_angle = (clamped_position * 20- 15330)/57
                    new_angle = (clamped_position * 20 - 10330)/57
                elif index == 4: # 左臂映射
                    new_angle = (clamped_position * 180 - 118090)/359
                elif index == 5: # 左肩映射
                    new_angle = (clamped_position * 3 - 1050)/11
                else:
                    new_angle = ((clamped_position / 1024) * 300) - 150

                new_angle = int(new_angle)
                # new_angle = ((clamped_position / 1024) * 300) - 150
                # new_angle = clamped_position
                delta = new_angle - self._last_position_angle[index]
                self._delta_accumulated_angle[index] += delta
                self._last_position_angle[index] = new_angle
                self._last_position_raw[index] = clamped_position
            else:
                print(f"警告: 舵机 {index} 的数据无效。")

    def update_all_angles(self, new_positions):
        # with self._lock:  # 确保线程安全
            # 遍历所有舵机，调用单个更新函数
            for i in range(0, self.num_servos):
                if new_positions[i] is not None:  # 检查新位置数据是否有效
                    self.update_single_angle(new_positions[i], i)
                else:
                    print(f"警告: 舵机 {i} 的数据无效。")



    def extractAngle_deltas(self, index=None):
        with self._lock:  # 使用锁确保线程安全
            # 如果指定了 index，返回指定舵机的增量数据，否则返回所有舵机的增量数据
            if index is None:
                deltas = self._delta_accumulated_angle
                self._delta_accumulated_angle = [0.0] * self.num_servos  # 清空所有舵机的增量
            else:
                deltas = self._delta_accumulated_angle[index]
                self._delta_accumulated_angle[index] = 0.0  # 清空指定舵机的增量
        return deltas

    def extractCurrent_rawPos(self, index=None):
        with self._lock:  # 使用锁确保线程安全
            # 如果指定了 index，返回指定舵机的增量数据，否则返回所有舵机的增量数据
            if index is None:
                position = self._last_position_raw
            else:
                position = self._last_position_raw[index]
        return position
