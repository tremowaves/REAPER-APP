const { ipcRenderer } = require('electron');
const path = require('path');

let scannedFiles = [];
let selectedFolderPath = '';
let availablePresets = [];
let fxChainFolderPath = 'H:/REAPER-APP/Fxchain';
let fxChainPresets = [];

// Event listeners
document.getElementById('loadPresetsBtn').addEventListener('click', () => {
  ipcRenderer.send('open-rpp-dialog');
});

document.getElementById('reaperPathBtn').addEventListener('click', () => {
  ipcRenderer.send('select-reaper-path');
});

document.getElementById('audioFolderBtn').addEventListener('click', () => {
  ipcRenderer.send('open-folder-dialog');
});

document.getElementById('scanBtn').addEventListener('click', () => {
  if (selectedFolderPath) {
    ipcRenderer.send('scan-audio-files', selectedFolderPath);
  } else {
    document.getElementById('status').textContent = 'Please select a folder first!';
  }
});

document.getElementById('addRuleBtn').addEventListener('click', () => {
  addNewRule();
});

document.getElementById('processBtn').addEventListener('click', () => {
  if (scannedFiles.length === 0) {
    document.getElementById('status').textContent = 'Please scan folder first!';
    return;
  }
  
  const rules = getPresetRules();
  const outputSettings = {
    format: document.getElementById('outputFormat').value,
    autoFade: document.getElementById('autoFade').checked,
    normalize: document.getElementById('normalize').checked,
    peakDb: document.getElementById('peakDb').value
  };

  const processConfig = {
    folderPath: selectedFolderPath,
    files: scannedFiles,
    rules: rules,
    outputSettings: outputSettings
  };

  ipcRenderer.send('process-audio-smart', processConfig);
  document.getElementById('status').textContent = 'Processing started...';
});

// Handle remove rule buttons
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-rule')) {
    e.target.parentElement.remove();
    updateFilePreview();
  }
});

// Handle keyword input changes
document.addEventListener('input', (e) => {
  if (e.target.classList.contains('keyword')) {
    autoSelectPresetForKeyword(e.target);
    updateFilePreview();
  }
});

// IPC event handlers
ipcRenderer.on('settings-loaded', (event, settings) => {
  if (settings.reaperPath) {
    document.getElementById('reaperPathDisplay').textContent = settings.reaperPath;
    document.getElementById('reaperStatus').innerHTML = '<span class="status-ok">✓ REAPER path loaded</span>';
  }
  if (settings.audioFolderPath) {
    selectedFolderPath = settings.audioFolderPath;
    document.getElementById('audioFolderPath').textContent = settings.audioFolderPath;
  }
});

ipcRenderer.on('presets-loaded', (event, data) => {
  const { presets, path: rppPath } = data;
  availablePresets = presets;
  const statusEl = document.getElementById('presetsStatus');
  statusEl.innerHTML = `<span class="status-ok">✓ Loaded ${presets.length} presets from ${path.basename(rppPath)}.</span>`;
  updateAllPresetDropdowns();
  updateFilePreview();
});

ipcRenderer.on('presets-load-failed', (event, errorMessage) => {
  const statusEl = document.getElementById('presetsStatus');
  statusEl.innerHTML = `<span class="status-error">Error: ${errorMessage}</span>`;
});

ipcRenderer.on('reaper-path-selected', (event, reaperPath) => {
  document.getElementById('reaperPathDisplay').textContent = reaperPath;
  document.getElementById('reaperStatus').innerHTML = '<span class="status-ok">✓ REAPER path set successfully</span>';
});

ipcRenderer.on('selected-folder', (event, path) => {
  selectedFolderPath = path;
  document.getElementById('audioFolderPath').textContent = path;
  document.getElementById('fileList').innerHTML = '';
  scannedFiles = [];
});

ipcRenderer.on('scanned-files', (event, files) => {
  scannedFiles = files;
  document.getElementById('status').textContent = `Scan complete. Found ${files.length} audio files.`;
  updateFilePreview();
});

ipcRenderer.on('process-update', (event, message) => {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
});

ipcRenderer.on('process-done', (event, result) => {
  document.getElementById('status').textContent = result;
});

