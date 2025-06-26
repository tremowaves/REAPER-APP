const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let reaperPath = '';
let availablePresets = [];

async function clearTempPresets() {
  const tempDir = path.join(app.getPath('userData'), 'temp-presets');
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log('Temporary presets cleared.');
  } catch (error) {
    console.error('Could not clear temporary presets:', error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', async () => {
    // Load and send saved settings to renderer
    reaperPath = store.get('reaperPath', '');
    const audioFolderPath = store.get('audioFolderPath', '');
    const rppPath = store.get('rppPath', '');

    mainWindow.webContents.send('settings-loaded', {
      reaperPath,
      audioFolderPath,
      rppPath
    });

    if (rppPath) {
      try {
        availablePresets = await parseRppForPresets(rppPath);
        mainWindow.webContents.send('presets-loaded', { presets: availablePresets, path: rppPath });
      } catch (error) {
        console.error('Failed to auto-load RPP file:', error);
        mainWindow.webContents.send('presets-load-failed', error.message);
      }
    }
  });
}

app.whenReady().then(async () => {
  await clearTempPresets();
  createWindow();
  // Try to find REAPER automatically
  reaperPath = await findReaperPath();
  if (reaperPath) {
    console.log('Found REAPER at:', reaperPath);
  }
});

// Handle folder selection
ipcMain.on('open-folder-dialog', (event) => {
  dialog.showOpenDialog({
    properties: ['openDirectory']
  }).then(result => {
    if (!result.canceled) {
      mainWindow.webContents.send('selected-folder', result.filePaths[0]);
      store.set('audioFolderPath', result.filePaths[0]);
    }
  });
});

ipcMain.on('open-rpp-dialog', (event) => {
  dialog.showOpenDialog({
    title: 'Select REAPER Project File for Presets',
    properties: ['openFile'],
    filters: [{ name: 'REAPER Projects', extensions: ['rpp'] }]
  }).then(async (result) => {
    if (!result.canceled && result.filePaths.length > 0) {
      const rppPath = result.filePaths[0];
      store.set('rppPath', rppPath);
      try {
        availablePresets = await parseRppForPresets(rppPath);
        mainWindow.webContents.send('presets-loaded', { presets: availablePresets, path: rppPath });
      } catch (error) {
        console.error('Failed to parse RPP file:', error);
        mainWindow.webContents.send('presets-load-failed', error.message);
      }
    }
  });
});

// Handle REAPER path selection
ipcMain.on('select-reaper-path', (event) => {
  dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'REAPER Executable', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }).then(result => {
    if (!result.canceled) {
      reaperPath = result.filePaths[0];
      store.set('reaperPath', reaperPath);
      mainWindow.webContents.send('reaper-path-selected', reaperPath);
    }
  });
});

// Handle audio file scanning
ipcMain.on('scan-audio-files', async (event, folderPath) => {
  try {
    const audioFiles = await scanAudioFiles(folderPath);
    mainWindow.webContents.send('scanned-files', audioFiles);
  } catch (error) {
    mainWindow.webContents.send('process-done', `Error scanning files: ${error.message}`);
  }
});

// Handle smart audio processing
ipcMain.on('process-audio-smart', async (event, config) => {
  try {
    if (!reaperPath) {
      throw new Error('REAPER path not set. Please select REAPER executable first.');
    }
    await processAudioFilesSmart(config);
    mainWindow.webContents.send('process-done', 'Processing complete!');
  } catch (error) {
    mainWindow.webContents.send('process-done', `Error: ${error.message}`);
  }
});

// Helper functions
async function findReaperPath() {
  const possiblePaths = [
    // Windows common paths
    'C:\\Program Files\\REAPER (x64)\\reaper.exe',
    'C:\\Program Files\\REAPER (x86)\\reaper.exe',
    'C:\\Program Files (x86)\\REAPER (x64)\\reaper.exe',
    'C:\\Program Files (x86)\\REAPER (x86)\\reaper.exe',
    // Portable REAPER paths
    'C:\\REAPER\\reaper.exe',
    'C:\\REAPER (x64)\\reaper.exe',
    // User directory paths
    path.join(process.env.USERPROFILE || '', 'REAPER', 'reaper.exe'),
    path.join(process.env.USERPROFILE || '', 'REAPER (x64)', 'reaper.exe'),
  ];

  for (const reaperPath of possiblePaths) {
    try {
      await fs.access(reaperPath);
      return reaperPath;
    } catch (error) {
      // File doesn't exist, continue to next path
    }
  }

  // Try to find REAPER in PATH
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      exec('where reaper', (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout });
      });
    });
    
    if (stdout.trim()) {
      return stdout.trim().split('\n')[0]; // Return first match
    }
  } catch (error) {
    // REAPER not found in PATH
  }

  return null;
}

