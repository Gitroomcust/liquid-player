(function (root) {
  function fnv1a32(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = fnv1a32;
  else root.LiquidPlayerFNV1a32 = fnv1a32;
})(typeof globalThis !== 'undefined' ? globalThis : window);
