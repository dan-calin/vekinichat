import fs from 'fs';

const mainJsPath = 'src/main.js';
const settingsJsPath = 'src/ui/settings.js';

let code = fs.readFileSync(mainJsPath, 'utf8');
const lines = code.split(/\r?\n/);

const startIndex = lines.findIndex(l => l.includes('function renderKeybinds()'));
const endIndex = lines.findIndex((l, index) => {
    return l.includes("deleteServerConfirmInput.value = '';") 
        && lines[index+2] 
        && lines[index+2].includes("}");
});

const actualEndIndex = endIndex !== -1 ? endIndex + 3 : -1;

if (startIndex === -1 || actualEndIndex <= startIndex) {
    console.error('Boundaries not found! start:', startIndex, 'end:', actualEndIndex);
    process.exit(1);
}

let settingsBlock = lines.slice(startIndex, actualEndIndex + 1).join('\n');

const transforms = [
    'currentUser', 'currentProfile', 'activeServerId', 'servers', 'profileCache',
    'toggleAppMute', 'toggleAppDeafen', 'renderSidebar', 'hasPermission',
    'loadServers', 'loadCurrentUserPermissions', 'escapeHtml',
    'getAudioDevices', 'setInputDevice', 'setOutputDevice', 'updateAudioOptions',
    'keybinds', 'saveKeybinds', 'eventToChord'
];

transforms.forEach(v => {
    const regex = new RegExp(`(?<!let\\s|const\\s|function\\s|\\.|\\{)\\b${v}\\b`, 'g');
    settingsBlock = settingsBlock.replace(regex, `ctx.${v}`);
});

const domQueries = `
  const $ = (sel) => document.querySelector(sel);
  const uploadAvatarBtn = $('#upload-avatar-btn');
  const avatarUploadInput = $('#avatar-upload');
  const settingsProfileForm = $('#settings-profile-form');
  const settingsUsernameInput = $('#settings-username');
  const settingNoiseSuppression = $('#setting-noise-suppression');
  const settingEchoCancellation = $('#setting-echo-cancellation');
  const settingAutoGain = $('#setting-auto-gain');
  const inputDeviceSelect = $('#input-device-select');
  const outputDeviceSelect = $('#output-device-select');
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const serverSettingsModalOverlay = $('#server-settings-modal-overlay');
  const renameServerForm = $('#rename-server-form');
  const renameServerInput = $('#rename-server-input');
  const renameServerBtn = $('#rename-server-btn');
  const memberManagementList = $('#member-management-list');
  const serverSettingsIconPreview = $('#server-settings-icon-preview');
  const serverIconUploadInput = $('#server-icon-upload');
  const deleteServerConfirmContainer = $('#delete-server-confirm-container');
  const deleteServerBtn = $('#delete-server-btn');
  const deleteServerConfirmInput = $('#delete-server-confirm-input');
  const deleteServerConfirmBtn = $('#delete-server-confirm-btn');
  const serverSettingsClose = $('#server-settings-close');
  const settingsModal = $('#settings-modal');
  const renameServerCancelBtn = $('#rename-server-cancel-btn');
`;

const settingsModuleContent = `
import { supabase } from '../supabase.js';

let ctx;

export function initSettingsModule(context) {
  ctx = context;
  
  ${domQueries}

  let activeSettingsServer = null;
  let serverRolesCache = [];
  let activeEditedRole = null;

  ${settingsBlock}
}
`;

fs.writeFileSync(settingsJsPath, settingsModuleContent.trim() + '\n');

const newMainContent = lines.slice(0, startIndex).join('\n') + `

// SETTINGS UI EXTRACTED TO src/ui/settings.js
import { initSettingsModule } from './ui/settings.js';
initSettingsModule({
  get currentUser() { return currentUser; },
  get currentProfile() { return currentProfile; },
  set currentProfile(v) { currentProfile = v; },
  get activeServerId() { return activeServerId; },
  set activeServerId(v) { activeServerId = v; },
  get servers() { return servers; },
  get keybinds() { return keybinds; },
  get profileCache() { return profileCache; },
  toggleAppMute, toggleAppDeafen, renderSidebar, hasPermission,
  loadServers, loadCurrentUserPermissions, escapeHtml,
  saveKeybinds, eventToChord,
  getAudioDevices, setInputDevice, setOutputDevice, updateAudioOptions
});

` + lines.slice(actualEndIndex + 1).join('\n');

fs.writeFileSync(mainJsPath, newMainContent);

console.log('src/ui/settings.js generated AND main.js updated successfully!');
