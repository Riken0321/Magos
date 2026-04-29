import * as Blockly from "blockly/core";

const STORED_MIN = 0;
const STORED_MAX = 180;
const SIGNED_MIN = -90;
const SIGNED_MAX = 90;

const DIAL_RADIUS = 92;
const DIAL_PADDING = 14;
const DIAL_CENTER_X = DIAL_PADDING + DIAL_RADIUS;
const DIAL_CENTER_Y = DIAL_PADDING + DIAL_RADIUS;
const DIAL_WIDTH = DIAL_CENTER_X * 2;
const DIAL_HEIGHT = DIAL_CENTER_Y + DIAL_PADDING + 26;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseSignedText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/\s+/g, "").replace(/°/g, "");
  if (!/^[+-]?\d+$/.test(normalized)) {
    return null;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(n);
}

export class FieldSignedAngle extends Blockly.FieldNumber {
  static DEFAULT_VALUE = 90;
  static DEFAULT_STEP = 1;
  static DEFAULT_SHIFT_STEP = 10;

  constructor(value, validator, config = {}) {
    const initialValue =
      value === undefined || value === null
        ? FieldSignedAngle.DEFAULT_VALUE
        : value;

    super(initialValue, validator, config);

    this.step_ = Math.max(
      1,
      Math.round(toFiniteNumber(config.step, FieldSignedAngle.DEFAULT_STEP))
    );
    this.shiftStep_ = Math.max(
      this.step_,
      Math.round(
        toFiniteNumber(config.shiftStep, FieldSignedAngle.DEFAULT_SHIFT_STEP)
      )
    );

    this.dropdownRoot_ = null;
    this.svgRoot_ = null;
    this.gaugePath_ = null;
    this.pointerLine_ = null;
    this.pointerDot_ = null;
    this.inputEl_ = null;
    this.boundEvents_ = [];
    this.isDialDragging_ = false;

    this.setMin(STORED_MIN);
    this.setMax(STORED_MAX);
    this.setPrecision(1);
    this.setValue(this.normalizeStored_(this.getValue()));
  }

  static fromJson(options) {
    return new FieldSignedAngle(options.value, undefined, options);
  }

  normalizeStored_(value) {
    const n = Math.round(toFiniteNumber(value, FieldSignedAngle.DEFAULT_VALUE));
    return clamp(n, STORED_MIN, STORED_MAX);
  }

  normalizeSigned_(value) {
    const n = Math.round(toFiniteNumber(value, 0));
    return clamp(n, SIGNED_MIN, SIGNED_MAX);
  }

  storedToSigned_(storedValue) {
    return this.normalizeStored_(storedValue) - 90;
  }

  signedToStored_(signedValue) {
    return this.normalizeSigned_(signedValue) + 90;
  }

  formatSigned_(signedValue) {
    return String(this.normalizeSigned_(signedValue));
  }

  doClassValidation_(newValue) {
    const n = Math.round(Number(newValue));
    if (!Number.isFinite(n)) {
      return null;
    }
    return clamp(n, STORED_MIN, STORED_MAX);
  }

  getText_() {
    return this.formatSigned_(this.storedToSigned_(this.getValue()));
  }

  showEditor_(e, quietInput) {
    const isMobile =
      Blockly.utils.userAgent.MOBILE ||
      Blockly.utils.userAgent.ANDROID ||
      Blockly.utils.userAgent.IPAD;

    super.showEditor_(e, isMobile || quietInput, false);

    // We fully own the popup editor; close default WidgetDiv input.
    Blockly.WidgetDiv.hide();

    const content = this.createDropdownEditor_();
    Blockly.DropDownDiv.getContentDiv().appendChild(content);

    const sourceBlock = this.getSourceBlock();
    if (sourceBlock instanceof Blockly.BlockSvg) {
      Blockly.DropDownDiv.setColour(
        sourceBlock.style.colourPrimary,
        sourceBlock.style.colourTertiary
      );
    }

    Blockly.DropDownDiv.showPositionedByField(
      this,
      this.disposeDropdownEditor_.bind(this)
    );

    this.syncDropdownUIFromValue_();

    if (this.inputEl_) {
      this.inputEl_.focus();
      this.inputEl_.select();
    }
  }

