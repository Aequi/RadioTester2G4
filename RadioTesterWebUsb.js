"use strict";

const VENDOR_ID = 0xCAFE;
const PRODUCT_ID = 0x4011;
const CONFIGURATION = 1;
const INTERFACE = 2;
const ENDPOINT = 3;
const PACKET_SIZE = 51;
const FRAME_SIZE = 60;
const FRAME_HEADER_SIZE = 5;
const STATUS_PAYLOAD_SIZE = 51;
const VERSION_2_STATUS_PAYLOAD_SIZE = 47;
const LEGACY_STATUS_PACKET_SIZE = 50;
const PROTOCOL_VERSION = 3;
const PACKET_TYPE_RSSI = 1;
const PACKET_TYPE_STATUS = 2;
const MODULE_COUNT = 10;
const FIRST_FREQUENCY_MHZ = 2400;
const FREQUENCY_STEP_MHZ = 2;
const MIN_RSSI_DBM = -110;
const MAX_RSSI_DBM = -20;
const HISTORY_ROWS = 420;
const SPECTRUM_DECAY_DIVISOR = 128;
const WATERFALL_DECAY_DIVISOR = 4;

const COMMAND = Object.freeze({
  STOP: 0,
  START: 1,
  SET_SETTINGS: 2,
  SAVE: 3,
  GET_STATUS: 4,
});

const POWER_LABELS = ["−12 dBm", "−6 dBm", "−4 dBm", "0 dBm", "+1 dBm", "+3 dBm", "+4 dBm"];

const elements = Object.fromEntries([
  "connectButton", "connectLabel", "statusPill", "statusText", "deviceIdentity",
  "compatibilityNote", "compatibilityText", "toast", "peakRssi", "peakFrequency",
  "noiseFloor", "packetRate", "packetTotal", "sourceCard", "sourceStatus",
  "sourceDetail", "selectedFrequency", "selectedRssi", "spectrumCanvas", "spectrumWrap",
  "waterfallCanvas", "waterfallWrap", "emptyState", "freezeButton", "clearButton",
  "gainInput", "gainValue", "waterfallRate", "runState", "runStateText",
  "enabledCount", "moduleGrid",
  "selectedModuleTitle", "moduleEnabled", "moduleEnabledText", "startChannel",
  "startFrequency", "stopChannel", "stopFrequency", "powerSelect", "previewBand",
  "overallSweepBands", "validationMessage", "commandStatus", "configurationState",
  "reloadButton", "applyButton", "saveButton", "runButton",
].map((id) => [id, document.querySelector(`#${id}`)]));

const defaultModules = () => Array.from({ length: MODULE_COUNT }, () => ({
  enabled: false,
  startChannel: 0,
  stopChannel: 50,
  power: 0,
}));

const state = {
  device: null,
  connected: false,
  connecting: false,
  receiverActive: false,
  frozen: false,
  hasData: false,
  packetCount: 0,
  invalidTransferCount: 0,
  ratePacketCount: 0,
  packetRate: 0,
  rateStartedAt: performance.now(),
  packetSequence: 0,
  lastWaterfallSequence: -1,
  lastWaterfallAt: 0,
  lastMetricsAt: 0,
  selectedChannel: 25,
  waterfallGain: 0.15,
  waterfallFps: 50,
  latest: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  smoothed: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  waterfallPeak: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  waterfallSmoothed: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  selectedModule: 0,
  modules: defaultModules(),
  deviceModules: defaultModules(),
  settingsKnown: false,
  dirty: false,
  transmitting: false,
  loadedSavedSettings: false,
  hostDeviceMounted: false,
  rssiDongleMounted: false,
  revision: 0,
  commandSequence: 0,
  protocolVersion: 0,
  pendingCommand: null,
  commandChain: Promise.resolve(),
  wakeLock: null,
};

let toastTimer = 0;
let statusPollTimer = 0;
let chartDirty = true;
const moduleButtons = [];
const sweepBands = [];
const spectrumSurface = createSurface(elements.spectrumCanvas, elements.spectrumWrap);
const waterfallSurface = createSurface(elements.waterfallCanvas, elements.waterfallWrap);
const historyCanvas = document.createElement("canvas");
historyCanvas.width = PACKET_SIZE;
historyCanvas.height = HISTORY_ROWS;
const historyContext = historyCanvas.getContext("2d", { alpha: false });
const historyRow = historyContext.createImageData(PACKET_SIZE, 1);
const colorLut = buildColorLut();

function createSurface(canvas, container) {
  const context = canvas.getContext("2d", { alpha: false });
  const surface = { canvas, container, context, width: 0, height: 0, dpr: 1 };
  surface.resize = () => {
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === pixelWidth && canvas.height === pixelHeight) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    surface.width = rect.width;
    surface.height = rect.height;
    surface.dpr = dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartDirty = true;
  };
  new ResizeObserver(surface.resize).observe(container);
  surface.resize();
  return surface;
}

