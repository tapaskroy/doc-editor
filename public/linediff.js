// Line-level LCS diff, shared by the browser (window.lineDiff) and the unit
// tests (require). Returns [{ t: 'same' | 'add' | 'del', s }] turning oldText
// into newText. Kept dependency-free and DOM-free so it's testable in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.lineDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Empty text is zero lines (not one blank line), so empty→content is a pure
  // add with no phantom blank-line deletion.
  const split = (t) => {
    t = String(t == null ? '' : t);
    return t === '' ? [] : t.split('\n');
  };
  return function lineDiff(oldText, newText) {
    const a = split(oldText);
    const b = split(newText);
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ t: 'same', s: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ t: 'del', s: a[i] });
        i++;
      } else {
        out.push({ t: 'add', s: b[j] });
        j++;
      }
    }
    while (i < n) out.push({ t: 'del', s: a[i++] });
    while (j < m) out.push({ t: 'add', s: b[j++] });
    return out;
  };
});
