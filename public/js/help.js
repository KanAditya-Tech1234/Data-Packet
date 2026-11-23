/* Help page: fill the examples with this server's address. */
(function () {
  'use strict';
  window.DT.header('help');
  const base = location.origin;
  document.querySelectorAll('.base').forEach(el => { el.textContent = base; });
  const one = '{"id":"1005","lat":23.078143,"lon":72.531243,"Alt":16.5,"Alt_R":"AGL","d_x":0.32,"d_y":-0.18,"d_z":0.19}';
  const batch = '[{"id":"1005","lat":23.078143,"lon":72.531243,"Alt":16.5},{"id":"1005","lat":23.078201,"lon":72.531302,"Alt":17.1}]';
  document.getElementById('curl-one').textContent =
    `curl -X POST ${base}/api/packet \\\n  -H "Content-Type: application/json" \\\n  -d '${one}'`;
  document.getElementById('curl-batch').textContent =
    `curl -X POST ${base}/api/packet \\\n  -H "Content-Type: application/json" \\\n  -d '${batch}'`;
  document.getElementById('ps-one').textContent =
    `Invoke-RestMethod -Method Post -Uri ${base}/api/packet -ContentType 'application/json' -Body '${one}'`;
})();