function buildColorLut() {
  const stops = [
    [0, [7, 10, 28]], [.18, [49, 35, 139]], [.38, [25, 109, 190]],
    [.57, [21, 194, 194]], [.74, [127, 232, 111]], [.88, [255, 218, 75]],
    [1, [255, 83, 105]],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const position = index / 255;
    let left = stops[0];
    let right = stops.at(-1);
    for (let stop = 1; stop < stops.length; stop += 1) {
      if (position <= stops[stop][0]) {
        left = stops[stop - 1];
        right = stops[stop];
        break;
      }
    }
    const mix = (position - left[0]) / Math.max(.0001, right[0] - left[0]);
    const offset = index * 4;
    for (let color = 0; color < 3; color += 1) {
      lut[offset + color] = Math.round(left[1][color] + (right[1][color] - left[1][color]) * mix);
    }
    lut[offset + 3] = 255;
  }
  return lut;
}

function rssiToColorIndex(rssi) {
  const normalized = Math.max(0, Math.min(1, (rssi - MIN_RSSI_DBM) / (MAX_RSSI_DBM - MIN_RSSI_DBM)));
  return Math.round(Math.pow(normalized, 1.25 - state.waterfallGain * .85) * 255);
}

function colorCss(rssi, alpha = 1) {
  const offset = rssiToColorIndex(rssi) * 4;
  return `rgba(${colorLut[offset]},${colorLut[offset + 1]},${colorLut[offset + 2]},${alpha})`;
}

function frequencyForChannel(channel) {
  return FIRST_FREQUENCY_MHZ + channel * FREQUENCY_STEP_MHZ;
}

function sweepBandGeometry(module) {
  return {
    left: module.startChannel / PACKET_SIZE * 100,
    width: (module.stopChannel - module.startChannel + 1) / PACKET_SIZE * 100,
  };
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  toastTimer = window.setTimeout(() => { elements.toast.dataset.visible = "false"; }, 4200);
}

function setConnectionUi(mode, message) {
  elements.statusPill.dataset.state = mode;
  elements.statusText.textContent = message;
  elements.connectButton.disabled = mode === "connecting";
  elements.connectLabel.textContent = mode === "connected" ? "Disconnect" : mode === "connecting" ? "Opening…" : "Connect device";
  updateRfUi();
  updateSourceUi();
}

function updateSourceUi() {
  let sourceState = "offline";
  let title = "Offline";
  let detail = state.connected ? "No USB host device detected" : "Connect RadioTester2G4";
  if (state.connected && state.rssiDongleMounted) {
    sourceState = "ready";
    title = state.hasData ? "Live" : "Ready";
    detail = state.hasData ? "Valid 51-byte sweeps" : "RSSI dongle mounted";
  } else if (state.connected && state.hostDeviceMounted) {
    sourceState = "unknown";
    title = "Unknown device";
    detail = "Host device is not an RSSI dongle";
  }
  elements.sourceCard.dataset.state = sourceState;
  elements.sourceStatus.textContent = title;
  elements.sourceDetail.textContent = detail;
}

// Match the firmware filter: stronger samples attack immediately, while weaker
// samples decay by one divisor step per update.
function filterRssi(filtered, sample, decayDivisor) {
  const filteredFixed = Math.round(filtered * 256);
  const sampleFixed = Math.round(sample * 256);
  if (sampleFixed >= filteredFixed) return sampleFixed / 256;
  const difference = filteredFixed - sampleFixed;
  return (filteredFixed - Math.ceil(difference / decayDivisor)) / 256;
}

function acceptRssiPacket(packet) {
  for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
    const rssi = Math.max(MIN_RSSI_DBM, Math.min(MAX_RSSI_DBM, -packet[channel]));
    state.latest[channel] = rssi;
    state.smoothed[channel] = state.hasData
      ? filterRssi(state.smoothed[channel], rssi, SPECTRUM_DECAY_DIVISOR)
      : rssi;
    state.waterfallPeak[channel] = state.hasData
      ? Math.max(state.waterfallPeak[channel], rssi)
      : rssi;
    if (!state.hasData) {
      state.waterfallSmoothed[channel] = rssi;
    }
  }
  state.hasData = true;
  state.packetCount += 1;
  state.ratePacketCount += 1;
  state.packetSequence += 1;
  elements.emptyState.dataset.hidden = "true";
  updateSourceUi();
  chartDirty = true;
}

function spectrumGeometry(surface) {
  return { left: surface.width < 430 ? 40 : 48, top: 15, right: 14, bottom: 28 };
}

