/** Minimal, deliberately read-only desktop bridge. */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('zhiraiDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
