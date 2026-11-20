// Explicit test-display compatibility; never enabled by the application.
export function electronTestLaunch() {
  const executablePath = process.env.OPENPE_EXECUTABLE;
  const args = executablePath ? [] : ['.'];
  if (process.platform === 'linux' && process.env.OPENPE_E2E_MESA === '1')
    args.unshift('--ignore-gpu-blocklist');
  return { ...(executablePath ? { executablePath } : {}), args };
}