function drawSpectrum() {
  spectrumSurface.resize();
  const { context, width, height } = spectrumSurface;
  if (!width || !height) return;
  const margin = spectrumGeometry(spectrumSurface);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const bottom = margin.top + plotHeight;
  const yForRssi = (rssi) => bottom - (rssi - MIN_RSSI_DBM) / (MAX_RSSI_DBM - MIN_RSSI_DBM) * plotHeight;
  context.fillStyle = "#0a1017";
  context.fillRect(0, 0, width, height);
  context.font = "10px ui-sans-serif,system-ui,sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.lineWidth = 1;
  for (let rssi = -100; rssi <= -20; rssi += 20) {
    const y = yForRssi(rssi);
    context.strokeStyle = "rgba(190,204,222,.17)";
    context.beginPath();
    context.moveTo(margin.left, y + .5);
    context.lineTo(margin.left + plotWidth, y + .5);
    context.stroke();
    context.fillStyle = "#91a0b1";
    context.fillText(String(rssi), margin.left - 7, y);
  }
  for (let frequency = 2400; frequency <= 2500; frequency += 20) {
    const x = margin.left + (frequency - 2400) / 100 * plotWidth;
    context.strokeStyle = "rgba(190,204,222,.09)";
    context.beginPath();
    context.moveTo(x + .5, margin.top);
    context.lineTo(x + .5, bottom);
    context.stroke();
  }
  if (state.hasData) {
    const fill = context.createLinearGradient(0, margin.top, 0, bottom);
    fill.addColorStop(0, "rgba(92,225,255,.25)");
    fill.addColorStop(1, "rgba(92,225,255,.015)");
    context.beginPath();
    for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
      const x = margin.left + channel / (PACKET_SIZE - 1) * plotWidth;
      const y = yForRssi(state.smoothed[channel]);
      if (channel === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.lineTo(margin.left + plotWidth, bottom);
    context.lineTo(margin.left, bottom);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.beginPath();
    for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
      const x = margin.left + channel / (PACKET_SIZE - 1) * plotWidth;
      const y = yForRssi(state.smoothed[channel]);
      if (channel === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.strokeStyle = "#5ce1ff";
    context.lineWidth = 2;
    context.shadowColor = "rgba(92,225,255,.6)";
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;
  }
  const selectedX = margin.left + state.selectedChannel / (PACKET_SIZE - 1) * plotWidth;
  context.strokeStyle = "rgba(255,255,255,.44)";
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(selectedX, margin.top);
  context.lineTo(selectedX, bottom);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#91a0b1";
  context.textBaseline = "bottom";
  context.textAlign = "left";
  context.fillText("2400", margin.left, height - 5);
  context.textAlign = "center";
  context.fillText("2450 MHz", margin.left + plotWidth / 2, height - 5);
  context.textAlign = "right";
  context.fillText("2500", margin.left + plotWidth, height - 5);
}

function appendWaterfallRow() {
  historyContext.drawImage(historyCanvas, 0, 0, PACKET_SIZE, HISTORY_ROWS - 1, 0, 1, PACKET_SIZE, HISTORY_ROWS - 1);
  for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
    const observed = state.waterfallPeak[channel];
    state.waterfallSmoothed[channel] = filterRssi(
      state.waterfallSmoothed[channel], observed, WATERFALL_DECAY_DIVISOR);
    const source = rssiToColorIndex(state.waterfallSmoothed[channel]) * 4;
    const destination = channel * 4;
    historyRow.data[destination] = colorLut[source];
    historyRow.data[destination + 1] = colorLut[source + 1];
    historyRow.data[destination + 2] = colorLut[source + 2];
    historyRow.data[destination + 3] = 255;
    state.waterfallPeak[channel] = MIN_RSSI_DBM;
  }
  historyContext.putImageData(historyRow, 0, 0);
}

function drawWaterfall() {
  waterfallSurface.resize();
  const { context, width, height } = waterfallSurface;
  if (!width || !height) return;
  context.fillStyle = "#070a15";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(historyCanvas, 10, 8, width - 20, height - 32);
  context.fillStyle = "#91a0b1";
  context.font = "10px ui-sans-serif,system-ui,sans-serif";
  context.textBaseline = "bottom";
  context.textAlign = "left";
  context.fillText("2400", 10, height - 5);
  context.textAlign = "center";
  context.fillText("2450 MHz", width / 2, height - 5);
  context.textAlign = "right";
  context.fillText("2500", width - 10, height - 5);
}

function clearWaterfall() {
  historyContext.fillStyle = "#070a15";
  historyContext.fillRect(0, 0, PACKET_SIZE, HISTORY_ROWS);
  state.lastWaterfallSequence = state.packetSequence;
  chartDirty = true;
}

function updateMetrics(now) {
  const elapsed = now - state.rateStartedAt;
  if (elapsed >= 500) {
    const instantRate = state.ratePacketCount * 1000 / elapsed;
    state.packetRate = state.packetRate ? state.packetRate * .7 + instantRate * .3 : instantRate;
    state.ratePacketCount = 0;
    state.rateStartedAt = now;
  }
  if (!state.hasData) return;
  let peakChannel = 0;
  for (let channel = 1; channel < PACKET_SIZE; channel += 1) {
    if (state.smoothed[channel] > state.smoothed[peakChannel]) peakChannel = channel;
  }
  const sorted = Array.from(state.latest).sort((a, b) => a - b);
  elements.peakRssi.textContent = `${Math.round(state.smoothed[peakChannel])} dBm`;
  elements.peakFrequency.textContent = `${frequencyForChannel(peakChannel)} MHz · channel ${peakChannel}`;
  elements.noiseFloor.textContent = `${Math.round(sorted[Math.floor(PACKET_SIZE / 2)])} dBm`;
  elements.packetRate.textContent = `${state.packetRate.toFixed(state.packetRate < 100 ? 1 : 0)} /s`;
  elements.packetTotal.textContent = `${state.packetCount.toLocaleString()} sweeps received`;
  updateSelectedReadout();
}

function updateSelectedReadout() {
  elements.selectedFrequency.textContent = `${frequencyForChannel(state.selectedChannel)} MHz`;
  elements.selectedRssi.textContent = state.hasData
    ? `${Math.round(state.smoothed[state.selectedChannel])} dBm`
    : "— dBm";
}

function animationFrame(now) {
  const shouldAppend = state.hasData && !state.frozen
    && state.packetSequence !== state.lastWaterfallSequence
    && now - state.lastWaterfallAt >= 1000 / state.waterfallFps;
  if (shouldAppend) {
    appendWaterfallRow();
    state.lastWaterfallSequence = state.packetSequence;
    state.lastWaterfallAt = now;
    chartDirty = true;
  }
  if (chartDirty && !state.frozen) {
    if (now - state.lastMetricsAt >= 250) {
      updateMetrics(now);
      state.lastMetricsAt = now;
    }
    drawSpectrum();
    drawWaterfall();
    chartDirty = false;
  } else if (state.connected && now - state.rateStartedAt >= 500) {
    updateMetrics(now);
  }
  requestAnimationFrame(animationFrame);
}

function cloneModules(modules) {
  return modules.map((module) => ({ ...module }));
}

function moduleSettingsMatch(left, right) {
  return left.every((module, index) => {
    const other = right[index];
    return other
      && module.enabled === other.enabled
      && module.startChannel === other.startChannel
      && module.stopChannel === other.stopChannel
      && module.power === other.power;
  });
}

function createModuleButtons() {
  for (let module = 0; module < MODULE_COUNT; module += 1) {
    const button = document.createElement("button");
    button.className = "module-button";
    button.type = "button";
    button.setAttribute("role", "listitem");
    button.innerHTML = `<strong>${module + 1}</strong><span>Disabled</span>`;
    button.addEventListener("click", () => {
      state.selectedModule = module;
      updateRfUi();
    });
    elements.moduleGrid.append(button);
    moduleButtons.push(button);

    const sweepBand = document.createElement("span");
    sweepBand.className = "overall-sweep-band";
    elements.overallSweepBands.append(sweepBand);
    sweepBands.push(sweepBand);
  }
}

function validateSettings() {
  for (let index = 0; index < MODULE_COUNT; index += 1) {
    const module = state.modules[index];
    if (!Number.isInteger(module.startChannel) || !Number.isInteger(module.stopChannel)
        || module.startChannel < 0 || module.stopChannel > 50
        || module.startChannel > module.stopChannel) {
      return `Module ${index + 1} needs a valid channel range from 0 to 50.`;
    }
    if (!Number.isInteger(module.power) || module.power < 0 || module.power >= POWER_LABELS.length) {
      return `Module ${index + 1} has an invalid power setting.`;
    }
  }
  return "";
}

function updateRfUi() {
  const module = state.modules[state.selectedModule];
  const enabledCount = state.modules.filter((item) => item.enabled).length;
  moduleButtons.forEach((button, index) => {
    button.classList.toggle("selected", index === state.selectedModule);
    button.classList.toggle("enabled", state.modules[index].enabled);
    button.disabled = !state.settingsKnown;
    button.querySelector("span").textContent = state.modules[index].enabled ? "Enabled" : "Disabled";
  });
  sweepBands.forEach((band, index) => {
    const sweepModule = state.modules[index];
    const geometry = sweepBandGeometry(sweepModule);
    band.hidden = !sweepModule.enabled || index === state.selectedModule;
    band.style.left = `${geometry.left}%`;
    band.style.width = `${geometry.width}%`;
  });
  elements.selectedModuleTitle.textContent = `Module ${state.selectedModule + 1}`;
  elements.moduleEnabled.checked = module.enabled;
  elements.moduleEnabledText.textContent = module.enabled ? "Enabled" : "Disabled";
  elements.startChannel.value = module.startChannel;
  elements.stopChannel.value = module.stopChannel;
  elements.powerSelect.value = module.power;
  elements.startFrequency.textContent = `${frequencyForChannel(module.startChannel)} MHz`;
  elements.stopFrequency.textContent = `${frequencyForChannel(module.stopChannel)} MHz`;
  const previewGeometry = sweepBandGeometry(module);
  elements.previewBand.style.left = `${previewGeometry.left}%`;
  elements.previewBand.style.width = `${previewGeometry.width}%`;
  elements.enabledCount.textContent = `${enabledCount} / ${MODULE_COUNT} enabled`;
  elements.runState.dataset.state = state.transmitting ? "running" : "stopped";
  elements.runStateText.textContent = state.transmitting ? "Transmitting" : "Stopped";
  elements.runButton.dataset.running = String(state.transmitting);
  elements.runButton.textContent = state.transmitting ? "Stop transmission" : "Start transmission";
  const validation = validateSettings();
  elements.validationMessage.textContent = validation;
  const canControl = state.connected && state.settingsKnown && !state.pendingCommand;
  elements.moduleEnabled.disabled = !state.settingsKnown;
  elements.startChannel.disabled = !state.settingsKnown;
  elements.stopChannel.disabled = !state.settingsKnown;
  elements.powerSelect.disabled = !state.settingsKnown;
  elements.reloadButton.disabled = !canControl;
  elements.applyButton.disabled = !canControl || !state.dirty || Boolean(validation);
  elements.saveButton.disabled = !canControl || Boolean(validation);
  elements.runButton.disabled = !canControl || Boolean(validation) || (!state.transmitting && enabledCount === 0);
  const commandStatus = document.querySelector(".command-status");
  commandStatus.classList.toggle("dirty", state.dirty);
  commandStatus.classList.toggle("synced", state.connected && state.settingsKnown && !state.dirty);
  if (!state.connected) {
    elements.commandStatus.textContent = "Connect to configure RF modules";
    elements.configurationState.textContent = "Device settings unavailable";
  } else if (!state.settingsKnown) {
    if (state.protocolVersion === 1) {
      elements.commandStatus.textContent = "Firmware update required";
      elements.configurationState.textContent = "Protocol 1 provides RSSI only";
    } else {
      elements.commandStatus.textContent = "Reading device configuration…";
      elements.configurationState.textContent = "Please wait";
    }
  } else if (state.dirty) {
    elements.commandStatus.textContent = "Unsaved edits";
    elements.configurationState.textContent = "Apply to update the running device";
  } else {
    elements.commandStatus.textContent = "Configuration synchronized";
    elements.configurationState.textContent = `Protocol ${state.protocolVersion} · revision ${state.revision}${state.loadedSavedSettings ? " · restored from flash at startup" : ""}`;
  }
}

function markSettingsChanged() {
  state.dirty = !moduleSettingsMatch(state.modules, state.deviceModules);
  updateRfUi();
}

function updateSelectedModuleFromInputs() {
  const module = state.modules[state.selectedModule];
  module.enabled = elements.moduleEnabled.checked;
  module.startChannel = Number(elements.startChannel.value);
  module.stopChannel = Number(elements.stopChannel.value);
  module.power = Number(elements.powerSelect.value);
  markSettingsChanged();
}

function encodeSettingsCommand() {
  const packet = new Uint8Array(1 + MODULE_COUNT * 4);
  packet[0] = COMMAND.SET_SETTINGS;
  state.modules.forEach((module, index) => {
    const offset = 1 + index * 4;
    packet[offset] = module.enabled ? 1 : 0;
    packet[offset + 1] = module.startChannel;
    packet[offset + 2] = module.stopChannel;
    packet[offset + 3] = module.power;
  });
  return packet;
}

function acceptStatus(packet, payloadOffset, hasCommandSequence, forceSync = false) {
  const payloadSize = hasCommandSequence
    ? STATUS_PAYLOAD_SIZE
    : VERSION_2_STATUS_PAYLOAD_SIZE;
  if (packet.byteLength < payloadOffset + payloadSize) return false;
  const flags = packet[payloadOffset];
  const command = packet[payloadOffset + 1];
  const succeeded = packet[payloadOffset + 2] === 1;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const revision = view.getUint32(payloadOffset + 3, true);
  const commandSequence = hasCommandSequence
    ? view.getUint32(payloadOffset + 7, true)
    : state.commandSequence;
  const settingsOffset = payloadOffset + (hasCommandSequence ? 11 : 7);
  const modules = [];
  for (let index = 0; index < MODULE_COUNT; index += 1) {
    const offset = settingsOffset + index * 4;
    modules.push({
      enabled: packet[offset] === 1,
      startChannel: packet[offset + 1],
      stopChannel: packet[offset + 2],
      power: packet[offset + 3],
    });
  }
  state.transmitting = Boolean(flags & 0x01);
  state.loadedSavedSettings = Boolean(flags & 0x02);
  state.hostDeviceMounted = Boolean(flags & 0x04);
  state.rssiDongleMounted = Boolean(flags & 0x08);
  state.revision = revision;
  state.commandSequence = commandSequence;
  state.deviceModules = cloneModules(modules);
  if (!state.dirty || state.pendingCommand?.forceSync || forceSync) {
    state.modules = cloneModules(modules);
    state.dirty = false;
  } else {
    state.dirty = !moduleSettingsMatch(state.modules, state.deviceModules);
  }
  state.settingsKnown = true;
  updateSourceUi();
  const pendingSequenceChanged = !hasCommandSequence
    || state.pendingCommand?.baselineSequence !== commandSequence;
  if (state.pendingCommand && state.pendingCommand.command === command
      && pendingSequenceChanged) {
    const pending = state.pendingCommand;
    state.pendingCommand = null;
    window.clearTimeout(pending.timer);
    if (succeeded) pending.resolve(); else pending.reject(new Error(`${commandName(command)} failed on the device.`));
  }
  updateRfUi();
  return true;
}

function acceptTransfer(packet, forceSync = false) {
  const framed = packet.byteLength === FRAME_SIZE
    && packet[0] === 0x52
    && packet[1] === 0x54
    && (packet[2] === PROTOCOL_VERSION || packet[2] === 2);

  if (framed) {
    const protocolVersion = packet[2];
    const packetType = packet[3];
    const payloadLength = packet[4];

    if (payloadLength > FRAME_SIZE - FRAME_HEADER_SIZE) return false;
    const protocolChanged = state.protocolVersion !== protocolVersion;
    state.protocolVersion = protocolVersion;
    if (protocolChanged) updateRfUi();
    if (packetType === PACKET_TYPE_RSSI && payloadLength === PACKET_SIZE) {
      acceptRssiPacket(packet.subarray(FRAME_HEADER_SIZE,
                                       FRAME_HEADER_SIZE + PACKET_SIZE));
      return true;
    }
    if (packetType === PACKET_TYPE_STATUS
        && payloadLength === STATUS_PAYLOAD_SIZE) {
      return acceptStatus(packet, FRAME_HEADER_SIZE, true, forceSync);
    }
    if (protocolVersion === 2 && packetType === PACKET_TYPE_STATUS
        && payloadLength === VERSION_2_STATUS_PAYLOAD_SIZE) {
      return acceptStatus(packet, FRAME_HEADER_SIZE, false, forceSync);
    }
    return false;
  }

  // Version 1 used unframed short transfers. Keep reading those RSSI and
  // status packets so the UI remains useful while a device is being updated.
  if (packet.byteLength === PACKET_SIZE) {
    if (state.protocolVersion === 0) {
      state.protocolVersion = 1;
      updateRfUi();
    }
    acceptRssiPacket(packet);
    return true;
  }
  if (packet.byteLength === LEGACY_STATUS_PACKET_SIZE
      && packet[0] === 0x52
      && packet[1] === 0x54
      && packet[2] === 1) {
    state.protocolVersion = 1;
    return acceptStatus(packet, 3, false, forceSync);
  }
  return false;
}

function commandName(command) {
  return ["Stop transmission", "Start transmission", "Apply settings", "Save settings", "Read status"][command] || "Command";
}

function sendCommand(command, payload = new Uint8Array([command]), forceSync = false) {
  const operation = () => sendCommandNow(command, payload, forceSync);
  const queued = state.commandChain.then(operation, operation);
  state.commandChain = queued.catch(() => {});
  return queued;
}

async function sendCommandNow(command, payload, forceSync) {
  if (!state.connected || !state.device) throw new Error("RadioTester2G4 is not connected.");
  if (state.pendingCommand) throw new Error("Another device command is still pending.");
  return new Promise(async (resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (state.pendingCommand?.command === command) state.pendingCommand = null;
      updateRfUi();
      reject(new Error(`${commandName(command)} timed out.`));
    }, 2500);
    const pending = {
      command,
      resolve,
      reject,
      timer,
      forceSync,
      baselineSequence: state.commandSequence,
    };
    state.pendingCommand = pending;
    updateRfUi();
    try {
      const result = await state.device.transferOut(ENDPOINT, payload);
      if (result.status !== "ok" || result.bytesWritten !== payload.byteLength) {
        throw new Error(`${commandName(command)} was not transferred completely.`);
      }
      if (state.protocolVersion >= 3) pollCommandStatus(state.device, pending);
    } catch (error) {
      window.clearTimeout(timer);
      state.pendingCommand = null;
      updateRfUi();
      reject(error);
    }
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function readDeviceStatus(forceSync = false) {
  if (!state.connected || !state.device) {
    throw new Error("RadioTester2G4 is not connected.");
  }
  const result = await state.device.controlTransferIn({
    requestType: "vendor",
    recipient: "interface",
    request: 3,
    value: 0,
    index: INTERFACE,
  }, FRAME_SIZE);
  if (result.status !== "ok") {
    throw new Error(`Status control transfer returned ${result.status}.`);
  }
  const packet = new Uint8Array(result.data.buffer,
                                result.data.byteOffset,
                                result.data.byteLength);
  if (!acceptTransfer(packet, forceSync)
      || state.protocolVersion < PROTOCOL_VERSION) {
    throw new Error("The device returned an unsupported status response.");
  }
}

async function pollCommandStatus(device, pending) {
  while (state.connected && state.device === device
         && state.pendingCommand === pending) {
    await delay(20);
    try {
      await readDeviceStatus(pending.forceSync);
    } catch {
      // The command timeout reports a persistent control-transfer failure.
    }
  }
}

async function receiveLoop(device) {
  try {
    while (state.receiverActive && state.device === device) {
      const result = await device.transferIn(ENDPOINT, FRAME_SIZE);
      if (result.status !== "ok") continue;
      const packet = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (!acceptTransfer(packet)) {
        state.invalidTransferCount += 1;
        console.warn("Ignored malformed WebUSB transfer", packet);
      }
    }
  } catch (error) {
    if (state.receiverActive && state.device === device) {
      showToast(`WebUSB stream stopped: ${friendlyError(error)}`);
      await disconnectDevice(false);
    }
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch { state.wakeLock = null; }
}

async function openDevice(device) {
  state.connecting = true;
  setConnectionUi("connecting", "Opening device");
  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(CONFIGURATION);
    await device.claimInterface(INTERFACE);
    await device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: 0x22,
      value: 1,
      index: INTERFACE,
    });
    state.device = device;
    state.connected = true;
    state.connecting = false;
    state.receiverActive = true;
    state.settingsKnown = false;
    state.dirty = false;
    state.protocolVersion = 0;
    state.commandSequence = 0;
    state.hasData = false;
    state.packetCount = 0;
    state.invalidTransferCount = 0;
    state.ratePacketCount = 0;
    state.packetRate = 0;
    state.rateStartedAt = performance.now();
    clearWaterfall();
    elements.emptyState.dataset.hidden = "false";
    const deviceVersion = `${device.deviceVersionMajor}.${device.deviceVersionMinor}`;
    elements.deviceIdentity.textContent = `${device.productName || "RadioTester2G4"} · USB ${deviceVersion} · ${device.serialNumber || "No serial"}`;
    setConnectionUi("connected", "Connected");
    receiveLoop(device);
    await requestWakeLock();
    try {
      await readDeviceStatus(true);
    } catch (error) {
      showToast(`RSSI connected, but status is unavailable: ${friendlyError(error)}`);
    }
    startStatusPolling();
  } catch (error) {
    showToast(friendlyError(error));
    await disconnectDevice(true, device);
    setConnectionUi("error", "Connection failed");
  }
}

