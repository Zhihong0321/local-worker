const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage('status');
  $('conn').textContent = s.connected ? 'connected' : 'not connected';
  $('conn').className = 'v ' + (s.connected ? 'on' : 'off');
  $('count').textContent = s.count;
  $('last').textContent = s.lastQuery || '–';
  $('last').title = s.lastQuery || '';
  $('err').textContent = s.lastError || '–';
  $('err').title = s.lastError || '';
}

chrome.storage.local.get('port').then(({ port }) => { $('port').value = port || 18787; });
$('port').addEventListener('change', () => chrome.storage.local.set({ port: Number($('port').value) || 18787 }));
$('reconnect').addEventListener('click', async () => { await chrome.runtime.sendMessage('reconnect'); setTimeout(refresh, 500); });

refresh();
setInterval(refresh, 1000);
