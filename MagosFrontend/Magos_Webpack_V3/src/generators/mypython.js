import {Order} from 'blockly/python';

export const forBlock = Object.create(null);

forBlock["ServoControl"] = function (block, generator) {
  const _servoIndex = block.getFieldValue("servoIndex");
  const _angle = block.getFieldValue("angle");
  return `magos.set_robot_server(${_servoIndex},${_angle})\n`;
};

forBlock["animations_start"] = function (block, generator) {
  const _name = block.getFieldValue("actions_name");
   // 生成的代码仅仅是调用一个函数名，传递动作ID
  return `magos.animations_start("${_name}")\n`;
};

forBlock["play_audio"] = function (block, generator) {
  const _name = block.getFieldValue("audio");
  return `magos.play_audio("${_name}")\n`;
};

forBlock["play_background_audio"] = function (block, generator) {
  const _index = block.getFieldValue("background_audio_index");
  return `magos.play_background_audio(${_index})\n`;
};

forBlock["stop_background_audio"] = function (block, generator) {
  return `magos.stop_background_audio()\n`;
};

forBlock["change_emoji"] = function (block, generator) {
  const _index = block.getFieldValue("emoji_index");
  return `magos.change_emoji(${_index})\n`;
};

forBlock["magos_time"] = function (block, generator) {
  const _time = block.getFieldValue("_time");
  return `magos.magos_time(${_time})\n`;
};