function startStatusPolling() {
  window.clearInterval(statusPollTimer);
  statusPollTimer = window.setInterval(() => {
    if (state.connected && !state.pendingCommand) {
      if (state.protocolVersion >= 3) {
        readDeviceStatus().catch(() => {});
      } else if (state.protocolVersion === 2) {
        sendCommand(COMMAND.GET_STATUS).catch(() => {});
      }
    }
  }, 2000);
}

async function disconnectDevice(closeDevice = true, fallbackDevice = null) {
  const device = state.device || fallbackDevice;
  state.receiverActive = false;
  state.connected = false;
  state.connecting = false;
  state.device = null;
  state.settingsKnown = false;
  state.hostDeviceMounted = false;
  state.rssiDongleMounted = false;
  window.clearInterval(statusPollTimer);
  if (state.pendingCommand) {
    window.clearTimeout(state.pendingCommand.timer);
    state.pendingCommand.reject(new Error("Device disconnected."));
    state.pendingCommand = null;
  }
  if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch { /* Already released. */ }
    state.wakeLock = null;
  }
  if (closeDevice && device?.opened) {
    try {
      await device.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 0, index: INTERFACE });
    } catch { /* Interface may already be unavailable. */ }
    try { await device.releaseInterface(INTERFACE); } catch { /* Device may be gone. */ }
    try { await device.close(); } catch { /* Device may be gone. */ }
  }
  setConnectionUi("idle", "Offline");
}

