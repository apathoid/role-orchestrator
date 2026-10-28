// Common bounded teardown for ACP subprocesses. A child that ignores SIGTERM
// must not outlive the provider indefinitely after close/cancel/failure.
export async function terminateAcpChild(child, { gracefulMs = 0, termMs = 1_500 } = {}) {
  if (!child) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited() || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  let onExit;
  const exitPromise = new Promise(resolve => {
    onExit = resolve;
    child.once('exit', onExit);
    child.once('error', onExit);
  });
  const wait = async (ms) => {
    let timer;
    try { await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  const signal = (name) => {
    if (exited() || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    if (process.platform !== 'win32') {
      // Providers are spawned in their own process group on POSIX.
      try { process.kill(-child.pid, name); return; } catch {}
    }
    try { child.kill(name); } catch {}
  };
  try {
    if (gracefulMs > 0) {
      try { child.stdin?.end(); } catch {}
      await wait(gracefulMs);
    }
    if (exited()) return;
    signal('SIGTERM');
    await wait(termMs);
    if (exited()) return;
    signal('SIGKILL');
    await wait(350);
  } finally {
    child.removeListener('exit', onExit);
    child.removeListener('error', onExit);
  }
}
