const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec, spawn } = require('child_process');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let reaperPath = '';
let availablePresets = [];
const defaultFxChainFolder = 'H:/REAPER-APP/Fxchain';

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
  reaperPath = await findReaperPath();
  if (reaperPath) {
    console.log('Found REAPER at:', reaperPath);
  }
  // Quét FX Chain mặc định
  const presets = await scanFxChainFolder(defaultFxChainFolder);
  if (mainWindow) {
    mainWindow.webContents.send('fxchain-presets-loaded', { folder: defaultFxChainFolder, presets });
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
    await processAudioFiles(config, event);
  } catch (error) {
    mainWindow.webContents.send('process-done', `Error: ${error.message}`);
  }
});

// IPC chọn thư mục FX Chain
ipcMain.on('open-fxchain-folder-dialog', async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select FX Chain Folder'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0];
    const presets = await scanFxChainFolder(folder);
    mainWindow.webContents.send('fxchain-presets-loaded', { folder, presets });
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
      let fxChainContent = fxChainChunk.substring(0, fxChainEndIndex + 1);
      
      // Only include presets that actually have plugins in them
      // Updated to detect VST, AU, and JS plugins as well as native FX
      const hasPlugins = /<(FX |VST |AU |JS )/i.test(fxChainContent);
      if (!hasPlugins) {
        continue;
      }

      // <REAPER_FXCHAIN> format that can be read by the batch converter.
      // We need to build a complete, valid RfxChain file, not just the content.
      const rfxChainHeader = '<REAPER_FXCHAIN_PROJ 0 ""';
      let rfxChainContent = fxChainContent.replace('<FXCHAIN', rfxChainHeader);

      const safeFileName = trackName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const tempFilePath = path.join(tempDir, `${safeFileName}.RfxChain`);
      
      // --- Start Enhanced Logging ---
      console.log(`[INFO] Writing temporary preset file for "${trackName}" to: ${tempFilePath}`);
      console.log(`[INFO] Content of RfxChain file:\n---\n${rfxChainContent}\n---`);
      // --- End Enhanced Logging ---

      await fs.writeFile(tempFilePath, rfxChainContent);
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

  async function scanDirectory(dir) {
    let files = []; // Initialize files array for the current scope
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name === 'processed') {
            continue;
          }
          // Get files from the recursive call and add them to the current list
          const subDirFiles = await scanDirectory(fullPath);
          files = files.concat(subDirFiles);
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
    return files; // Return the files found in this directory and its children
  }
  
  const allFiles = await scanDirectory(folderPath);
  return allFiles.sort();
}

// This function replaces the old processAudioFilesSmart and processFileGroup
async function processAudioFiles(config, event) {
  const { folderPath, files, rules, outputSettings } = config;

  try {
    // 1. Group files and handle unmatched
    const baseOutputDir = path.join(folderPath, 'processed');
    const unmatchedDir = path.join(baseOutputDir, '_unmatched');
    await fs.mkdir(unmatchedDir, { recursive: true });

    const fileGroups = new Map();
    const unmatchedFiles = [];
    
    for (const file of files) {
        const fileName = path.basename(file).toLowerCase();
        const matchedRule = rules.find(r => r.keyword && fileName.includes(r.keyword));

        if (matchedRule) {
            const keyword = matchedRule.keyword;
            if (!fileGroups.has(keyword)) {
                fileGroups.set(keyword, {
                    preset: matchedRule.preset,
                    files: []
                });
            }
            fileGroups.get(keyword).files.push(file);
        } else {
            unmatchedFiles.push(file);
        }
    }

    for (const file of unmatchedFiles) {
        const destPath = path.join(unmatchedDir, path.basename(file));
        await fs.rename(file, destPath).catch(err => console.error(`Failed to move unmatched file: ${err}`));
    }

    if (fileGroups.size === 0) {
      event.sender.send('process-done', 'No files matched the rules. Unmatched files were moved.');
      return;
    }
    
    // 2. Create a single config file for all groups
    let configContent = '';
    for (const [keyword, group] of fileGroups) {
        if (group.files.length === 0) continue;

        const ruleOutputDir = path.join(baseOutputDir, keyword);
        await fs.mkdir(ruleOutputDir, { recursive: true });
        
        // Add file list for this group first
        for (const file of group.files) {
            configContent += `${file}\n`;
        }
        configContent += '\n'; // Separator

        // Then add the CONFIG block for this group
        configContent += '<CONFIG\n';
        configContent += `FXCHAIN "${group.preset}"\n`;
        configContent += `OUTPATH "${ruleOutputDir}"\n`;
        if (outputSettings.format === 'mp3') configContent += 'OUTFORMAT MP3\n';
        else if (outputSettings.format === 'ogg') configContent += 'OUTFORMAT OGG\n';
        else configContent += 'OUTFORMAT WAV\n';
        if (outputSettings.normalize) {
            configContent += `NORMALIZE 1\n`;
            configContent += `NORMALIZETO ${outputSettings.peakDb}\n`;
        }
        if (outputSettings.autoFade) {
            configContent += 'FADEIN 0.1\n';
            configContent += 'FADEOUT 0.1\n';
        }
        configContent += '>\n\n'; // End block and add space for next group
    }

    const tempDir = path.join(app.getPath('userData'), 'temp-process-configs');
    await fs.mkdir(tempDir, { recursive: true });
    const tempConfigPath = path.join(tempDir, `process_config_${Date.now()}.txt`);
    await fs.writeFile(tempConfigPath, configContent, 'utf-8');

    console.log('REAPER Config Content:', configContent);

    // 3. Execute REAPER using spawn for better feedback
    const reaperProcess = spawn(`"${reaperPath}"`, ['-new', '-batchconvert', `"${tempConfigPath}"`], { shell: true });

    let stdoutData = '';
    let stderrData = '';

    reaperProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
      console.log(`REAPER stdout: ${data}`);
      mainWindow.webContents.send('process-update', `LOG: ${data}`);
    });

    reaperProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
      console.error(`REAPER stderr: ${data}`);
      mainWindow.webContents.send('process-update', `ERROR: ${data}`);
    });

    reaperProcess.on('close', async (code) => {
      console.log(`REAPER process exited with code ${code}`);
      
      const reaperLogPath = tempConfigPath + '.log';
      let reaperLogContent = '';
      try {
        reaperLogContent = await fs.readFile(reaperLogPath, 'utf-8');
        console.log('--- REAPER Internal Log ---\n', reaperLogContent);
      } catch (err) {
        reaperLogContent = 'Could not read REAPER log file.';
        console.error(reaperLogContent, err);
      }

      // Cleanup temp files
      await fs.unlink(tempConfigPath).catch(err => console.error('Failed to delete temp config file:', err));
      await fs.unlink(reaperLogPath).catch(err => console.error('Failed to delete REAPER log file:', err));

      if (code === 0 && stderrData.trim() === '') {
        event.sender.send('process-done', `Processing seemingly successful. REAPER Log:\n${reaperLogContent}`);
      } else {
        event.sender.send('process-done', `Processing failed. Errors:\n${stderrData}\n\nREAPER Log:\n${reaperLogContent}`);
      }
    });

  } catch (error) {
    console.error('Error in processAudioFiles:', error);
    event.sender.send('process-done', `Fatal Error: ${error.message}`);
  }
}

// Hàm quét tất cả file .RfxChain trong thư mục
async function scanFxChainFolder(folder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const presets = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.rfxchain'))
      .map(e => ({ name: path.basename(e.name, '.RfxChain'), path: path.join(folder, e.name) }));
    return presets;
  } catch (err) {
    return [];
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});