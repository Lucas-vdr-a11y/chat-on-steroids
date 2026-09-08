/** Only explicit local tool management is reachable from this edition's UI. */
export function localIpcAllowed(channel: string): boolean {
  return /^(plugins:|roots:|log:|window:)/.test(channel) || new Set([
    'state:get', 'settings:save', 'secret:set', 'binary:pick',
    'connection:connect', 'connection:disconnect', 'diagnostics:run',
    'desktop:requestAccessibility', 'clipboard:write', 'link:open'
  ]).has(channel);
}
export const LOCAL_TOOLS_ONLY = true;
