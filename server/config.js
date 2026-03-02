import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '..', 'eltoncodebuff-config.json');

let currentConfig = {};

export function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            currentConfig = JSON.parse(raw);
            console.log(`  ✅ Config loaded (provider: ${currentConfig.provider})`);
        } else {
            console.log('  ℹ️  No config found — setup wizard will launch in browser.');
            currentConfig = {};
        }
    } catch (err) {
        console.error('  ⚠️  Error loading config:', err.message);
        currentConfig = {};
    }
}

export function saveConfig(cfg) {
    currentConfig = { ...currentConfig, ...cfg };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf-8');
    console.log('  ✅ Config saved');
}

export function getConfig() {
    return { ...currentConfig };
}
