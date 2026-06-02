import fs from 'fs';

const mainJsPath = 'src/main.js';
const settingsJsPath = 'src/ui/settings.js';

let code = fs.readFileSync(mainJsPath, 'utf8');
const lines = code.split('\n');

const startIndex = lines.findIndex(l => l.includes('function renderKeybinds()'));
const endIndex = lines.findIndex(l => l.includes('deleteServerConfirmInput.value = \'\';') && lines[l+2] && lines[l+2].includes('}')) + 2;

if (startIndex === -1 || endIndex <= startIndex) {
    console.error('Extraction boundaries not found!');
    process.exit(1);
}

if (!fs.existsSync('src/ui')) fs.mkdirSync('src/ui');

// Step 1: Automatically add 'export ' to all root-level const/let/function declarations in main.js
// so that our separated modules can easily import them.
let newMainLines = [];
let insideSettings = false;

for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Auto-export globals if they are not exported
    if (!insideSettings) {
        if (/^(const|let|async function|function)\s+[a-zA-Z0-9_]+(\s*=|\s*\()/.test(line)) {
            // Avoid exporting the newly extracted function explicitly if it gets complex, but it's safe generally.
            if (!line.startsWith('export ')) {
                // exceptions
                if (line.includes('initAuth')) {} // skip
                else line = 'export ' + line;
            }
        }
    }
    
    if (i === startIndex) insideSettings = true;
    
    if (!insideSettings) {
        newMainLines.push(line);
    }
    
    if (i === endIndex) {
        insideSettings = false;
        
        // Inject settings caller
        newMainLines.push('\n// SETTINGS UI EXTR');
        newMainLines.push('import { setupSettingsUI } from \'./ui/settings.js\';');
        newMainLines.push('setupSettingsUI();\n');
    }
}

// Step 2: Build settings.js
const settingsBlock = lines.slice(startIndex, endIndex + 1).join('\n');

// Find all used `export` variables from main to import them
let mainExports = newMainLines
    .map(l => l.match(/^export (const|let|async function|function) ([a-zA-Z0-9_]+)/))
    .filter(m => !!m)
    .map(m => m[2]);

// unique elements
mainExports = [...new Set(mainExports)];

// Filter out those actually used in settingsBlock
const usedImports = mainExports.filter(ex => new RegExp(`\\b${ex}\\b`).test(settingsBlock) && ex !== 'activeSettingsServer' && ex !== 'serverRolesCache' && ex !== 'activeEditedRole');

const fileContentSettings = `
import { supabase } from '../supabase.js';
import { getAudioDevices, setInputDevice, setOutputDevice, updateAudioOptions } from '../voice.js';
import { ${usedImports.join(', ')} } from '../main.js';

export function setupSettingsUI() {
    let activeSettingsServer = null;
    let serverRolesCache = [];
    let activeEditedRole = null;

    ${settingsBlock}
}
`;

fs.writeFileSync(settingsJsPath, fileContentSettings.trim() + '\n');
fs.writeFileSync(mainJsPath, newMainLines.join('\n'));

console.log('Successfully extracted Settings UI and exported main.js dependencies!');
