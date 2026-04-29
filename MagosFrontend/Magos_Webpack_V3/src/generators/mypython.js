export const forBlock = Object.create(null);

function robotLine(robotId, line) {
  const id = String(robotId || "").trim();
  if (!id || id === "__none__") {
    return "# (no robot selected)\n";
  }
  return line;
}

function branchOrPass(code) {
  const body = String(code || "").trim();
  if (!body) return "  pass\n";
  return code;
}

function makeSafeSuffix(block) {
  return String(block?.id || "x").replace(/[^a-zA-Z0-9_]/g, "_");
}

function getParallelBranchInputs(block) {
  const names = (block?.inputList || [])
    .map((input) => input?.name)
    .filter((name) => typeof name === "string");

  const dynamic = names
    .filter((name) => /^BRANCH_\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  if (dynamic.length > 0) return dynamic;

  // Backward compatibility: old block definition with BRANCH_A / BRANCH_B
  const legacy = names.filter((name) => name === "BRANCH_A" || name === "BRANCH_B");
  if (legacy.length > 0) return legacy;

  return [];
}

forBlock["ServoControl"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const _servoIndex = block.getFieldValue("servoIndex");
  const _angle = block.getFieldValue("angle");
  return robotLine(
    robotId,
    `magos["${robotId}"].set_robot_server(${_servoIndex},${_angle})\n`
  );
};

forBlock["animations_start"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const _name = block.getFieldValue("actions_name");
  return robotLine(
    robotId,
    `magos["${robotId}"].animations_start("${_name}")\n`
  );
};

forBlock["shortcut_action_start"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const shortcutId = block.getFieldValue("shortcut_action_id");
  const escaped = String(shortcutId || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return robotLine(
    robotId,
    `magos["${robotId}"].shortcut_action_start("${escaped}")\n`
  );
};

forBlock["play_audio"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const _name = block.getFieldValue("audio");
  return robotLine(robotId, `magos["${robotId}"].play_audio("${_name}")\n`);
};

function toPythonStringLiteral(value) {
  const text = String(value ?? "");
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

forBlock["play_background_audio"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const selector = block.getFieldValue("background_audio_index");
  return robotLine(
    robotId,
    `magos["${robotId}"].play_background_audio(${toPythonStringLiteral(selector)})\n`
  );
};

forBlock["stop_background_audio"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  return robotLine(
    robotId,
    `magos["${robotId}"].stop_background_audio()\n`
  );
};

forBlock["change_emoji"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const _index = block.getFieldValue("emoji_index");
  return robotLine(
    robotId,
    `magos["${robotId}"].change_emoji(${_index})\n`
  );
};

forBlock["magos_time"] = function (block, generator) {
  const robotId = block.getFieldValue("robotId");
  const _time = block.getFieldValue("_time");
  return robotLine(robotId, `magos["${robotId}"].magos_time(${_time})\n`);
};

forBlock["parallel_wait_all"] = function (block, generator) {
  const suffix = makeSafeSuffix(block);
  const branchInputs = getParallelBranchInputs(block);
  const branchCount = Math.max(1, branchInputs.length);

  let code = "";
  for (let i = 0; i < branchCount; i++) {
    const inputName = branchInputs[i] || `BRANCH_${i}`;
    const branchBody = branchOrPass(
      block.getInput(inputName) ? generator.statementToCode(block, inputName) : ""
    );
    code += `def _magos_parallel_branch_${i}_${suffix}():\n`;
    code += branchBody;
  }

  code += `_magos_parallel_funcs_${suffix} = [\n`;
  for (let i = 0; i < branchCount; i++) {
    code += `  _magos_parallel_branch_${i}_${suffix},\n`;
  }
  code += `]\n`;
  code += `magos_parallel_wait_all(_magos_parallel_funcs_${suffix})\n`;
  return code;
};
