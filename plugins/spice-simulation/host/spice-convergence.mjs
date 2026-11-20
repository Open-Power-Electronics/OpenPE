/** Ordered numerical plan for every compiled circuit; never selected by identity. */
export const convergencePolicy = 'convergence-v2-100000-native-points-within-one-requested-step';

/** Detect collapsed numerical steps by accepted solver work, never wall time. */
export function convergenceProgress(deck) {
  const step = Number(/^tran\s+(\S+)/m.exec(deck.netlist)?.[1]);
  let start = -1,
    count = 0;
  return (time) => {
    if (!(step > 0)) return;
    if (start < 0 || time - start >= step) {
      start = time;
      count = 0;
    }
    if (++count >= 100000)
      throw Object.assign(new Error('The solver time step collapsed. Retrying convergence.'), {
        code: 'OPENPE_SPICE_CONVERGENCE',
      });
  };
}

export function spiceConvergenceDecks(deck) {
  const options = [...deck.netlist.matchAll(/^\.options\b[^\r\n]*/gim)];
  const limits = options.flatMap(([line]) => [...line.matchAll(/\bitl4\s*=\s*(\d+)\b/gi)]);
  if (limits.length > 1 || (limits.length === 1 && Number(limits[0][1]) >= 1000)) return [deck];
  const netlist = limits.length
    ? deck.netlist.replace(/^\.options\b[^\r\n]*/gim, (line) =>
        line.replace(/\bitl4\s*=\s*\d+\b/i, 'itl4=1000'),
      )
    : deck.netlist.replace(/^\.control$/m, '.options itl4=1000\n.control');
  return netlist === deck.netlist ? [deck] : [deck, { ...deck, netlist }];
}

/** Retry only an explicit convergence failure, after discarding its preview. */
export async function runSpiceAttempts(decks, signal, run, reset) {
  const checkCancellation = () => {
    if (signal.aborted) throw new Error('Simulation cancelled.');
  };
  for (let index = 0; index < decks.length; index++) {
    checkCancellation();
    const deck = decks[index];
    try {
      const log = await run(deck, index);
      checkCancellation();
      return {
        deck,
        log: index ? `${log}\nConvergence retry: transient iteration limit raised to 1000.\n` : log,
      };
    } catch (error) {
      checkCancellation();
      if (error.code !== 'OPENPE_SPICE_CONVERGENCE' || index + 1 === decks.length) throw error;
    }
    await reset?.();
  }
  throw new Error('Invalid SPICE execution plan.');
}
