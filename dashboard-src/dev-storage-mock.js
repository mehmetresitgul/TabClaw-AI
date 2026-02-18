// Mock storage-bridge for dev mode
if (!window.__csCache) {
  window.__csCache = {};
  window.__csReady = Promise.resolve({});
  window.__csSet = function(data) { Object.assign(window.__csCache, data); };
  window.__csGet = function(key) { return window.__csCache[key]; };
  window.__csGetMany = function(keys) {
    var r = {};
    keys.forEach(function(k) { r[k] = window.__csCache[k]; });
    return r;
  };
}
