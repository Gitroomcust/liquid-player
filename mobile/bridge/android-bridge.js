(() => {
  const Capacitor = window.Capacitor;
  const plugins = Capacitor?.Plugins || {};
  const native = plugins.LiquidPlayer;
  const appPlugin = plugins.App;
  let coverDir = '';
  let sessionAccess = false;

  const dispatchAccess = (required) => {
    sessionAccess = !!required;
    window.dispatchEvent(new CustomEvent('liquidplayer:session-access', { detail: sessionAccess }));
  };

  const accessPromise = native?.getCoverDir
    ? native.getCoverDir().then((result) => { coverDir = result.path || ''; })
    : Promise.resolve();

  const subscribe = (plugin, eventName, callback) => {
    if (!plugin?.addListener) return () => {};
    let handle;
    let removed = false;
    plugin.addListener(eventName, callback).then((result) => {
      handle = result;
      if (removed) handle.remove();
    });
    return () => {
      removed = true;
      if (handle) handle.remove();
    };
  };

  async function refreshSessionAccess() {
    if (!native?.needsSessionAccess) return;
    try {
      const result = await native.needsSessionAccess();
      dispatchAccess(result.required);
    } catch {}
  }

  if (appPlugin?.addListener) {
    appPlugin.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void refreshSessionAccess();
    });
  }
  void refreshSessionAccess();

  window.api = {
    getUser: async () => {
      await accessPromise;
      if (!native?.getUser) return { name: '', platform: 'android' };
      return native.getUser();
    },
    pickFolder: () => native?.pickFolder ? native.pickFolder() : Promise.resolve(null),
    systemControl: (id, action) => native?.systemControl ? native.systemControl({ id, action }) : Promise.resolve(false),
    onSystemSessions: (callback) => subscribe(native, 'systemSessions', ({ sessions }) => callback(sessions || [])),
    onTracksMeta: (callback) => subscribe(native, 'tracksMeta', callback),
    toMediaUrl: (path) => `${location.origin}/_liquid_media_?u=${encodeURIComponent(path)}`,
    toCoverUrl: (path) => {
      if (!Capacitor?.convertFileSrc || !coverDir) return null;
      return Capacitor.convertFileSrc(`file://${coverDir}/${window.LiquidPlayerFNV1a32(path)}.jpg`);
    },
    startCapture: async () => {
      if (!native?.startCapture) return false;
      try {
        const result = await native.startCapture();
        return result.available !== false;
      } catch {
        return false;
      }
    },
    stopCapture: () => native?.stopCapture ? native.stopCapture() : Promise.resolve(),
    onCaptureFrame: (callback) => subscribe(native, 'captureFrame', callback),
    onCaptureState: (callback) => subscribe(native, 'captureState', callback),
    needsSessionAccess: () => sessionAccess,
    requestSessionAccess: () => native?.requestSessionAccess ? native.requestSessionAccess() : Promise.resolve(),
    onSessionAccess: (callback) => {
      const handler = (event) => callback(event.detail);
      window.addEventListener('liquidplayer:session-access', handler);
      return () => window.removeEventListener('liquidplayer:session-access', handler);
    },
    onBackButton: (callback) => subscribe(appPlugin, 'backButton', callback),
    minimizeApp: () => appPlugin?.minimizeApp ? appPlugin.minimizeApp() : Promise.resolve(),
  };
})();