  createDropdownEditor_() {
    const root = document.createElement("div");
    root.className = "blocklySignedAngleDropdown";

    const inputRow = document.createElement("div");
    inputRow.className = "blocklySignedAngleInputRow";

    const inputLabel = document.createElement("span");
    inputLabel.className = "blocklySignedAngleInputLabel";
    inputLabel.textContent = "Angle";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "blocklySignedAngleInput";
    input.inputMode = "numeric";
    input.setAttribute("aria-label", "Signed angle (-90 to 90)");

    const suffix = document.createElement("span");
    suffix.className = "blocklySignedAngleInputSuffix";
    suffix.textContent = "°";

    inputRow.appendChild(inputLabel);
    inputRow.appendChild(input);
    inputRow.appendChild(suffix);

    const svg = this.createDialSvg_();

    root.appendChild(inputRow);
    root.appendChild(svg);

    this.dropdownRoot_ = root;
    this.inputEl_ = input;

    this.bindEvent_(input, "input", () => {
      const parsed = parseSignedText(input.value);
      if (parsed === null) {
        return;
      }
      this.setSignedValue_(parsed, true);
      this.syncDropdownUIFromValue_(false);
    });

    this.bindEvent_(input, "blur", () => {
      this.syncDropdownUIFromValue_();
    });

    this.bindEvent_(input, "keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        Blockly.DropDownDiv.hideIfOwner(this);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const parsed = parseSignedText(input.value);
        if (parsed !== null) {
          this.setSignedValue_(parsed, true);
        }
        this.syncDropdownUIFromValue_();
        Blockly.DropDownDiv.hideIfOwner(this);
        return;
      }

      let direction = 0;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        direction = 1;
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        direction = -1;
      }

