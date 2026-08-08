(function () {
  function loadTextFile(url, elementId) {
    var el = document.getElementById(elementId);
    if (!el) return;
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        el.textContent = text.replace(/\s+$/, '');
      })
      .catch(function (err) {
        el.textContent = 'Unable to load updates.';
        console.error('Failed to load ' + url + ':', err);
      });
  }

  loadTextFile('./updates/todo.txt', 'updates');
  loadTextFile('./updates/completed.txt', 'completedupdates');
})();
