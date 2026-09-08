import type { AppState, Capabilities } from '../shared/types.js';
import type { AppApi, SettingsPatch } from '../preload/index.js';
import { $, el, run, toast } from './dom.js';
import { initPlugins, applyPluginsState } from './plugins.js';
declare global { interface Window { api: AppApi } }
let state: AppState;
let renderedConfig = '';
let renderedKey: boolean | undefined;
const labels: Record<keyof Capabilities, string> = {
 read: 'Bestanden lezen', browse: 'Mappen bekijken', metadata: 'Bestandsinformatie', search: 'Bestanden zoeken',
 create: 'Bestanden aanmaken', edit: 'Bestanden bewerken', move: 'Bestanden verplaatsen', deleteFile: 'Bestanden verwijderen',
 saveArtifact: 'Downloads opslaan', command: 'Terminalopdrachten', screen: 'Scherm bekijken',
 control: 'Muis en toetsenbord', clipboardRead: 'Klembord lezen', clipboardWrite: 'Klembord schrijven'
};
function patch(): SettingsPatch {
 const c = state.config;
 return { capabilities: { ...c.capabilities }, readOnly: c.readOnly, tunnel: { ...c.tunnel }, ui: { ...c.ui },
 sessions: { ...c.sessions }, compaction: { ...c.compaction }, multiAgent: { ...c.multiAgent }, goal: { ...c.goal }, mcp: { ...c.mcp } };
}
function apply(next: AppState): void {
 state = next; document.documentElement.dataset.theme = next.config.ui.theme;
 $('connectionStatus').textContent = next.status.state === 'connected' ? 'Verbonden met de tunnel' : `Tunnel: ${next.status.state}`;
 $('toggleConnection').textContent = next.status.state === 'connected' || next.status.state === 'offline' ? 'Verbinding verbreken' : 'Verbinden';
 const configSignature = JSON.stringify(next.config);
 if(configSignature === renderedConfig && renderedKey === next.hasApiKey) { applyPluginsState(next); return; }
 renderedConfig = configSignature; renderedKey = next.hasApiKey;
 const roots = $('roots'); roots.replaceChildren();
 for (const root of next.config.roots) {
 const row = el('div', 'root-row'); const title = el('div', '', `/${root.name}`); title.append(el('small', '', root.path));
 const remove = el('button', 'btn', 'Verwijderen'); remove.onclick = () => { void change(window.api.removeRoot(root.name)); };
 row.append(title, remove); roots.append(row);
 }
 if (!next.config.roots.length) roots.append(el('p', 'muted', 'Voeg een map toe om bestanden beschikbaar te maken.'));
 const caps = $('capabilities'); caps.replaceChildren();
 for (const [key, enabled] of Object.entries(next.config.capabilities)) {
 const label = el('label', 'local-check'); const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.cap = key; input.checked = enabled;
 label.append(input, document.createTextNode(labels[key as keyof Capabilities] ?? key)); caps.append(label);
 }
 $<HTMLInputElement>('readOnly').checked = next.config.readOnly;
 $<HTMLInputElement>('tunnelId').value = next.config.tunnel.tunnelId;
 $<HTMLInputElement>('desktopTunnelId').value = next.config.tunnel.desktopTunnelId ?? '';
 $<HTMLTextAreaElement>('instructions').value = next.config.mcp.instructions;
 $<HTMLSelectElement>('theme').value = next.config.ui.theme;
 $<HTMLInputElement>('autoConnect').checked = next.config.ui.autoConnect;
 $<HTMLInputElement>('startAtLogin').checked = next.config.ui.startAtLogin ?? false;
 $<HTMLInputElement>('startAtLogin').disabled = !next.loginStartupAvailable;
 $('keyStatus').textContent = next.hasApiKey ? 'Een tunnelsleutel is opgeslagen.' : 'Nog geen tunnelsleutel opgeslagen.';
 applyPluginsState(next);
}
async function change(work: Promise<{ok:true;data:AppState}|{ok:false;error:string}>): Promise<void> { const next = await run(work); if(next) apply(next); }
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-nav]')) button.onclick = () => {
 for(const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.nav;
 for(const nav of document.querySelectorAll('[data-nav]')) nav.classList.toggle('selected', nav === button);
};
$('addRoot').onclick = () => { void change(window.api.addRoot()); };
$('toggleConnection').onclick = () => { void change(state.status.state === 'connected' || state.status.state === 'offline' ? window.api.disconnect() : window.api.connect()); };
$('savePermissions').onclick = () => { const base = patch(), next = patch();
 for(const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) next.capabilities[input.dataset.cap as keyof Capabilities] = input.checked;
 next.readOnly = $<HTMLInputElement>('readOnly').checked; void change(window.api.saveSettings(next,base)); };
$('saveConnection').onclick = () => { const base = patch(), next = patch();
 next.tunnel.tunnelId = $<HTMLInputElement>('tunnelId').value.trim(); next.tunnel.desktopTunnelId = $<HTMLInputElement>('desktopTunnelId').value.trim();
 next.mcp.instructions = $<HTMLTextAreaElement>('instructions').value; next.ui.theme = $<HTMLSelectElement>('theme').value as 'dark'|'light';
 next.ui.autoConnect = $<HTMLInputElement>('autoConnect').checked; next.ui.startAtLogin = $<HTMLInputElement>('startAtLogin').checked;
 void change(window.api.saveSettings(next,base)); };
$('saveKey').onclick = async () => { const input = $<HTMLInputElement>('apiKey'); const value = input.value.trim(); input.value = ''; if(value) await change(window.api.setApiKey(value)); };
$('pickBinary').onclick = () => { void change(window.api.pickBinary()); };
$('accessibility').onclick = () => { void change(window.api.requestDesktopAccessibility()); };
$('openTunnels').onclick = () => { void run(window.api.openLink('https://platform.openai.com/settings/organization/tunnels')); };
$('openChatGPT').onclick = () => { void run(window.api.openLink('https://chatgpt.com/#settings/Plugins')); };
$('diagnose').onclick = async () => { const result = await run(window.api.runDiagnostics()); if(result) $('diagnosis').textContent = JSON.stringify(result,null,2); };
$('refreshLog').onclick = async () => { const result = await run(window.api.getLogText()); if(result !== null) $('log').textContent = result; };
initPlugins(apply); window.api.onStateChanged(apply);
void run(window.api.getState()).then(next => { if(next) apply(next); }).catch(error => toast(String(error)));