ipcRenderer.on('fxchain-presets-loaded', (event, { folder, presets }) => {
  fxChainFolderPath = folder;
  fxChainPresets = presets;
  document.getElementById('fxChainFolderPath').textContent = folder;
  updateAllPresetDropdowns();
});

// Helper functions
function generatePresetOptions() {
  if (fxChainPresets.length === 0) {
    return '<option value="">No FX Chain found. Please select folder.</option>';
  }
  return fxChainPresets.map(p => `<option value="${p.path}">${p.name}</option>`).join('');
}

function updateAllPresetDropdowns() {
  const presetOptions = generatePresetOptions();
  document.querySelectorAll('select.preset').forEach(select => {
    select.innerHTML = presetOptions;
  });
}

function addNewRule() {
  const rulesContainer = document.getElementById('presetRules');
  const ruleDiv = document.createElement('div');
  ruleDiv.className = 'rule-item';
  
  const presetOptions = generatePresetOptions();

  ruleDiv.innerHTML = `
    <label>Files containing:</label>
    <input type="text" class="keyword" placeholder="keyword">
    <label>use preset:</label>
    <select class="preset">
      ${presetOptions}
    </select>
    <button class="remove-rule">Remove</button>
  `;
  rulesContainer.appendChild(ruleDiv);
}

function getPresetRules() {
  const rules = [];
  const ruleItems = document.querySelectorAll('.rule-item');
  
  ruleItems.forEach(item => {
    const keyword = item.querySelector('.keyword').value.trim();
    const preset = item.querySelector('.preset').value;
    
    if (keyword && preset) {
      rules.push({ keyword: keyword.toLowerCase(), preset: preset });
    }
  });
  
  return rules;
}

function updateFilePreview() {
  const fileListDiv = document.getElementById('fileList');
  const rules = getPresetRules();
  
  if (scannedFiles.length === 0) {
    fileListDiv.innerHTML = '<p>No files scanned yet.</p>';
    return;
  }
  
  let html = `<p>Found ${scannedFiles.length} audio files:</p>`;
  
  scannedFiles.forEach(file => {
    const fileName = path.basename(file).toLowerCase();
    let matchedPresetPath = null;
    let matchedKeyword = 'n/a';
    
    // Check for matching rules
    for (const rule of rules) {
      if (rule.keyword && fileName.includes(rule.keyword)) {
        matchedPresetPath = rule.preset;
        matchedKeyword = rule.keyword;
        break;
      }
    }
    
    let presetDisplayName = '<i>(unmatched, will be moved)</i>';
    if (matchedPresetPath) {
      const matchedPreset = availablePresets.find(p => p.path === matchedPresetPath);
      presetDisplayName = matchedPreset ? matchedPreset.name : 'Unknown Preset';
    }

    html += `
      <div class="file-item">
        <strong>${path.basename(file)}</strong><br>
        <span class="preset-match">→ ${presetDisplayName} (matched by: ${matchedKeyword})</span>
      </div>
    `;
  });
  
  fileListDiv.innerHTML = html;
}

// Di chuyển phần chọn FX Chain folder lên trên, ngay sau chọn REAPER app
const reaperConfigDiv = document.getElementById('reaperPathBtn').parentElement.parentElement;
const fxChainFolderDiv = document.createElement('div');
fxChainFolderDiv.innerHTML = `
  <label>2. FX Chain Folder: </label>
  <button id="fxChainFolderBtn">Choose FX Chain Folder</button>
  <span id="fxChainFolderPath">${fxChainFolderPath}</span>
`;
reaperConfigDiv.parentElement.insertBefore(fxChainFolderDiv, reaperConfigDiv.nextSibling);

document.getElementById('fxChainFolderBtn').addEventListener('click', () => {
  ipcRenderer.send('open-fxchain-folder-dialog');
});

// Khi nhập keyword, nếu có preset trùng tên, tự động chọn preset đó
function autoSelectPresetForKeyword(inputEl) {
  const keyword = inputEl.value.trim().toLowerCase();
  const ruleDiv = inputEl.parentElement;
  const presetSelect = ruleDiv.querySelector('select.preset');
  if (!presetSelect) return;
  const found = fxChainPresets.find(p => p.name.toLowerCase() === keyword);
  if (found) {
    presetSelect.value = found.path;
  }
} 