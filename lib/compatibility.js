// The native bridge speaks Cursor's private protocol; a Cursor upgrade can
// change it without warning. This range is what the current engine has been
// verified against. Being outside it is not an error, but the console should
// say so before the user blames Magpie or the network.
export const CURSOR_TESTED = Object.freeze({min: [3, 28, 0], max: [3, 30, 20], label: '3.28.x–3.30.20'});

function numericParts(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(parts, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function atMost(parts, maximum) {
  for (let index = 0; index < maximum.length; index += 1) {
    if (parts[index] !== maximum[index]) return parts[index] < maximum[index];
  }
  return true;
}

export function compareVersions(a, b) {
  const pa = numericParts(a);
  const pb = numericParts(b);
  if (!pa || !pb) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

export function cursorCompatibility(version) {
  const parts = numericParts(version);
  if (!parts) {
    return {
      status: 'unknown',
      tested: false,
      range: CURSOR_TESTED.label,
      hint: '未检测到 Cursor 版本；请确认 Cursor 安装在默认位置。'
    };
  }
  if (atLeast(parts, CURSOR_TESTED.min) && atMost(parts, CURSOR_TESTED.max)) {
    return {status: 'tested', tested: true, range: CURSOR_TESTED.label, hint: ''};
  }
  const older = !atLeast(parts, CURSOR_TESTED.min);
  return {
    status: older ? 'older' : 'newer',
    tested: false,
    range: CURSOR_TESTED.label,
    hint: older
      ? `Cursor ${version} 低于已实测范围 ${CURSOR_TESTED.label}；旧版网关开关可能仍在，建议先运行自检。`
      : `Cursor ${version} 高于已实测范围 ${CURSOR_TESTED.label}；私有协议可能已经变化，请先运行自检。`
  };
}