async function parseRppForPresets(filePath) {
  const presets = [];
  const tempDir = path.join(app.getPath('userData'), 'temp-presets');
  await fs.mkdir(tempDir, { recursive: true });

  const fileContent = await fs.readFile(filePath, 'utf-8');
  const trackChunks = fileContent.split('<TRACK');
  trackChunks.shift(); // Remove content before the first track

  let trackIndex = 0;
  for (const chunk of trackChunks) {
    trackIndex++;
    
    const fxChainStartIndex = chunk.indexOf('<FXCHAIN');
    if (fxChainStartIndex === -1) {
      continue;
    }

    let trackName;
    const nameMatch = chunk.match(/^\s*NAME\s+"([^"]+)"/m);
    if (nameMatch && nameMatch[1].trim() !== "") {
      trackName = nameMatch[1];
    } else {
      trackName = `Track ${trackIndex}`;
    }
    
    const fxChainChunk = chunk.substring(fxChainStartIndex);
    let openBrackets = 0;
    let fxChainEndIndex = -1;

    for (let i = 0; i < fxChainChunk.length; i++) {
      if (fxChainChunk[i] === '<') {
        openBrackets++;
      } else if (fxChainChunk[i] === '>') {
        openBrackets--;
        if (openBrackets === 0) {
          fxChainEndIndex = i;
          break;
        }
      }
    }

    if (fxChainEndIndex !== -1) {
      const fxChainContent = fxChainChunk.substring(0, fxChainEndIndex + 1);
      
      // Only include presets that actually have plugins in them
      // Updated to detect VST, AU, and JS plugins as well as native FX
      const hasPlugins = /<(FX |VST |AU |JS )/i.test(fxChainContent);
      if (!hasPlugins) {
        continue;
      }

      const safeFileName = trackName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const tempFilePath = path.join(tempDir, `${safeFileName}.RfxChain`);
      
      await fs.writeFile(tempFilePath, fxChainContent);
      presets.push({ name: trackName, path: tempFilePath });
    }
  }

  if (presets.length === 0) {
    throw new Error('No tracks with FX chains found in the project file.');
  }

  return presets;
}

async function scanAudioFiles(folderPath) {
  const audioExtensions = ['.wav', '.mp3', '.flac', '.aiff', '.ogg', '.m4a'];
  const files = [];
  
  async function scanDirectory(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Exclude the output directory to prevent re-processing
          if (entry.name === 'processed') {
            continue;
          }
          await scanDirectory(fullPath); // Recursive scan
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (audioExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
    }
  }
  
  await scanDirectory(folderPath);
  return files.sort();
}

async function processAudioFilesSmart(config) {
  const { folderPath, files, rules, outputSettings } = config;

  const baseOutputDir = path.join(path.dirname(folderPath), 'processed');
  const unmatchedDir = path.join(baseOutputDir, '_unmatched');
  await fs.mkdir(unmatchedDir, { recursive: true });
  
  // Group files by rule keyword.
  const fileGroups = {};
  const unmatchedFiles = [];
  
  files.forEach(file => {
    const fileName = path.basename(file).toLowerCase();
    let matchedRule = null;
    
    // Find matching rule
    for (const rule of rules) {
      if (rule.keyword && fileName.includes(rule.keyword)) {
        matchedRule = rule;
        break;
      }
    }
    
    if (matchedRule) {
      const keyword = matchedRule.keyword;
      if (!fileGroups[keyword]) {
        fileGroups[keyword] = {
          preset: matchedRule.preset,
          files: []
        };
      }
      fileGroups[keyword].files.push(file);
    } else {
      unmatchedFiles.push(file);
    }
  });

  // Move unmatched files
  for (const file of unmatchedFiles) {
    const destPath = path.join(unmatchedDir, path.basename(file));
    try {
      await fs.rename(file, destPath);
    } catch (err) {
      console.error(`Failed to move unmatched file ${file}:`, err);
    }
  }
  
  // Process each matched group with its preset
  for (const [keyword, group] of Object.entries(fileGroups)) {
    const outputDirName = keyword.charAt(0).toUpperCase() + keyword.slice(1);
    const ruleOutputDir = path.join(baseOutputDir, outputDirName);
    
    await processFileGroup(group.files, group.preset, outputSettings, ruleOutputDir);
  }
}

async function processFileGroup(files, preset, outputSettings, outputDir) {
  const processFilePath = path.join(app.getPath('temp'), `process_config_${Date.now()}.txt`);

  try {
    let processContent = '';
    // Add file list
    for (const file of files) {
      processContent += `"${file}"\n`;
    }

    // Add REAPER command block
    processContent += '<CONFIG\n';
    processContent += `FXCHAIN "${preset}"\n`;
    processContent += `OUTPATH "${outputDir}"\n`;

    // Add output format settings
    if (outputSettings.format === 'mp3') {
      processContent += 'OUTFORMAT MP3\n';
    } else if (outputSettings.format === 'ogg') {
      processContent += 'OUTFORMAT OGG\n';
    } else {
      processContent += 'OUTFORMAT WAV\n';
    }

    // Add normalization settings
    if (outputSettings.normalize) {
      processContent += `NORMALIZE 1\n`;
      processContent += `NORMALIZETO ${outputSettings.peakDb}\n`;
    }

    // Add fade settings (if supported by REAPER)
    if (outputSettings.autoFade) {
      processContent += 'FADEIN 0.1\n';
      processContent += 'FADEOUT 0.1\n';
    }

    processContent += '>\n';

    // Write process file
    await fs.writeFile(processFilePath, processContent);

    // Execute REAPER command with full path
    const reaperCmd = `"${reaperPath}" -batchconvert "${processFilePath}"`;

    await new Promise((resolve, reject) => {
      exec(reaperCmd, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

  } finally {
    // Clean up temporary process file
    try {
      await fs.unlink(processFilePath);
    } catch (err) {
      console.error('Error cleaning up process file:', err);
    }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