function friendlyError(error) {
  if (!error) return "Unable to open the device.";
  if (error.name === "NotFoundError") return "No device was selected.";
  if (error.name === "SecurityError") return "WebUSB requires HTTPS or localhost and permission to access the device.";
  if (error.name === "NetworkError") return "The device is busy or its WinUSB interface could not be claimed.";
  return error.message || String(error);
}

async function chooseDevice() {
  if (!("usb" in navigator)) {
    elements.compatibilityNote.hidden = false;
    showToast("This browser does not support WebUSB.");
    return;
  }
  if (state.connected) {
    await disconnectDevice();
    return;
  }
  try {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    await openDevice(device);
  } catch (error) {
    if (error.name !== "NotFoundError") showToast(friendlyError(error));
    setConnectionUi("idle", "Offline");
  }
}

async function reconnectKnownDevice() {
  if (!("usb" in navigator)) {
    elements.compatibilityNote.hidden = false;
    elements.connectButton.disabled = true;
    setConnectionUi("error", "Unsupported");
    return;
  }
  try {
    const devices = await navigator.usb.getDevices();
    const known = devices.find((device) => device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID);
    if (known) await openDevice(known);
  } catch { setConnectionUi("idle", "Offline"); }
}

async function applySettings() {
  const validation = validateSettings();
  if (validation) throw new Error(validation);
  await sendCommand(COMMAND.SET_SETTINGS, encodeSettingsCommand());
}