      if (direction !== 0) {
        const step = event.shiftKey ? this.shiftStep_ : this.step_;
        this.adjustSignedBy_(direction * step);
        event.preventDefault();
        event.stopPropagation();
      }
    });

    this.bindEvent_(svg, "pointerdown", (event) => {
      event.preventDefault();
      this.isDialDragging_ = true;
      this.updateSignedFromPointer_(event);
      if (this.inputEl_) {
        this.inputEl_.focus();
      }
    });

    this.bindEvent_(window, "pointermove", (event) => {
      if (!this.isDialDragging_) {
        return;
      }
      this.updateSignedFromPointer_(event);
    });

    this.bindEvent_(window, "pointerup", () => {
      this.isDialDragging_ = false;
    });

    return root;
  }

  createDialSvg_() {
    const svg = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.SVG,
      {
        xmlns: Blockly.utils.dom.SVG_NS,
        "xmlns:html": Blockly.utils.dom.HTML_NS,
        "xmlns:xlink": Blockly.utils.dom.XLINK_NS,
        version: "1.1",
        width: `${DIAL_WIDTH}px`,
        height: `${DIAL_HEIGHT}px`,
        class: "blocklySignedAngleDial",
      }
    );

    this.svgRoot_ = svg;

    Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.PATH,
      {
        class: "blocklySignedAngleArc",
        d: this.getArcPath_(),
      },
      svg
    );

    for (let signed = SIGNED_MIN; signed <= SIGNED_MAX; signed += 10) {
      const isMajor = signed % 30 === 0;
      const points = this.getTickLinePoints_(signed, isMajor ? 14 : 8);
      Blockly.utils.dom.createSvgElement(
        Blockly.utils.Svg.LINE,
        {
          class: isMajor
            ? "blocklySignedAngleTickMajor"
            : "blocklySignedAngleTickMinor",
          x1: points.x1,
          y1: points.y1,
          x2: points.x2,
          y2: points.y2,
        },
        svg
      );
    }

    [-90, -45, 0, 45, 90].forEach((signed) => {
      const { x, y } = this.getLabelPoint_(signed);
      const label = Blockly.utils.dom.createSvgElement(
        Blockly.utils.Svg.TEXT,
        {
          class: "blocklySignedAngleLabel",
          x,
          y,
          "text-anchor": "middle",
        },
        svg
      );
      label.textContent = `${signed}`;
    });

    this.gaugePath_ = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.PATH,
      {
        class: "blocklySignedAngleGauge",
      },
      svg
    );

    this.pointerLine_ = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.LINE,
      {
        class: "blocklySignedAnglePointer",
        x1: DIAL_CENTER_X,
        y1: DIAL_CENTER_Y,
      },
      svg
    );

    this.pointerDot_ = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.CIRCLE,
      {
        class: "blocklySignedAnglePointerDot",
        r: 4,
      },
      svg
    );

    Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.CIRCLE,
      {
        class: "blocklySignedAngleCenterDot",
        cx: DIAL_CENTER_X,
        cy: DIAL_CENTER_Y,
        r: 3,
      },
      svg
    );

    return svg;
  }

  getArcPath_() {
    const left = this.getPointOnArc_(SIGNED_MIN, DIAL_RADIUS);
    const right = this.getPointOnArc_(SIGNED_MAX, DIAL_RADIUS);
    return `M ${left.x} ${left.y} A ${DIAL_RADIUS} ${DIAL_RADIUS} 0 0 1 ${right.x} ${right.y}`;
  }

  getTickLinePoints_(signedValue, tickLength) {
    const outer = this.getPointOnArc_(signedValue, DIAL_RADIUS);
    const inner = this.getPointOnArc_(signedValue, DIAL_RADIUS - tickLength);
    return {
      x1: outer.x,
      y1: outer.y,
      x2: inner.x,
      y2: inner.y,
    };
  }

  getLabelPoint_(signedValue) {
    return this.getPointOnArc_(signedValue, DIAL_RADIUS - 24);
  }

  getPointOnArc_(signedValue, radius) {
    const clampedSigned = this.normalizeSigned_(signedValue);
    const radians = ((90 - clampedSigned) * Math.PI) / 180;
    return {
      x: DIAL_CENTER_X + Math.cos(radians) * radius,
      y: DIAL_CENTER_Y - Math.sin(radians) * radius,
    };
  }

  bindEvent_(target, type, handler) {
    if (!target) {
      return;
    }
    target.addEventListener(type, handler);
    this.boundEvents_.push({ target, type, handler });
  }

  disposeDropdownEditor_() {
    this.isDialDragging_ = false;
    for (const binding of this.boundEvents_) {
      binding.target.removeEventListener(binding.type, binding.handler);
    }
    this.boundEvents_.length = 0;

    this.dropdownRoot_ = null;
    this.svgRoot_ = null;
    this.gaugePath_ = null;
    this.pointerLine_ = null;
    this.pointerDot_ = null;
    this.inputEl_ = null;
  }

  adjustSignedBy_(delta) {
    const current = this.storedToSigned_(this.getValue());
    this.setSignedValue_(current + delta, true);
    this.syncDropdownUIFromValue_();
  }

  setSignedValue_(signedValue, fireIntermediateChange) {
    const stored = this.signedToStored_(signedValue);
    this.displayStoredValue_(stored, fireIntermediateChange);
  }

  displayStoredValue_(storedValue, fireIntermediateChange) {
    const next = this.normalizeStored_(storedValue);
    if (next === this.getValue()) {
      return;
    }

    const oldValue = this.getValue();
    this.setEditorValue_(next, false);

    if (
      fireIntermediateChange &&
      this.sourceBlock_ &&
      Blockly.Events.isEnabled() &&
      next !== oldValue
    ) {
      const IntermediateEvent = Blockly.Events.get(
        Blockly.Events.BLOCK_FIELD_INTERMEDIATE_CHANGE
      );
      if (IntermediateEvent) {
        Blockly.Events.fire(
          new IntermediateEvent(this.sourceBlock_, this.name || null, oldValue, next)
        );
      }
    }
  }

  updateSignedFromPointer_(event) {
    if (!this.svgRoot_) {
      return;
    }

    const rect = this.svgRoot_.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = Math.min(event.clientY - rect.top, DIAL_CENTER_Y);

    const dx = x - DIAL_CENTER_X;
    const dy = y - DIAL_CENTER_Y;

    if (dx === 0 && dy === 0) {
      return;
    }

    let radians = Math.atan2(-dy, dx);
    radians = clamp(radians, 0, Math.PI);

    const signed = Math.round(90 - (radians * 180) / Math.PI);
    this.setSignedValue_(signed, true);
    this.syncDropdownUIFromValue_(false);
  }

  syncDropdownUIFromValue_(updateInput = true) {
    const signed = this.storedToSigned_(this.getValue());
    if (updateInput && this.inputEl_) {
      this.inputEl_.value = this.formatSigned_(signed);
    }

    if (!this.pointerLine_ || !this.pointerDot_ || !this.gaugePath_) {
      return;
    }

    const point = this.getPointOnArc_(signed, DIAL_RADIUS - 1);

    this.pointerLine_.setAttribute("x2", `${point.x}`);
    this.pointerLine_.setAttribute("y2", `${point.y}`);

    this.pointerDot_.setAttribute("cx", `${point.x}`);
    this.pointerDot_.setAttribute("cy", `${point.y}`);

    const center = `${DIAL_CENTER_X} ${DIAL_CENTER_Y}`;
    const left = this.getPointOnArc_(SIGNED_MIN, DIAL_RADIUS - 1);
    const largeArcFlag = signed > 0 ? 1 : 0;
    const gauge = [
      `M ${center}`,
      `L ${left.x} ${left.y}`,
      `A ${DIAL_RADIUS - 1} ${DIAL_RADIUS - 1} 0 ${largeArcFlag} 1 ${point.x} ${point.y}`,
      "Z",
    ].join(" ");
    this.gaugePath_.setAttribute("d", gauge);
  }
}

