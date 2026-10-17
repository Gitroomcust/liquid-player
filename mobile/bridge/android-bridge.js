(() => {
  const Capacitor = window.Capacitor;
  const plugins = Capacitor?.Plugins || {};
  const native = plugins.LiquidPlayer;
  const appPlugin = plugins.App;
  let coverDir = '';
  let sessionAccess = false;
  let firstCaptureFrameLogged = false;
  const jsLogLines = [];
  const describeError = (error) => error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  const logJs = (message) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    jsLogLines.push(line);
    if (jsLogLines.length > 200) jsLogLines.shift();
    console.info(`[LiquidPlayer] ${line}`);
    return line;
  };

  let platform = 'unknown';
  try {
    platform = Capacitor?.getPlatform?.() || 'unknown';
  } catch (error) {
    logJs(`getPlatform failed: ${describeError(error)}`);
  }
  let pluginMethods = [];
  try {
    pluginMethods = Object.keys(native || {}).filter((name) => typeof native[name] === 'function');
  } catch (error) {
    logJs(`LiquidPlayer method inspection failed: ${describeError(error)}`);
  }
  logJs(`bridge startup: Capacitor=${!!Capacitor}, platform=${platform}, Plugins=[${Object.keys(plugins).join(', ')}], LiquidPlayer=${!!native}, methods=[${pluginMethods.join(', ')}]`);

  window.addEventListener('error', (event) => {
    logJs(`window error: ${event.message || describeError(event.error)} at ${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logJs(`unhandled rejection: ${describeError(event.reason)}`);
  });

  const dispatchAccess = (required) => {
    sessionAccess = !!required;
    window.dispatchEvent(new CustomEvent('liquidplayer:session-access', { detail: sessionAccess }));
  };

  const accessPromise = native?.getCoverDir
    ? Promise.resolve()
      .then(() => native.getCoverDir())
      .then((result) => { coverDir = result?.path || ''; })
      .catch((error) => { logJs(`getCoverDir failed: ${describeError(error)}`); })
    : Promise.resolve();

  const subscribe = (plugin, eventName, callback) => {
    if (!plugin?.addListener) return () => {};
    let handle;
    let removed = false;
    const removeHandle = () => {
      try {
        Promise.resolve(handle?.remove?.()).catch((error) => {
          logJs(`Subscription removal failed for ${eventName}: ${describeError(error)}`);
        });
      } catch (error) {
        logJs(`Subscription removal failed for ${eventName}: ${describeError(error)}`);
      }
    };
    try {
      Promise.resolve(plugin.addListener(eventName, callback)).then((result) => {
        handle = result;
        if (removed) removeHandle();
      }).catch((error) => {
        logJs(`Subscription failed for ${eventName}: ${describeError(error)}`);
      });
    } catch (error) {
      logJs(`Subscription failed for ${eventName}: ${describeError(error)}`);
    }
    return () => {
      removed = true;
      removeHandle();
    };
  };

  async function refreshSessionAccess() {
    if (!native?.needsSessionAccess) return;
    try {
      const result = await native.needsSessionAccess();
      dispatchAccess(result.required);
    } catch (error) {
      logJs(`needsSessionAccess failed: ${describeError(error)}`);
    }
  }

  if (appPlugin?.addListener) {
    subscribe(appPlugin, 'appStateChange', ({ isActive } = {}) => {
      if (isActive) void refreshSessionAccess();
    });
  }
  void refreshSessionAccess();

  window.api = {
    getUser: async () => {
      let timeoutId;
      await Promise.race([
        accessPromise,
        new Promise((resolve) => { timeoutId = setTimeout(resolve, 2000); }),
      ]);
      clearTimeout(timeoutId);
      try {
        const user = native?.getUser ? await native.getUser() : null;
        return { name: user?.name || '', platform: 'android' };
      } catch (error) {
        logJs(`getUser failed: ${describeError(error)}`);
        return { name: '', platform: 'android' };
      }
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
      logJs('startCapture called');
      if (!native?.startCapture) {
        logJs('startCapture error: native method unavailable');
        return false;
      }
      try {
        const result = await native.startCapture();
        logJs(`startCapture result: ${JSON.stringify(result)}`);
        return result.available !== false;
      } catch (error) {
        logJs(`startCapture error: ${describeError(error)}`);
        return false;
      }
    },
    stopCapture: () => native?.stopCapture ? native.stopCapture() : Promise.resolve(),
    onCaptureFrame: (callback) => subscribe(native, 'captureFrame', (frame) => {
      if (!firstCaptureFrameLogged) {
        firstCaptureFrameLogged = true;
        logJs(`first captureFrame received: fields=[${Object.keys(frame || {}).join(', ')}]`);
      }
      callback(frame);
    }),
    onCaptureState: (callback) => subscribe(native, 'captureState', (state) => {
      logJs(`captureState event: ${JSON.stringify(state)}`);
      callback(state);
    }),
    onCaptureStats: (callback) => subscribe(native, 'captureStats', callback),
    getDiagnostics: async () => {
      let nativeLines = [];
      try {
        if (native?.getDiagnostics) {
          const result = await native.getDiagnostics();
          nativeLines = Array.isArray(result?.lines) ? result.lines : [];
        }
      } catch (error) {
        logJs(`getDiagnostics failed: ${describeError(error)}`);
      }
      return [...nativeLines, '--- JS ---', ...jsLogLines];
    },
    logJs,
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