async function runAction(action, successMessage) {
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) { showToast(friendlyError(error)); }
}

function selectSpectrumChannel(event) {
  const rect = elements.spectrumCanvas.getBoundingClientRect();
  const margin = spectrumGeometry(spectrumSurface);
  const plotWidth = rect.width - margin.left - margin.right;
  const relative = Math.max(0, Math.min(plotWidth, event.clientX - rect.left - margin.left));
  state.selectedChannel = Math.max(0, Math.min(50, Math.round(relative / plotWidth * 50)));
  updateSelectedReadout();
  chartDirty = true;
}

elements.connectButton.addEventListener("click", chooseDevice);
elements.freezeButton.addEventListener("click", () => {
  state.frozen = !state.frozen;
  elements.freezeButton.setAttribute("aria-pressed", String(state.frozen));
  elements.freezeButton.textContent = state.frozen ? "Resume" : "Freeze";
  if (!state.frozen) chartDirty = true;
});
elements.clearButton.addEventListener("click", clearWaterfall);
elements.gainInput.addEventListener("input", () => {
  state.waterfallGain = Number(elements.gainInput.value) / 100;
  elements.gainValue.value = `${elements.gainInput.value}%`;
  try { localStorage.setItem("radio-tester-gain", elements.gainInput.value); } catch { /* Optional. */ }
  chartDirty = true;
});
elements.waterfallRate.addEventListener("change", () => {
  state.waterfallFps = Number(elements.waterfallRate.value);
  try { localStorage.setItem("radio-tester-waterfall-fps", elements.waterfallRate.value); } catch { /* Optional. */ }
});
elements.spectrumCanvas.addEventListener("pointerdown", selectSpectrumChannel);
elements.spectrumCanvas.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse") selectSpectrumChannel(event);
});
elements.moduleEnabled.addEventListener("change", updateSelectedModuleFromInputs);
elements.startChannel.addEventListener("input", updateSelectedModuleFromInputs);
elements.stopChannel.addEventListener("input", updateSelectedModuleFromInputs);
elements.powerSelect.addEventListener("change", updateSelectedModuleFromInputs);
elements.reloadButton.addEventListener("click", () => runAction(
  () => readDeviceStatus(true), "Configuration reloaded."));
