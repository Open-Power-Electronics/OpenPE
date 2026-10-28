/** Keep native diagnostics private while exposing an actionable solver failure. */
export function spiceFailure(output, reason = '') {
  let message = reason;
  let code;
  if (
    !message &&
    /timestep too small|transient op failed|operating point.*(?:failed|could not)/i.test(output)
  ) {
    code = 'OPENPE_SPICE_CONVERGENCE';
    const line = output.match(/[^\r\n]*timestep too small[^\r\n]*/i)?.[0] || '';
    const milliseconds = Number(line.match(/\btime\s*=\s*([+\-\d.eE]+)/i)?.[1]) * 1000;
    const at =
      Number.isFinite(milliseconds) && milliseconds > 0
        ? `at ${Number(milliseconds.toPrecision(6))} ms`
        : 'at startup';
    message = `The solver could not converge ${at}. Try a shorter duration or review the circuit and model.`;
  }
  message ||=
    'The solver could not complete this simulation. Review the circuit and simulation settings.';
  return Object.assign(new Error(`${message}\n${output.slice(-6000)}`), { code });
}

export function publicSpiceFailure(error) {
  return {
    message: String(error.message || 'Simulation failed.').split(/\r?\n/, 1)[0],
    ...(error.code === 'OPENPE_SPICE_CONVERGENCE' ? { code: error.code } : {}),
  };
}
