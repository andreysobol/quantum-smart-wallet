const endpoint = process.argv[2] || 'http://127.0.0.1:14337/rpc';
try {
  const response = await fetch(endpoint, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'skandha_explorer_info', params: []}),
    signal: AbortSignal.timeout(4000),
  });
  const result = await response.json();
  if (!response.ok || result.result?.chainId !== 81411338) process.exit(1);
} catch { process.exit(1); }
