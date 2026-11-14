import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BridgeApi, ScanEvent, ScanSettings, UpdateStatus } from '@shared/types';
import type { TraceEvent } from '@shared/diagnose';

const api: BridgeApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openAcknowledgements: () => ipcRenderer.invoke('app:openAcknowledgements'),
    openLocalNetworkSettings: () => ipcRenderer.invoke('app:openLocalNetworkSettings'),
    copyText: (text: string) => ipcRenderer.invoke('app:copyText', text),
    openLicense: () => ipcRenderer.invoke('app:openLicense'),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setMode: (mode: string) => ipcRenderer.invoke('updates:setMode', mode),
    setUsageCount: (on: boolean) => ipcRenderer.invoke('updates:setUsageCount', on),
    dismissNotice: () => ipcRenderer.invoke('updates:dismissNotice'),
    dismissWhatsNew: () => ipcRenderer.invoke('updates:dismissWhatsNew'),
    onStatus: (listener: (status: UpdateStatus) => void) => {
      const handler = (_e: IpcRendererEvent, status: UpdateStatus) => listener(status);
      ipcRenderer.on('updates:status', handler);
      return () => ipcRenderer.removeListener('updates:status', handler);
    },
  },
  scan: {
    localTargets: () => ipcRenderer.invoke('scan:localTargets'),
    parseTargets: (text: string) => ipcRenderer.invoke('scan:parseTargets', text),
    start: (settings: ScanSettings) => ipcRenderer.invoke('scan:start', settings),
    cancel: (runId: string) => ipcRenderer.invoke('scan:cancel', runId),
    onEvent: (listener: (event: ScanEvent) => void) => {
      const handler = (_e: IpcRendererEvent, event: ScanEvent) => listener(event);
      ipcRenderer.on('scan:event', handler);
      return () => ipcRenderer.removeListener('scan:event', handler);
    },
  },
  inventory: {
    list: () => ipcRenderer.invoke('inventory:list'),
    remove: (id: string) => ipcRenderer.invoke('inventory:remove', id),
    clear: () => ipcRenderer.invoke('inventory:clear'),
    runs: () => ipcRenderer.invoke('inventory:runs'),
    networks: () => ipcRenderer.invoke('inventory:networks'),
    renameNetwork: (id: string, name: string) => ipcRenderer.invoke('inventory:renameNetwork', id, name),
    removeNetwork: (id: string) => ipcRenderer.invoke('inventory:removeNetwork', id),
    removeRun: (id: string) => ipcRenderer.invoke('inventory:removeRun', id),
    exportCsv: (ids?: string[]) => ipcRenderer.invoke('inventory:exportCsv', ids),
  },
  wifi: {
    scan: () => ipcRenderer.invoke('wifi:scan'),
    authorize: () => ipcRenderer.invoke('wifi:authorize'),
    openLocationSettings: () => ipcRenderer.invoke('wifi:openLocationSettings'),
  },
  report: {
    pdf: (html: string, suggestedName: string, mode: 'save' | 'preview') => ipcRenderer.invoke('report:pdf', html, suggestedName, mode),
    show: (path: string) => ipcRenderer.invoke('report:show', path),
  },
  map: {
    saveImage: (dataUrl: string, suggestedName: string) => ipcRenderer.invoke('map:saveImage', dataUrl, suggestedName),
    saveCsv: (csv: string, suggestedName: string) => ipcRenderer.invoke('map:saveCsv', csv, suggestedName),
  },
  snmp: {
    settings: (networkId: string) => ipcRenderer.invoke('snmp:settings', networkId),
    save: (networkId: string, community: string) => ipcRenderer.invoke('snmp:save', networkId, community),
    clear: (networkId: string) => ipcRenderer.invoke('snmp:clear', networkId),
    read: (networkId: string) => ipcRenderer.invoke('snmp:read', networkId),
    snapshot: (networkId: string) => ipcRenderer.invoke('snmp:snapshot', networkId),
    traffic: (networkId: string) => ipcRenderer.invoke('snmp:traffic', networkId),
  },
  vendors: {
    status: () => ipcRenderer.invoke('vendors:status'),
    update: () => ipcRenderer.invoke('vendors:update'),
    setAutoCheck: (every: string) => ipcRenderer.invoke('vendors:setAutoCheck', every),
  },
  actions: {
    ssh: (ip: string, user: string) => ipcRenderer.invoke('actions:ssh', ip, user),
    web: (ip: string, secure: boolean) => ipcRenderer.invoke('actions:web', ip, secure),
    remoteDesktop: (ip: string) => ipcRenderer.invoke('actions:remoteDesktop', ip),
    ping: (ip: string) => ipcRenderer.invoke('actions:ping', ip),
  },
  diagnose: {
    local: () => ipcRenderer.invoke('diagnose:local'),
    gateway: (ip: string) => ipcRenderer.invoke('diagnose:gateway', ip),
    dns: (servers: string[]) => ipcRenderer.invoke('diagnose:dns', servers),
    internet: () => ipcRenderer.invoke('diagnose:internet'),
    publicAddress: () => ipcRenderer.invoke('diagnose:publicAddress'),
    service: (target: string) => ipcRenderer.invoke('diagnose:service', target),
    trace: (id: string, target: string) => ipcRenderer.invoke('diagnose:trace', id, target),
    cancelTrace: (id: string) => ipcRenderer.invoke('diagnose:cancelTrace', id),
    pingOnce: (target: string) => ipcRenderer.invoke('diagnose:pingOnce', target),
    ports: (host: string, ports: string) => ipcRenderer.invoke('diagnose:ports', host, ports),
    dnsLookup: (name: string, type: string) => ipcRenderer.invoke('diagnose:dnsLookup', name, type),
    mtu: (target: string) => ipcRenderer.invoke('diagnose:mtu', target),
    dhcp: () => ipcRenderer.invoke('diagnose:dhcp'),
    onTrace: (listener: (event: TraceEvent) => void) => {
      const handler = (_e: IpcRendererEvent, event: TraceEvent) => listener(event);
      ipcRenderer.on('diagnose:traceEvent', handler);
      return () => ipcRenderer.removeListener('diagnose:traceEvent', handler);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('menu', {
  onCommand: (listener: (command: string) => void) => {
    const handler = (_e: IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on('menu:command', handler);
    return () => ipcRenderer.removeListener('menu:command', handler);
  },
});