elements.applyButton.addEventListener("click", () => runAction(applySettings, "RF settings applied."));
elements.saveButton.addEventListener("click", () => runAction(async () => {
  if (state.dirty) await applySettings();
  await sendCommand(COMMAND.SAVE);
}, "Configuration saved to flash."));
elements.runButton.addEventListener("click", () => {
  const stopping = state.transmitting;
  runAction(async () => {
    if (stopping) {
      await sendCommand(COMMAND.STOP);
    } else {
      if (state.dirty) await applySettings();
      await sendCommand(COMMAND.START);
    }
  }, stopping ? "RF transmission stopped." : "RF transmission started.");
});

if ("usb" in navigator) {
  navigator.usb.addEventListener("disconnect", (event) => {
    if (event.device === state.device) {
      disconnectDevice(false);
      showToast("RadioTester2G4 disconnected.");
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.connected && !state.wakeLock) requestWakeLock();
});

try {
  const gain = localStorage.getItem("radio-tester-gain");
  const fps = localStorage.getItem("radio-tester-waterfall-fps");
  if (gain !== null && Number(gain) >= 0 && Number(gain) <= 100) {
    elements.gainInput.value = gain;
    elements.gainValue.value = `${gain}%`;
    state.waterfallGain = Number(gain) / 100;
  }
  if (["15", "30", "50"].includes(fps)) {
    elements.waterfallRate.value = fps;
    state.waterfallFps = Number(fps);
  }
} catch { /* Local preferences are optional. */ }

if (!("usb" in navigator) && location.protocol === "file:") {
  elements.compatibilityText.textContent = "WebUSB cannot run from a file URL. Serve the Tools folder from localhost, then open it in Chrome or Edge.";
}

createModuleButtons();
clearWaterfall();
updateSelectedReadout();
updateRfUi();
requestAnimationFrame(animationFrame);
reconnectKnownDevice();