Blockly.Css.register(`
.blocklySignedAngleDropdown {
  width: ${DIAL_WIDTH}px;
  padding: 8px 10px 6px;
  user-select: none;
}

.blocklySignedAngleInputRow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #333;
}

.blocklySignedAngleInputLabel {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.blocklySignedAngleInput {
  width: 68px;
  height: 28px;
  border: 1px solid #9aa0a6;
  border-radius: 6px;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  color: #202124;
  background: #fff;
  outline: none;
}

.blocklySignedAngleInput:focus {
  border-color: #5c6bc0;
  box-shadow: 0 0 0 2px rgba(92, 107, 192, 0.2);
}

.blocklySignedAngleInputSuffix {
  font-size: 13px;
  color: #666;
}

.blocklySignedAngleDial {
  display: block;
  touch-action: none;
  cursor: crosshair;
}

.blocklySignedAngleArc {
  fill: none;
  stroke: #444;
  stroke-width: 2;
}

.blocklySignedAngleTickMinor {
  stroke: #666;
  stroke-width: 1;
}

.blocklySignedAngleTickMajor {
  stroke: #444;
  stroke-width: 1.5;
}

.blocklySignedAngleLabel {
  fill: #444;
  font-size: 10px;
  dominant-baseline: middle;
}

.blocklySignedAngleGauge {
  fill: rgba(248, 128, 128, 0.28);
  pointer-events: none;
}

.blocklySignedAnglePointer {
  stroke: #d83939;
  stroke-width: 2.5;
  stroke-linecap: round;
  pointer-events: none;
}

.blocklySignedAnglePointerDot {
  fill: #d83939;
  pointer-events: none;
}

.blocklySignedAngleCenterDot {
  fill: #333;
  pointer-events: none;
}
`);

export function registerFieldSignedAngle() {
  Blockly.fieldRegistry.register("field_signed_angle", FieldSignedAngle);
}
