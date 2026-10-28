import { fileURLToPath } from 'node:url';

// Expand each local clock-offset bracket by an explicit 2 ms allowance
// for timer precision and short-interval cross-process clock drift, and
// each derived interval by another 2 ms for its endpoint timestamps.
// These increase the upper bound; they never relax the selected target.
export const clockPrecisionMarginMs = 2;

export function experienceTargetMs(value) {
  const targetMs = value === undefined ? 100 : Number(value);
  if (!Number.isFinite(targetMs) || targetMs <= 0 || (typeof value === 'string' && !value.trim()))
    throw new Error('OPENPE_EXPERIENCE_TARGET_MS must be a positive finite number.');
  return targetMs;
}

export function clockBracket(nodeBeforeMs, nodeAfterMs, clock) {
  const valid =
    [nodeBeforeMs, nodeAfterMs, clock?.rendererNowMs, clock?.timeOriginMs].every(Number.isFinite) &&
    nodeAfterMs >= nodeBeforeMs &&
    clock.rendererNowMs >= 0 &&
    clock.timeOriginMs > 0 &&
    typeof clock.sampleId === 'string';
  const rawLowerOffsetMs = valid ? nodeBeforeMs - clock.rendererNowMs : null;
  const rawUpperOffsetMs = valid ? nodeAfterMs - clock.rendererNowMs : null;
  return {
    valid,
    nodeBeforeMs,
    nodeAfterMs,
    ...clock,
    rawLowerOffsetMs,
    rawUpperOffsetMs,
    lowerOffsetMs: valid ? rawLowerOffsetMs - clockPrecisionMarginMs : null,
    upperOffsetMs: valid ? rawUpperOffsetMs + clockPrecisionMarginMs : null,
  };
}

export function actionTiming(sampleId, nodeInvokedAtMs, arm, result, cadCommit, targetMs = 100) {
  const timing = {
    timing:
      'Node invocation of the existing Playwright locator press/click, including Playwright preparation and browser input dispatch waits, through the observed CAD render return marker and next animation frame. This is not a raw CDP send timestamp or a GPU fence.',
    targetMs,
    sampleId,
    nodeInvokedAtMs,
    clockPrecisionMarginMs,
    endpointPrecisionMarginMs: clockPrecisionMarginMs,
    clockBrackets: { arm, result },
  };
  const reasons = [];
  if (!arm.valid || !result.valid) reasons.push('Invalid clock bracket.');
  if (arm.sampleId !== sampleId || result.sampleId !== sampleId || cadCommit.sampleId !== sampleId)
    reasons.push('Clock and CAD sample IDs differ.');
  if (arm.timeOriginMs !== result.timeOriginMs) reasons.push('Renderer time origin changed.');
  if (
    !Number.isFinite(nodeInvokedAtMs) ||
    nodeInvokedAtMs < arm.nodeAfterMs ||
    nodeInvokedAtMs > result.nodeBeforeMs
  )
    reasons.push('Input invocation is outside its clock brackets.');
  const times = cadCommit.rendererTimes ?? {};
  const orderedTimes = [
    times.inputObservedAtMs,
    times.meshObservedAtMs,
    times.renderObservedAtMs,
    times.presentedAtMs,
    result.rendererNowMs,
  ];
  if (
    !orderedTimes.every(Number.isFinite) ||
    orderedTimes.some((value, index) => index > 0 && value < orderedTimes[index - 1])
  )
    reasons.push('Renderer readiness timestamps are invalid or out of order.');
  const lowerOffsetMs = Math.max(arm.lowerOffsetMs, result.lowerOffsetMs);
  const upperOffsetMs = Math.min(arm.upperOffsetMs, result.upperOffsetMs);
  if (!arm.valid || !result.valid || lowerOffsetMs > upperOffsetMs)
    reasons.push('Clock offset brackets have no valid intersection.');
  if (reasons.length)
    return { ...timing, valid: false, status: 'invalid', reasons, withinTarget: false };
  const interval = (rendererAtMs) => {
    const lowerMs = rendererAtMs + lowerOffsetMs - nodeInvokedAtMs - clockPrecisionMarginMs;
    const upperMs = rendererAtMs + upperOffsetMs - nodeInvokedAtMs + clockPrecisionMarginMs;
    return {
      lowerMs: Math.max(0, lowerMs),
      estimateMs: Math.max(0, (lowerMs + upperMs) / 2),
      upperMs,
      uncertaintyMs: (upperMs - lowerMs) / 2,
    };
  };
  const presentation = interval(times.presentedAtMs);
  const input = interval(times.inputObservedAtMs);
  if (input.upperMs < 0 || presentation.upperMs < 0)
    return {
      ...timing,
      valid: false,
      status: 'invalid',
      reasons: ['The clock intersection places observed input before its invocation.'],
      withinTarget: false,
    };
  return {
    ...timing,
    valid: true,
    status:
      presentation.upperMs < targetMs
        ? 'within-target'
        : presentation.lowerMs >= targetMs
          ? 'over-budget'
          : 'uncertain-at-target',
    clockOffsetMs: { lowerMs: lowerOffsetMs, upperMs: upperOffsetMs },
    invokeToInputObservedMs: input,
    ...presentation,
    withinTarget: presentation.upperMs < targetMs,
  };
}

export function isCadCommitWithinTarget(sample, targetMs = 100) {
  const action = sample?.actionInvokeToCadPresentation;
  return (
    Number.isFinite(sample?.fromEventMs) &&
    sample.fromEventMs >= 0 &&
    sample.fromEventMs < targetMs &&
    action?.valid === true &&
    action.withinTarget === true &&
    Number.isFinite(action.upperMs) &&
    action.upperMs >= 0 &&
    action.upperMs < targetMs
  );
}

export function eventActionTiming(sampleId, nodeInvokedAtMs, arm, result, event, targetMs = 100) {
  const timing = {
    timing:
      'Node invocation of the original Playwright input action or CDP send through the observed renderer event and its second animation frame. Includes transport/preparation and browser dispatch waits; not a GPU fence. CDP event timestamps do not calibrate this interval.',
    targetMs,
    sampleId,
    nodeInvokedAtMs,
    clockPrecisionMarginMs,
    endpointPrecisionMarginMs: clockPrecisionMarginMs,
    clockBrackets: { arm, result },
  };
  const reasons = [];
  if (!arm.valid || !result.valid) reasons.push('Invalid clock bracket.');
  if (arm.sampleId !== sampleId || result.sampleId !== sampleId || event?.sampleId !== sampleId)
    reasons.push('Clock and renderer event sample IDs differ.');
  if (arm.timeOriginMs !== result.timeOriginMs) reasons.push('Renderer time origin changed.');
  if (
    !Number.isFinite(nodeInvokedAtMs) ||
    nodeInvokedAtMs < arm.nodeAfterMs ||
    nodeInvokedAtMs > result.nodeBeforeMs
  )
    reasons.push('Input invocation is outside its clock brackets.');
  const ordered = [
    arm.rendererNowMs,
    event?.inputObservedAtMs,
    event?.presentedAtMs,
    result.rendererNowMs,
  ];
  if (
    !ordered.every(Number.isFinite) ||
    ordered.some((value, index) => index > 0 && value < ordered[index - 1]) ||
    !Number.isFinite(event?.eventTimeStampMs) ||
    event.eventTimeStampMs < 0
  )
    reasons.push('Renderer event timestamps are invalid or out of order.');
  const lowerOffsetMs = Math.max(arm.lowerOffsetMs, result.lowerOffsetMs);
  const upperOffsetMs = Math.min(arm.upperOffsetMs, result.upperOffsetMs);
  if (!arm.valid || !result.valid || lowerOffsetMs > upperOffsetMs)
    reasons.push('Clock offset brackets have no valid intersection.');
  if (reasons.length)
    return { ...timing, valid: false, status: 'invalid', reasons, withinTarget: false };
  const interval = (rendererAtMs) => {
    const lowerMs = rendererAtMs + lowerOffsetMs - nodeInvokedAtMs - clockPrecisionMarginMs;
    const upperMs = rendererAtMs + upperOffsetMs - nodeInvokedAtMs + clockPrecisionMarginMs;
    return {
      lowerMs: Math.max(0, lowerMs),
      estimateMs: Math.max(0, (lowerMs + upperMs) / 2),
      upperMs,
      uncertaintyMs: (upperMs - lowerMs) / 2,
    };
  };
  const input = interval(event.inputObservedAtMs);
  const presentation = interval(event.presentedAtMs);
  if (input.upperMs < 0 || presentation.upperMs < 0)
    return {
      ...timing,
      valid: false,
      status: 'invalid',
      reasons: ['The clock intersection places observed input before its invocation.'],
      withinTarget: false,
    };
  return {
    ...timing,
    valid: true,
    status:
      presentation.upperMs < targetMs
        ? 'within-target'
        : presentation.lowerMs >= targetMs
          ? 'over-budget'
          : 'uncertain-at-target',
    clockOffsetMs: { lowerMs: lowerOffsetMs, upperMs: upperOffsetMs },
    invokeToInputObservedMs: input,
    ...presentation,
    withinTarget: presentation.upperMs < targetMs,
  };
}

export function navigationActionSummary(
  sampleId,
  invocations,
  events,
  arm,
  result,
  expectedCount,
  targetMs = 100,
) {
  // Pointer coordinates only permit float representation error, never a one-pixel mismatch.
  const coordinateTolerancePx = 1e-3;
  // Chromium WheelEvent inherits MouseEvent's floored client coordinate getters;
  // PointerEvent overrides those getters to preserve fractional pointer coordinates.
  // https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/events/mouse_event.h
  // https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/events/wheel_event.h
  // This benchmark only normalizes nonnegative viewport CSS coordinates for wheels.
  const reasons = [];
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0)
    reasons.push('Invalid expected navigation input count.');
  if (invocations.length !== expectedCount || events.length !== expectedCount)
    reasons.push(
      `Expected ${expectedCount} inputs/events; observed ${invocations.length} invocations and ${events.length} renderer events.`,
    );
  const samples = [];
  for (let index = 0; index < Math.max(invocations.length, events.length); index++) {
    const invocation = invocations[index];
    const event = events[index];
    const normalizedExpectedCoordinates = invocation
      ? {
          model:
            invocation.type === 'wheel' ? 'chromium-wheel-client-floor' : 'pointer-client-identity',
          clientX: invocation.type === 'wheel' ? Math.floor(invocation.x) : invocation.x,
          clientY: invocation.type === 'wheel' ? Math.floor(invocation.y) : invocation.y,
        }
      : null;
    const pairingErrors = [];
    let actionInvokeToPresentation = null;
    if (!invocation || !event) pairingErrors.push('Missing invocation or renderer event.');
    else {
      if (
        invocation.sampleId !== sampleId ||
        event.sampleId !== sampleId ||
        invocation.inputIndex !== index ||
        event.eventSequence !== index
      )
        pairingErrors.push('Navigation sample identity/order differs.');
      if (
        !['pointermove', 'pointerdown', 'pointerup', 'wheel'].includes(invocation.type) ||
        invocation.type !== event.type
      )
        pairingErrors.push('Navigation event type differs.');
      if (
        invocation.type === 'wheel' &&
        (!Number.isFinite(invocation.x) ||
          !Number.isFinite(invocation.y) ||
          invocation.x < 0 ||
          invocation.y < 0)
      )
        pairingErrors.push('Wheel normalization requires finite nonnegative viewport coordinates.');
      for (const [expected, actual, label] of [
        [normalizedExpectedCoordinates.clientX, event.clientX, 'clientX'],
        [normalizedExpectedCoordinates.clientY, event.clientY, 'clientY'],
        ...(invocation.type === 'wheel'
          ? [
              [invocation.deltaX, event.deltaX, 'deltaX'],
              [invocation.deltaY, event.deltaY, 'deltaY'],
              [0, event.deltaMode, 'deltaMode'],
            ]
          : []),
        ...(invocation.button === undefined ? [] : [[invocation.button, event.button, 'button']]),
        ...(invocation.buttons === undefined
          ? []
          : [[invocation.buttons, event.buttons, 'buttons']]),
      ])
        if (
          !Number.isFinite(expected) ||
          !Number.isFinite(actual) ||
          Math.abs(expected - actual) >
            (invocation.type === 'wheel' && (label === 'clientX' || label === 'clientY')
              ? 0
              : coordinateTolerancePx)
        )
          pairingErrors.push(`Navigation ${label} is nonfinite or differs.`);
      if (
        index > 0 &&
        (invocation.nodeInvokedAtMs < invocations[index - 1].nodeInvokedAtMs ||
          event.inputObservedAtMs < events[index - 1].inputObservedAtMs ||
          event.presentedAtMs < events[index - 1].presentedAtMs)
      )
        pairingErrors.push('Navigation timestamps were reordered.');
      if (!Number.isFinite(event.fromEventMs) || event.fromEventMs < 0)
        pairingErrors.push('Invalid original event-to-frame duration.');
      actionInvokeToPresentation = eventActionTiming(
        sampleId,
        invocation.nodeInvokedAtMs,
        arm,
        result,
        event,
        targetMs,
      );
    }
    samples.push({
      index,
      invocation: invocation ?? null,
      event: event ?? null,
      normalizedExpectedCoordinates,
      pairingErrors,
      actionInvokeToPresentation,
      withinTarget:
        pairingErrors.length === 0 &&
        actionInvokeToPresentation?.valid === true &&
        actionInvokeToPresentation.withinTarget === true &&
        event.fromEventMs < targetMs,
    });
  }
  return {
    sampleId,
    targetMs,
    timing: `Strict ordered 1:1 original navigation invocation/event pairing. Each original fromEventMs and calibrated invocation-to-second-frame upper bound must be strictly below ${targetMs} ms, under the recorded clock precision/drift assumption.`,
    scope:
      'One measured pan has initial move, down, six distinct-head moves and up (9); one measured zoom has initial move and four wheels (5), totaling 14 for a selected pan/zoom pair. Home and zoomed-out setup inputs are outside this sample.',
    expectedCount,
    invocationCount: invocations.length,
    rendererEventCount: events.length,
    coordinateTolerancePx,
    coordinateNormalization:
      'Pointer client coordinates retain the raw expectation with 1e-3 px float tolerance. Chromium wheel client coordinates must exactly equal Math.floor(raw expectation), limited to finite nonnegative viewport CSS coordinates; raw expectations and observed coordinates are retained.',
    clockBrackets: { arm, result },
    reasons,
    samples,
    valid:
      reasons.length === 0 &&
      samples.every(
        (sample) =>
          sample.pairingErrors.length === 0 && sample.actionInvokeToPresentation?.valid === true,
      ),
    withinTarget: reasons.length === 0 && samples.every((sample) => sample.withinTarget),
  };
}

export function schematicActionSummary(
  sampleId,
  actions,
  events,
  arm,
  result,
  observeKeyUp = false,
  targetMs = 100,
) {
  return schematicTimingSummary(
    sampleId,
    actions,
    events,
    arm,
    result,
    observeKeyUp,
    false,
    targetMs,
  );
}

export const layoutTrackProtocol = 'paced-single-api-inputs-v2';

export function layoutTrackActionSummary(sampleId, actions, events, arm, result, targetMs = 100) {
  const plans = {
    'layout-track-paced-pickup': ['key-down:d', 'key-up:d'],
    'layout-track-paced-preview': Array(7).fill('move'),
    'layout-track-paced-commit': ['key-down:Enter', 'key-up:Enter'],
    'layout-track-paced-pointer': ['down', ...Array(7).fill('move'), 'up'],
    'layout-track-paced-obstacle-pickup': ['key-down:d', 'key-up:d'],
    'layout-track-paced-obstacle-preview': Array(7).fill('move'),
    'layout-track-paced-obstacle-commit': ['key-down:Enter', 'key-up:Enter'],
  };
  const plan = plans[sampleId];
  const expectedCount = plan?.length ?? 0;
  const reasons = [];
  if (!plan || actions.length !== plan.length)
    reasons.push('Missing or unexpected original paced Layout actions.');
  const expected = [];
  for (const [index, action] of actions.entries()) {
    const keyboard = action.method === 'key-down' || action.method === 'key-up';
    const signature = keyboard ? `${action.method}:${action.key}` : action.method;
    const transport = keyboard
      ? `playwright.keyboard.${action.method === 'key-down' ? 'down' : 'up'}`
      : `playwright.mouse.${action.method}`;
    if (
      signature !== plan?.[index] ||
      action.transport !== transport ||
      action.sampleId !== sampleId ||
      action.actionIndex !== index ||
      !Number.isFinite(action.nodeInvokedAtMs) ||
      (index > 0 && action.nodeInvokedAtMs <= actions[index - 1].nodeInvokedAtMs) ||
      (action.method === 'move' &&
        (action.steps !== 1 ||
          (actions[index - 1]?.method === 'move' &&
            action.x === actions[index - 1].x &&
            action.y === actions[index - 1].y)))
    )
      reasons.push(`Invalid original paced Layout action ${index}.`);
    const common = { action, actionIndex: index };
    if (keyboard) {
      const code = action.key === 'd' ? 'KeyD' : 'Enter';
      expected.push({
        ...common,
        type: action.method === 'key-down' ? 'keydown' : 'keyup',
        key: action.key,
        code,
      });
    } else {
      expected.push({
        ...common,
        type: { move: 'pointermove', down: 'pointerdown', up: 'pointerup' }[action.method],
        clientX: action.x,
        clientY: action.y,
        buttons: sampleId === 'layout-track-paced-pointer' && action.method !== 'up' ? 1 : 0,
        button: action.method === 'move' ? -1 : 0,
      });
    }
  }
  if (events.length !== expectedCount)
    reasons.push(`Expected ${expectedCount} paced Layout events; observed ${events.length}.`);
  const samples = expected.map((invocation, index) => {
    const event = events[index];
    const pairingErrors = [];
    if (!event || event.sampleId !== sampleId || event.eventSequence !== index)
      pairingErrors.push('Missing or reordered paced Layout event.');
    if (
      event?.type !== invocation.type ||
      ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].some((key) => event?.[key] !== false)
    )
      pairingErrors.push('Paced Layout event type or modifiers differ.');
    if (invocation.key) {
      if (
        event?.key !== invocation.key ||
        event?.code !== invocation.code ||
        event?.repeat !== false ||
        event?.isComposing !== false
      )
        pairingErrors.push('Paced Layout key differs.');
    } else {
      for (const key of ['clientX', 'clientY', 'buttons', 'button'])
        if (
          !Number.isFinite(invocation[key]) ||
          !Number.isFinite(event?.[key]) ||
          Math.abs(invocation[key] - event[key]) > (key.startsWith('client') ? 1e-3 : 0)
        )
          pairingErrors.push(`Paced Layout ${key} differs.`);
    }
    if (
      !Number.isFinite(event?.fromEventMs) ||
      event.fromEventMs < 0 ||
      (index > 0 &&
        (event?.inputObservedAtMs < events[index - 1]?.inputObservedAtMs ||
          event?.presentedAtMs < events[index - 1]?.presentedAtMs))
    )
      pairingErrors.push('Invalid paced Layout event timing.');
    const actionInvokeToPresentation = eventActionTiming(
      sampleId,
      invocation.action.nodeInvokedAtMs,
      arm,
      result,
      event,
      targetMs,
    );
    return {
      index,
      actionIndex: invocation.actionIndex,
      invocation: invocation.action,
      event,
      pairingErrors,
      actionInvokeToPresentation,
      withinTarget:
        pairingErrors.length === 0 &&
        actionInvokeToPresentation.valid === true &&
        actionInvokeToPresentation.withinTarget === true &&
        event.fromEventMs < targetMs,
    };
  });
  return {
    sampleId,
    protocol: layoutTrackProtocol,
    targetMs,
    timing: `Each original single-input Playwright API invocation and original event timestamp through the second animation frame must both be strictly below ${targetMs} ms. Keyboard down/up have separate original invocations; no GPU fence is observed.`,
    expectedActionCount: plan?.length ?? 0,
    expectedCount,
    originalActionCount: actions.length,
    rendererEventCount: events.length,
    clockBrackets: { arm, result },
    reasons,
    samples,
    valid:
      reasons.length === 0 &&
      samples.every(
        (sample) => sample.pairingErrors.length === 0 && sample.actionInvokeToPresentation.valid,
      ),
    withinTarget:
      reasons.length === 0 && samples.length > 0 && samples.every((sample) => sample.withinTarget),
  };
}

export function schematicPacedActionSummary(
  sampleId,
  actions,
  events,
  arm,
  result,
  observeKeyUp = false,
  targetMs = 100,
) {
  return schematicTimingSummary(
    sampleId,
    actions,
    events,
    arm,
    result,
    observeKeyUp,
    true,
    targetMs,
  );
}

function schematicTimingSummary(
  sampleId,
  actions,
  events,
  arm,
  result,
  observeKeyUp,
  paced,
  targetMs,
) {
  const edit = sampleId === (paced ? 'schematic-edit-paced' : 'schematic-edit');
  const drag = sampleId === (paced ? 'schematic-drag-paced' : 'schematic-drag');
  const expectedActionCount = drag && paced ? 42 : 15;
  const expectedCount = edit ? (observeKeyUp ? 45 : 30) : drag ? (observeKeyUp ? 51 : 45) : 0;
  const coordinateTolerancePx = 1e-3;
  const reasons = [];
  if ((!edit && !drag) || typeof observeKeyUp !== 'boolean')
    reasons.push('Invalid schematic operation or keyup observation mode.');
  if (actions.length !== expectedActionCount)
    reasons.push(
      `Expected ${expectedActionCount} original API actions; observed ${actions.length}.`,
    );
  const invocations = [];
  let position = null;
  let buttons = 0;
  const plainModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (
      action.sampleId !== sampleId ||
      action.actionIndex !== index ||
      !Number.isFinite(action.nodeInvokedAtMs) ||
      (index > 0 &&
        (paced
          ? action.nodeInvokedAtMs <= actions[index - 1].nodeInvokedAtMs
          : action.nodeInvokedAtMs < actions[index - 1].nodeInvokedAtMs))
    )
      reasons.push(`Original API action ${index} has invalid identity/order/timestamp.`);
    const cycle = index % (edit ? 3 : paced ? 14 : 5);
    const expectedMethod = edit
      ? ['click', 'press', 'press'][cycle]
      : paced
        ? cycle === 1
          ? 'down'
          : cycle === 12
            ? 'up'
            : cycle === 13
              ? 'press'
              : 'move'
        : ['move', 'down', 'move', 'up', 'press'][cycle];
    if (
      action.method !== expectedMethod ||
      (action.method === 'press' &&
        action.key !== (edit && cycle === 1 ? 'ArrowRight' : 'Control+z')) ||
      (action.method === 'move' && action.steps !== (!paced && cycle === 2 ? 10 : 1)) ||
      (['down', 'up'].includes(action.method) && action.button !== 'left') ||
      (action.method === 'click' && action.targetTestId !== 'symbol-hit-R1')
    )
      reasons.push(`Original API action ${index} differs from the fixed schematic sequence.`);
    let geometryPoint = null;
    if (paced && drag) {
      const round = Math.floor(index / 14);
      const geometry = actions[round * 14]?.gesture;
      const bounds = geometry?.bounds;
      const ctmA = geometry?.ctmA;
      const distance = Math.max(5.08 * ctmA, 8);
      const begin = { x: bounds?.x + bounds?.width / 2, y: bounds?.y + bounds?.height / 2 };
      const end = { x: begin.x + distance, y: begin.y };
      if (
        geometry?.round !== round ||
        ![
          bounds?.x,
          bounds?.y,
          bounds?.width,
          bounds?.height,
          ctmA,
          geometry?.distance,
          geometry?.begin?.x,
          geometry?.begin?.y,
          geometry?.end?.x,
          geometry?.end?.y,
        ].every(Number.isFinite) ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        ctmA <= 0 ||
        geometry.distance !== distance ||
        geometry.begin.x !== begin.x ||
        geometry.begin.y !== begin.y ||
        geometry.end.x !== end.x ||
        geometry.end.y !== end.y ||
        JSON.stringify(action.gesture) !== JSON.stringify(geometry)
      )
        reasons.push(`Paced drag action ${index} has inconsistent original gesture geometry.`);
      if (cycle <= 1) geometryPoint = begin;
      else if (cycle <= 11) {
        // Exactly the old Playwright steps:10 formula and operation order,
        // based on the original geometry, never on the sent/event coordinates.
        const fraction = (cycle - 1) / 10;
        geometryPoint = {
          x: begin.x + (end.x - begin.x) * fraction,
          y: begin.y + (end.y - begin.y) * fraction,
        };
      } else if (cycle === 12) geometryPoint = end;
      if (
        action.method === 'move' &&
        (action.x !== geometryPoint?.x || action.y !== geometryPoint?.y)
      )
        reasons.push(
          `Paced drag action ${index} differs from its original exact interpolation head.`,
        );
    }
    const expected = [];
    const pointer = (type, x, y, button, mask, coordinateModel = 'raw-pointer') => ({
      type,
      x,
      y,
      button,
      buttons: mask,
      coordinateModel,
      ...plainModifiers,
    });
    if (action.method === 'click') {
      const { x, y } = action.point ?? {};
      // Installed Playwright roundPoint truncates positive locator click points
      // to 0.01 CSS px. The caller establishes a fully visible, single-quad R1.
      if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value * 100 < 2 ** 31))
        reasons.push(`Locator click ${index} is outside the supported positive viewport domain.`);
      const model = 'playwright-locator-click-truncate-0.01px';
      expected.push(
        pointer('pointermove', x, y, -1, 0, model),
        pointer('pointerdown', x, y, 0, 1, model),
        pointer('pointerup', x, y, 0, 0, model),
      );
      position = { x: Math.trunc(x * 100) / 100, y: Math.trunc(y * 100) / 100 };
      buttons = 0;
    } else if (action.method === 'move') {
      if (![1, 10].includes(action.steps))
        reasons.push(`Unsupported pointer step count at action ${index}.`);
      else {
        if (action.steps > 1 && !position)
          reasons.push(`Pointer interpolation ${index} has no original start.`);
        for (let step = 1; step <= action.steps; step++) {
          const fraction = step / action.steps;
          const x =
            geometryPoint?.x ??
            (action.steps === 1 ? action.x : position?.x + (action.x - position?.x) * fraction);
          const y =
            geometryPoint?.y ??
            (action.steps === 1 ? action.y : position?.y + (action.y - position?.y) * fraction);
          expected.push(pointer('pointermove', x, y, -1, buttons));
        }
      }
      position = { x: action.x, y: action.y };
    } else if (action.method === 'down' || action.method === 'up') {
      buttons = action.method === 'down' ? 1 : 0;
      expected.push(
        pointer(
          action.method === 'down' ? 'pointerdown' : 'pointerup',
          geometryPoint?.x ?? position?.x,
          geometryPoint?.y ?? position?.y,
          0,
          buttons,
        ),
      );
    } else if (action.method === 'press') {
      const key = (type, value, code, ctrlKey = false) => ({
        type,
        key: value,
        code,
        repeat: false,
        isComposing: false,
        ...plainModifiers,
        ctrlKey,
      });
      if (action.key === 'ArrowRight') {
        expected.push(key('keydown', 'ArrowRight', 'ArrowRight'));
        if (observeKeyUp) expected.push(key('keyup', 'ArrowRight', 'ArrowRight'));
      } else if (action.key === 'Control+z') {
        expected.push(
          key('keydown', 'Control', 'ControlLeft', true),
          key('keydown', 'z', 'KeyZ', true),
        );
        if (observeKeyUp)
          expected.push(key('keyup', 'z', 'KeyZ', true), key('keyup', 'Control', 'ControlLeft'));
      } else reasons.push(`Unsupported schematic key at action ${index}.`);
    } else reasons.push(`Unsupported original API action ${index}.`);
    expected.forEach((input, actionEventIndex) =>
      invocations.push({
        sampleId,
        inputIndex: invocations.length,
        actionIndex: index,
        actionEventIndex,
        actionEventCount: expected.length,
        transport: action.transport,
        nodeInvokedAtMs: action.nodeInvokedAtMs,
        ...input,
      }),
    );
  }
  if (invocations.length !== expectedCount || events.length !== expectedCount)
    reasons.push(
      `Expected ${expectedCount} schematic inputs/events; expanded ${invocations.length} inputs and observed ${events.length} renderer events.`,
    );
  const samples = [];
  for (let index = 0; index < Math.max(invocations.length, events.length); index++) {
    const invocation = invocations[index],
      event = events[index];
    const pairingErrors = [];
    let normalizedExpectedCoordinates = null,
      actionInvokeToPresentation = null;
    if (!invocation || !event)
      pairingErrors.push('Missing original action event or renderer event.');
    else {
      if (
        event.sampleId !== sampleId ||
        event.eventSequence !== index ||
        event.type !== invocation.type
      )
        pairingErrors.push('Schematic event identity/order/type differs.');
      if (invocation.type.startsWith('pointer')) {
        const truncate = invocation.coordinateModel === 'playwright-locator-click-truncate-0.01px';
        normalizedExpectedCoordinates = {
          model: invocation.coordinateModel,
          clientX: truncate ? Math.trunc(invocation.x * 100) / 100 : invocation.x,
          clientY: truncate ? Math.trunc(invocation.y * 100) / 100 : invocation.y,
        };
        for (const [expected, actual, label] of [
          [normalizedExpectedCoordinates.clientX, event.clientX, 'clientX'],
          [normalizedExpectedCoordinates.clientY, event.clientY, 'clientY'],
          [invocation.button, event.button, 'button'],
          [invocation.buttons, event.buttons, 'buttons'],
        ])
          if (
            !Number.isFinite(expected) ||
            !Number.isFinite(actual) ||
            Math.abs(expected - actual) > (label.startsWith('client') ? coordinateTolerancePx : 0)
          )
            pairingErrors.push(`Schematic ${label} is nonfinite or differs.`);
      } else {
        for (const field of ['key', 'code', 'repeat', 'isComposing'])
          if (event[field] !== invocation[field])
            pairingErrors.push(`Schematic keyboard ${field} differs.`);
      }
      for (const field of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'])
        if (event[field] !== invocation[field]) pairingErrors.push(`Schematic ${field} differs.`);
      if (
        index > 0 &&
        (event.inputObservedAtMs < events[index - 1].inputObservedAtMs ||
          event.presentedAtMs < events[index - 1].presentedAtMs)
      )
        pairingErrors.push('Schematic renderer timestamps were reordered.');
      if (!Number.isFinite(event.fromEventMs) || event.fromEventMs < 0)
        pairingErrors.push('Invalid original event-to-frame duration.');
      actionInvokeToPresentation = eventActionTiming(
        sampleId,
        invocation.nodeInvokedAtMs,
        arm,
        result,
        event,
        targetMs,
      );
    }
    samples.push({
      index,
      invocation: invocation ?? null,
      event: event ?? null,
      normalizedExpectedCoordinates,
      pairingErrors,
      actionInvokeToPresentation,
      withinTarget:
        pairingErrors.length === 0 &&
        actionInvokeToPresentation?.valid === true &&
        actionInvokeToPresentation.withinTarget === true &&
        event.fromEventMs < targetMs,
    });
  }
  return {
    sampleId,
    targetMs,
    protocol: paced ? 'paced-single-api-inputs' : 'legacy-whole-api-gestures',
    observeKeyUp,
    expectedActionCount,
    originalActionCount: actions.length,
    expectedCount,
    expandedInvocationCount: invocations.length,
    rendererEventCount: events.length,
    coordinateTolerancePx,
    clockBrackets: { arm, result },
    actions,
    reasons,
    samples,
    timing: paced
      ? `Low-frequency single-input acceptance: original public Playwright API invocation through each observed event and its second animation frame. Each of the original ten exact drag heads is sent by its own steps:1 API call. Click/modifier-key subevents share that API invocation; no per-dispatch timestamp is inferred. Both original fromEventMs and calibrated action upper bound must be strictly below ${targetMs} ms under the recorded precision/drift assumption. Not comparable to the legacy continuous gesture; no GPU fence or specific document-render completion is observed.`
      : `Every observed schematic event is paired in original order with its original Playwright API invocation. Multiple click/key/steps:10 subevents share that invocation timestamp, including earlier steps and Playwright preparation; no per-dispatch Node timestamp is inferred. Both original fromEventMs and the calibrated invocation-to-second-frame upper bound must be strictly below ${targetMs} ms under the recorded precision/drift assumption. This is whole-API gesture timing, not an individual event latency for a multi-step call. No GPU fence or specific document-render completion is observed.`,
    valid:
      reasons.length === 0 &&
      samples.every(
        (sample) =>
          sample.pairingErrors.length === 0 && sample.actionInvokeToPresentation?.valid === true,
      ),
    withinTarget: reasons.length === 0 && samples.every((sample) => sample.withinTarget),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { default: assert } = await import('node:assert/strict');
  let count = 0;
  const check = (name, operation) => {
    try {
      operation();
      count++;
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  };
  const sampleId = 'cad:1';
  const clock = (rendererNowMs, overrides = {}) => ({
    sampleId,
    rendererNowMs,
    timeOriginMs: 100_000,
    ...overrides,
  });
  const fixture = ({ offset = 1_000, presented = 1_160 } = {}) => ({
    // The known physical invocation is Node 1,100, with input at 1,110
    // and presentation at 1,160. Both calibration round trips span 4 ms.
    arm: clockBracket(1_000, 1_004, clock(1_002 - offset)),
    result: clockBracket(1_400, 1_404, clock(1_402 - offset)),
    commit: {
      sampleId,
      rendererTimes: {
        inputObservedAtMs: 1_110 - offset,
        meshObservedAtMs: 1_130 - offset,
        renderObservedAtMs: 1_150 - offset,
        presentedAtMs: presented - offset,
      },
    },
  });
  const measure = (value, invokedAtMs = 1_100) =>
    actionTiming(sampleId, invokedAtMs, value.arm, value.result, value.commit);
  const invalid = (value) => {
    const measured = measure(value);
    assert.equal(measured.valid, false);
    assert.equal(measured.status, 'invalid');
    assert.equal(measured.withinTarget, false);
    assert.ok(measured.reasons.length > 0);
  };

  check('known positive offset bracket', () => {
    const bracket = clockBracket(1_000, 1_004, clock(900));
    assert.equal(bracket.rawLowerOffsetMs, 100);
    assert.equal(bracket.rawUpperOffsetMs, 104);
    assert.equal(bracket.lowerOffsetMs, 98);
    assert.equal(bracket.upperOffsetMs, 106);
  });
  check('known negative offset bracket', () => {
    const bracket = clockBracket(1_000, 1_004, clock(1_100));
    assert.equal(bracket.rawLowerOffsetMs, -100);
    assert.equal(bracket.rawUpperOffsetMs, -96);
    assert.equal(bracket.lowerOffsetMs, -102);
    assert.equal(bracket.upperOffsetMs, -94);
  });
  for (const offset of [1_000, -1_000])
    check(`known 60 ms presentation, offset ${offset}`, () => {
      const measured = measure(fixture({ offset }));
      assert.equal(measured.valid, true);
      assert.equal(measured.withinTarget, true);
      assert.equal(measured.estimateMs, 60);
      assert.equal(measured.lowerMs, 54);
      assert.equal(measured.upperMs, 66);
      assert.equal(measured.uncertaintyMs, 6);
      assert.ok(measured.lowerMs <= 60 && measured.upperMs >= 60);
      assert.deepEqual(measured.invokeToInputObservedMs, {
        lowerMs: 4,
        estimateMs: 10,
        upperMs: 16,
        uncertaintyMs: 6,
      });
    });
  check('calibration intersection', () => {
    const value = fixture();
    value.result = clockBracket(1_400, 1_404, clock(400));
    const measured = measure(value);
    assert.deepEqual(measured.clockOffsetMs, { lowerMs: 998, upperMs: 1_004 });
    assert.equal(measured.lowerMs, 56);
    assert.equal(measured.upperMs, 66);
    assert.equal(measured.estimateMs, 61);
  });
  for (const [presented, lower, upper, status, withinTarget] of [
    [1_193, 87, 99, 'within-target', true],
    [1_194, 88, 100, 'uncertain-at-target', false],
    [1_200, 94, 106, 'uncertain-at-target', false],
    [1_206, 100, 112, 'over-budget', false],
  ])
    check(`strict 100 ms target, presentation ${presented - 1_100} ms`, () => {
      const measured = measure(fixture({ presented }));
      assert.equal(measured.valid, true);
      assert.equal(measured.lowerMs, lower);
      assert.equal(measured.upperMs, upper);
      assert.equal(measured.status, status);
      assert.equal(measured.withinTarget, withinTarget);
    });
  check('empty clock intersection', () => {
    const value = fixture();
    value.result = clockBracket(1_400, 1_404, clock(420));
    invalid(value);
  });
  check('changed time origin', () => {
    const value = fixture();
    value.result = clockBracket(1_400, 1_404, clock(402, { timeOriginMs: 100_001 }));
    invalid(value);
  });
  for (const field of ['arm', 'result', 'commit'])
    check(`changed ${field} sample ID`, () => {
      const value = fixture();
      value[field].sampleId = 'cad:2';
      invalid(value);
    });
  for (const [name, before, after, sampled] of [
    ['Node before NaN', NaN, 1_004, clock(2)],
    ['Node after infinity', 1_000, Infinity, clock(2)],
    ['renderer NaN', 1_000, 1_004, clock(NaN)],
    ['origin infinity', 1_000, 1_004, clock(2, { timeOriginMs: Infinity })],
    ['reverse Node bracket', 1_004, 1_000, clock(2)],
  ])
    check(name, () => {
      const value = fixture();
      value.arm = clockBracket(before, after, sampled);
      assert.equal(value.arm.valid, false);
      invalid(value);
    });
  check('nonfinite input invocation', () => {
    const measured = measure(fixture(), NaN);
    assert.equal(measured.valid, false);
    assert.equal(measured.withinTarget, false);
  });
  for (const invokedAtMs of [1_003, 1_401])
    check(`invocation outside bracket ${invokedAtMs}`, () => {
      const measured = measure(fixture(), invokedAtMs);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  check('nonfinite readiness', () => {
    const value = fixture();
    value.commit.rendererTimes.presentedAtMs = NaN;
    invalid(value);
  });
  check('out-of-order readiness', () => {
    const value = fixture();
    value.commit.rendererTimes.meshObservedAtMs = 170;
    invalid(value);
  });
  check('missing readiness', () => {
    const value = fixture();
    delete value.commit.rendererTimes;
    invalid(value);
  });
  check('input cannot predate invocation', () => {
    const value = fixture();
    value.commit.rendererTimes.inputObservedAtMs = 80;
    invalid(value);
  });
  for (const [fromEventMs, presented, expected] of [
    [99, 1_193, true],
    [100, 1_193, false],
    [99, 1_194, false],
    [99, 1_200, false],
    [NaN, 1_193, false],
    [Infinity, 1_193, false],
    [-1, 1_193, false],
  ])
    check(`combined target, event ${fromEventMs}, presentation ${presented - 1_100}`, () => {
      assert.equal(
        isCadCommitWithinTarget({
          fromEventMs,
          actionInvokeToCadPresentation: measure(fixture({ presented })),
        }),
        expected,
      );
    });
  check('combined target rejects invalid calibration', () => {
    const value = fixture();
    value.result = clockBracket(1_400, 1_404, clock(420));
    assert.equal(
      isCadCommitWithinTarget({ fromEventMs: 20, actionInvokeToCadPresentation: measure(value) }),
      false,
    );
  });
  check('combined target requires the action timing', () => {
    assert.equal(isCadCommitWithinTarget({ fromEventMs: 20 }), false);
  });
  const navigationFixture = (offset = 1_000) => {
    const value = fixture({ offset });
    value.invocations = ['pointermove', 'pointerdown', 'wheel'].map((type, index) => ({
      sampleId,
      inputIndex: index,
      type,
      x: 20 + index,
      y: 30,
      ...(type === 'wheel' ? { deltaX: 0, deltaY: -50 } : {}),
      nodeInvokedAtMs: 1_100 + index * 20,
    }));
    value.events = value.invocations.map((invocation, index) => ({
      sampleId,
      eventSequence: index,
      type: invocation.type,
      clientX: invocation.x,
      clientY: invocation.y,
      deltaX: invocation.deltaX ?? null,
      deltaY: invocation.deltaY ?? null,
      deltaMode: invocation.type === 'wheel' ? 0 : null,
      inputObservedAtMs: 1_110 + index * 20 - offset,
      eventTimeStampMs: 1_109.5 + index * 20 - offset,
      presentedAtMs: 1_160 + index * 20 - offset,
      fromEventMs: 50.5,
    }));
    return value;
  };
  const navigationMeasure = (value) =>
    navigationActionSummary(sampleId, value.invocations, value.events, value.arm, value.result, 3);
  for (const offset of [1_000, -1_000])
    check(`navigation ordered real coordinates and calibrated intervals, offset ${offset}`, () => {
      const measured = navigationMeasure(navigationFixture(offset));
      assert.equal(measured.valid, true);
      assert.equal(measured.withinTarget, true);
      assert.equal(measured.samples.length, 3);
      for (const sample of measured.samples) {
        assert.equal(sample.actionInvokeToPresentation.estimateMs, 60);
        assert.equal(sample.actionInvokeToPresentation.upperMs, 66);
      }
    });
  const fractionalNavigationFixture = () => {
    const value = navigationFixture();
    for (const index of [0, 2]) {
      value.invocations[index].x = 651.0000305175781;
      value.invocations[index].y = 428.6666793823242;
      value.events[index].clientX = 651;
      value.events[index].clientY = index === 2 ? 428 : 428.66668701171875;
    }
    return value;
  };
  check(
    'fractional pointer remains raw and Chromium wheel uses explicit integer expectation',
    () => {
      const value = fractionalNavigationFixture();
      const originalInvocations = structuredClone(value.invocations);
      const originalEvents = structuredClone(value.events);
      const measured = navigationMeasure(value);
      assert.equal(measured.valid, true);
      assert.equal(measured.withinTarget, true);
      assert.equal(measured.coordinateTolerancePx, 1e-3);
      assert.deepEqual(measured.samples[0].normalizedExpectedCoordinates, {
        model: 'pointer-client-identity',
        clientX: 651.0000305175781,
        clientY: 428.6666793823242,
      });
      assert.deepEqual(measured.samples[2].normalizedExpectedCoordinates, {
        model: 'chromium-wheel-client-floor',
        clientX: 651,
        clientY: 428,
      });
      assert.deepEqual(value.invocations, originalInvocations);
      assert.deepEqual(value.events, originalEvents);
      assert.deepEqual(
        measured.samples.map((sample) => sample.actionInvokeToPresentation),
        navigationMeasure(navigationFixture()).samples.map(
          (sample) => sample.actionInvokeToPresentation,
        ),
      );
    },
  );
  for (const coordinate of ['clientX', 'clientY'])
    for (const delta of [-1, 1])
      check(`fractional wheel rejects adjacent integer pixel ${coordinate}/${delta}`, () => {
        const value = fractionalNavigationFixture();
        value.events[2][coordinate] += delta;
        const measured = navigationMeasure(value);
        assert.equal(measured.valid, false);
        assert.equal(measured.withinTarget, false);
        assert.ok(measured.samples[2].pairingErrors.some((reason) => reason.includes(coordinate)));
      });
  check('fractional pointer cannot use floored wheel expectation', () => {
    const value = fractionalNavigationFixture();
    value.events[0].clientY = 428;
    const measured = navigationMeasure(value);
    assert.equal(measured.valid, false);
    assert.equal(measured.withinTarget, false);
  });
  check('wheel integer coordinates reject fractional near-integer observations', () => {
    const value = fractionalNavigationFixture();
    value.events[2].clientY += 0.0005;
    const measured = navigationMeasure(value);
    assert.equal(measured.valid, false);
    assert.equal(measured.withinTarget, false);
  });
  for (const x of [-0.1, Infinity])
    check(`wheel normalization rejects outside-domain raw coordinate ${x}`, () => {
      const value = fractionalNavigationFixture();
      value.invocations[2].x = x;
      value.events[2].clientX = Math.floor(x);
      const measured = navigationMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  for (const mutate of [
    (value) => value.events.pop(),
    (value) => value.events.push({ ...value.events[2] }),
    (value) => value.invocations.pop(),
    (value) => value.events.reverse(),
    (value) => (value.events[1].clientX += 1),
    (value) => (value.events[2].deltaY = 50),
    (value) => (value.events[1].clientY = NaN),
    (value) => (value.events[0].sampleId = 'other-operation'),
  ])
    check(`navigation rejects missing/extra/reordered/mismatched input ${count}`, () => {
      const value = navigationFixture();
      mutate(value);
      const measured = navigationMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  for (const [presentedAtMs, fromEventMs, expected] of [
    [193, 50.5, true],
    [194, 50.5, false],
    [200, 50.5, false],
    [160, 100, false],
  ])
    check(`navigation strict combined boundary ${presentedAtMs}/${fromEventMs}`, () => {
      const value = navigationFixture();
      value.events.forEach((event, index) => {
        event.presentedAtMs = presentedAtMs + index * 20;
      });
      value.events[0].fromEventMs = fromEventMs;
      const measured = navigationMeasure(value);
      assert.equal(measured.valid, true);
      assert.equal(measured.withinTarget, expected);
    });
  for (const mutate of [
    (value) => (value.result.timeOriginMs += 1),
    (value) => (value.result = clockBracket(1_400, 1_404, clock(420))),
    (value) => (value.events[1].inputObservedAtMs = Infinity),
    (value) => delete value.events[1].presentedAtMs,
  ])
    check(`navigation clock/timestamp invalid ${count}`, () => {
      const value = navigationFixture();
      mutate(value);
      const measured = navigationMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  const schematicFixture = (operation = 'schematic-edit', observeKeyUp = false, offset = 1_000) => {
    const paced = operation.endsWith('-paced');
    const value = {
      operation,
      observeKeyUp,
      arm: clockBracket(1_000, 1_004, clock(1_002 - offset, { sampleId: operation })),
      result: paced
        ? clockBracket(30_000, 30_004, clock(30_002 - offset, { sampleId: operation }))
        : clockBracket(2_000, 2_004, clock(2_002 - offset, { sampleId: operation })),
      actions: [],
      events: [],
    };
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const pointer = (type, clientX, clientY, buttons, button = -1) => ({
      type,
      clientX,
      clientY,
      buttons,
      button,
      ...plain,
    });
    const key = (type, key, code, ctrlKey = false) => ({
      type,
      key,
      code,
      repeat: false,
      isComposing: false,
      ...plain,
      ctrlKey,
    });
    let gesture = null;
    const add = (action, delivered) => {
      const actionIndex = value.actions.length;
      const nodeInvokedAtMs = 1_100 + actionIndex * (paced ? 300 : 25);
      value.actions.push({
        sampleId: operation,
        actionIndex,
        nodeInvokedAtMs,
        ...(gesture ? { gesture } : {}),
        ...action,
      });
      delivered.forEach((event, index) =>
        value.events.push({
          sampleId: operation,
          eventSequence: value.events.length,
          inputObservedAtMs: nodeInvokedAtMs + 10 + index - offset,
          eventTimeStampMs: nodeInvokedAtMs + 9.5 + index - offset,
          presentedAtMs: nodeInvokedAtMs + 60 + index - offset,
          fromEventMs: 50.5,
          ...event,
        }),
      );
    };
    const undo = () =>
      add({ method: 'press', key: 'Control+z' }, [
        key('keydown', 'Control', 'ControlLeft', true),
        key('keydown', 'z', 'KeyZ', true),
        ...(observeKeyUp
          ? [key('keyup', 'z', 'KeyZ', true), key('keyup', 'Control', 'ControlLeft')]
          : []),
      ]);
    if (operation.startsWith('schematic-edit'))
      for (let loop = 0; loop < 5; loop++) {
        add(
          {
            method: 'click',
            targetTestId: 'symbol-hit-R1',
            point: { x: 651.128392, y: 428.666679 },
          },
          [
            pointer('pointermove', 651.12, 428.66, 0),
            pointer('pointerdown', 651.12, 428.66, 1, 0),
            pointer('pointerup', 651.12, 428.66, 0, 0),
          ],
        );
        add({ method: 'press', key: 'ArrowRight' }, [
          key('keydown', 'ArrowRight', 'ArrowRight'),
          ...(observeKeyUp ? [key('keyup', 'ArrowRight', 'ArrowRight')] : []),
        ]);
        undo();
      }
    else
      for (let loop = 0; loop < 3; loop++) {
        const x = 50 + loop * 10,
          y = 100 + loop * 10;
        if (paced)
          gesture = {
            round: loop,
            bounds: { x: x - 4, y: y - 3, width: 8, height: 6 },
            ctmA: 1,
            distance: 8,
            begin: { x, y },
            end: { x: x + 8, y },
          };
        add({ method: 'move', x, y, steps: 1 }, [pointer('pointermove', x, y, 0)]);
        add({ method: 'down', button: 'left' }, [pointer('pointerdown', x, y, 1, 0)]);
        if (paced)
          for (const head of [0.8, 1.6, 2.4, 3.2, 4, 4.8, 5.6, 6.4, 7.2, 8])
            add({ method: 'move', x: x + head, y, steps: 1 }, [
              pointer('pointermove', x + head, y, 1),
            ]);
        else
          add(
            { method: 'move', x: x + 20, y, steps: 10 },
            Array.from({ length: 10 }, (_, index) =>
              pointer('pointermove', x + 2 * (index + 1), y, 1),
            ),
          );
        add({ method: 'up', button: 'left' }, [
          pointer('pointerup', x + (paced ? 8 : 20), y, 0, 0),
        ]);
        undo();
      }
    return value;
  };
  const schematicMeasure = (value) =>
    (value.operation.endsWith('-paced') ? schematicPacedActionSummary : schematicActionSummary)(
      value.operation,
      value.actions,
      value.events,
      value.arm,
      value.result,
      value.observeKeyUp,
    );
  for (const operation of [
    'schematic-edit',
    'schematic-drag',
    'schematic-edit-paced',
    'schematic-drag-paced',
  ])
    for (const observeKeyUp of [false, true])
      for (const offset of [1_000, -1_000])
        check(
          `schematic full ordered ${operation}, keyup ${observeKeyUp}, offset ${offset}`,
          () => {
            const value = schematicFixture(operation, observeKeyUp, offset);
            const before = structuredClone(value);
            const measured = schematicMeasure(value);
            assert.equal(measured.valid, true);
            assert.equal(measured.withinTarget, true);
            assert.equal(
              measured.originalActionCount,
              operation === 'schematic-drag-paced' ? 42 : 15,
            );
            assert.equal(
              measured.samples.length,
              operation.startsWith('schematic-edit')
                ? observeKeyUp
                  ? 45
                  : 30
                : observeKeyUp
                  ? 51
                  : 45,
            );
            assert.deepEqual(
              value,
              before,
              'Matching and calibration must retain every raw action/event',
            );
          },
        );
  check(
    'schematic ten-step samples share their real original API invocation and exact linear heads',
    () => {
      const value = schematicFixture('schematic-drag');
      const measured = schematicMeasure(value);
      const steps = measured.samples.filter((sample) => sample.invocation.actionIndex === 2);
      assert.equal(steps.length, 10);
      assert.deepEqual(
        steps.map((sample) => sample.invocation.x),
        [52, 54, 56, 58, 60, 62, 64, 66, 68, 70],
      );
      assert.ok(
        steps.every(
          (sample) => sample.invocation.nodeInvokedAtMs === value.actions[2].nodeInvokedAtMs,
        ),
      );
      assert.equal(steps[0].actionInvokeToPresentation.estimateMs, 60);
      assert.equal(steps[9].actionInvokeToPresentation.estimateMs, 69);
    },
  );
  check(
    'schematic locator click retains raw centroid and explicit Playwright coordinate normalization',
    () => {
      const measured = schematicMeasure(schematicFixture());
      assert.equal(measured.samples[0].invocation.x, 651.128392);
      assert.deepEqual(measured.samples[0].normalizedExpectedCoordinates, {
        model: 'playwright-locator-click-truncate-0.01px',
        clientX: 651.12,
        clientY: 428.66,
      });
      assert.equal(measured.coordinateTolerancePx, 1e-3);
    },
  );
  const schematicMutations = [
    ['missing event', (value) => value.events.pop()],
    ['extra event', (value) => value.events.push({ ...value.events.at(-1) })],
    ['reordered events', (value) => value.events.reverse()],
    ['duplicate event sequence', (value) => (value.events[1].eventSequence = 0)],
    ['missing original action', (value) => value.actions.pop()],
    ['wrong action index', (value) => (value.actions[1].actionIndex = 0)],
    ['wrong action sequence', (value) => (value.actions[1].key = 'ArrowLeft')],
    ['wrong key', (value) => (value.events[3].key = 'ArrowLeft')],
    ['wrong key code', (value) => (value.events[3].code = 'ArrowLeft')],
    ['missing modifier', (value) => delete value.events[3].ctrlKey],
    ['wrong undo modifier', (value) => (value.events[5].ctrlKey = false)],
    ['unexpected modifier', (value) => (value.events[0].altKey = true)],
    ['repeated key', (value) => (value.events[3].repeat = true)],
    ['composing key', (value) => (value.events[3].isComposing = true)],
    ['wrong click pixel', (value) => (value.events[0].clientX += 1)],
    [
      'untruncated click coordinate',
      (value) => (value.events[0].clientX = value.actions[0].point.x),
    ],
    ['wrong buttons', (value) => (value.events[1].buttons = 0)],
    ['nonfinite pointer', (value) => (value.events[0].clientY = NaN)],
    ['nonfinite original invocation', (value) => (value.actions[0].nodeInvokedAtMs = Infinity)],
    ['unfinished second frame', (value) => delete value.events[0].presentedAtMs],
    ['missing original event duration', (value) => delete value.events[0].fromEventMs],
    ['different renderer origin', (value) => (value.result.timeOriginMs += 1)],
    [
      'empty clock intersection',
      (value) =>
        (value.result = clockBracket(2_000, 2_004, clock(1_020, { sampleId: value.operation }))),
    ],
    ['wrong renderer sample ID', (value) => (value.events[0].sampleId = 'another-group')],
    ['keyup capture mismatch', (value) => (value.observeKeyUp = true)],
  ];
  for (const [name, mutate] of schematicMutations)
    check(`schematic rejects ${name}`, () => {
      const value = schematicFixture();
      mutate(value);
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
      assert.ok(
        measured.reasons.length ||
          measured.samples.some(
            (sample) => sample.pairingErrors.length || !sample.actionInvokeToPresentation?.valid,
          ),
      );
    });
  for (const [name, mutate] of [
    ['wrong intermediate head', (value) => (value.events[4].clientX += 1)],
    ['wrong step count', (value) => (value.actions[2].steps = 9)],
    [
      'reordered original invocation',
      (value) => (value.actions[2].nodeInvokedAtMs = value.actions[1].nodeInvokedAtMs - 1),
    ],
  ])
    check(`schematic drag rejects ${name}`, () => {
      const value = schematicFixture('schematic-drag');
      mutate(value);
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  for (const [deltaMs, fromEventMs, withinTarget] of [
    [93, null, true],
    [94, null, false],
    [96, null, false],
    [93, 100, false],
  ])
    check(`schematic strict original/action boundary ${deltaMs}/${fromEventMs}`, () => {
      const value = schematicFixture();
      const reference = schematicMeasure(value);
      value.events.forEach((event, index) => {
        event.presentedAtMs = reference.samples[index].invocation.nodeInvokedAtMs - 1_000 + deltaMs;
        event.fromEventMs = event.presentedAtMs - event.eventTimeStampMs;
      });
      if (fromEventMs !== null) value.events[0].fromEventMs = fromEventMs;
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, true);
      assert.equal(measured.withinTarget, withinTarget);
      assert.equal(measured.samples[0].actionInvokeToPresentation.upperMs, deltaMs + 6);
    });
  check(
    'paced drag has ten separate exact-head API timestamps instead of one cumulative gesture',
    () => {
      const value = schematicFixture('schematic-drag-paced');
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, true);
      assert.equal(measured.protocol, 'paced-single-api-inputs');
      assert.equal(measured.expectedActionCount, 42);
      const heads = measured.samples.slice(2, 12);
      assert.equal(new Set(heads.map((sample) => sample.invocation.nodeInvokedAtMs)).size, 10);
      assert.deepEqual(
        heads.map((sample) => sample.invocation.x),
        [50.8, 51.6, 52.4, 53.2, 54, 54.8, 55.6, 56.4, 57.2, 58],
      );
      assert.ok(
        heads.every(
          (sample) =>
            sample.invocation.actionEventCount === 1 &&
            sample.actionInvokeToPresentation.estimateMs === 60,
        ),
      );
      assert.deepEqual(measured.actions[0].gesture, value.actions[0].gesture);
    },
  );
  const pacedMutations = [
    [
      'sent and observed shortened heads cannot become their own oracle',
      (value) => {
        for (let index = 2; index <= 11; index++) {
          value.actions[index].x = 50 + (value.actions[index].x - 50) * 0.8;
          value.events[index].clientX = value.actions[index].x;
        }
      },
    ],
    [
      'swapped sent and observed intermediate heads',
      (value) => {
        [value.actions[5].x, value.actions[6].x] = [value.actions[6].x, value.actions[5].x];
        [value.events[5].clientX, value.events[6].clientX] = [
          value.events[6].clientX,
          value.events[5].clientX,
        ];
      },
    ],
    [
      'repeated final head',
      (value) => {
        value.actions[6].x = 58;
        value.events[6].clientX = 58;
      },
    ],
    ['false recorded end', (value) => (value.actions[0].gesture.end.x += 1)],
    ['false distance for the original scale', (value) => (value.actions[0].gesture.distance = 7)],
    [
      'different per-action geometry',
      (value) => (value.actions[5].gesture = { ...value.actions[5].gesture, round: 1 }),
    ],
    ['missing original geometry', (value) => delete value.actions[0].gesture],
    ['legacy multi-step API in the paced sequence', (value) => (value.actions[2].steps = 10)],
    [
      'head assigned its preceding API timestamp',
      (value) => (value.actions[3].nodeInvokedAtMs = value.actions[2].nodeInvokedAtMs),
    ],
    ['missing event', (value) => value.events.pop()],
    ['extra event', (value) => value.events.push({ ...value.events.at(-1) })],
    ['incomplete final frame', (value) => delete value.events.at(-1).presentedAtMs],
  ];
  for (const [name, mutate] of pacedMutations)
    check(`paced drag rejects ${name}`, () => {
      const value = schematicFixture('schematic-drag-paced');
      mutate(value);
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, false);
      assert.equal(measured.withinTarget, false);
    });
  for (const deltaMs of [93, 94, 96])
    check(`paced action strict upper-bound boundary ${deltaMs}`, () => {
      const value = schematicFixture('schematic-drag-paced');
      const reference = schematicMeasure(value);
      value.events.forEach((event, index) => {
        event.presentedAtMs = reference.samples[index].invocation.nodeInvokedAtMs - 1_000 + deltaMs;
        event.fromEventMs = event.presentedAtMs - event.eventTimeStampMs;
      });
      const measured = schematicMeasure(value);
      assert.equal(measured.valid, true);
      assert.equal(measured.samples[0].actionInvokeToPresentation.upperMs, deltaMs + 6);
      assert.equal(measured.withinTarget, deltaMs === 93);
    });
  check('configurable target retains 100 ms default and accepts 50 ms', () => {
    assert.equal(experienceTargetMs(), 100);
    assert.equal(experienceTargetMs('50'), 50);
    for (const value of ['', ' ', 'NaN', 'Infinity', '0', '-1'])
      assert.throws(() => experienceTargetMs(value), /positive finite/);
  });
  for (const [duration, withinTarget] of [
    [43, true],
    [44, false],
    [45, false],
  ])
    check(`navigation strict configurable 50 ms boundary ${duration + 6}`, () => {
      const value = navigationFixture();
      value.events.forEach((event, index) => {
        event.presentedAtMs = value.invocations[index].nodeInvokedAtMs - 1_000 + duration;
        event.fromEventMs = duration - 9.5;
      });
      const measured = navigationActionSummary(
        sampleId,
        value.invocations,
        value.events,
        value.arm,
        value.result,
        3,
        50,
      );
      assert.equal(measured.valid, true);
      assert.equal(measured.targetMs, 50);
      assert.equal(measured.samples[0].actionInvokeToPresentation.upperMs, duration + 6);
      assert.equal(measured.withinTarget, withinTarget);
    });
  check('configurable target independently rejects original event at 50 ms', () => {
    const value = navigationFixture();
    value.events.forEach((event, index) => {
      event.presentedAtMs = value.invocations[index].nodeInvokedAtMs - 1_000 + 30;
      event.fromEventMs = 50;
    });
    assert.equal(
      navigationActionSummary(
        sampleId,
        value.invocations,
        value.events,
        value.arm,
        value.result,
        3,
        50,
      ).withinTarget,
      false,
    );
  });
  const layoutFixture = (phase) => {
    const id = `layout-track-paced-${phase}`;
    const plan = phase.endsWith('pickup')
      ? [
          { method: 'key-down', key: 'd' },
          { method: 'key-up', key: 'd' },
        ]
      : phase.endsWith('commit')
        ? [
            { method: 'key-down', key: 'Enter' },
            { method: 'key-up', key: 'Enter' },
          ]
        : [
            ...(phase === 'pointer' ? [{ method: 'down', x: 20, y: 30 }] : []),
            ...Array.from({ length: 7 }, (_, index) => ({
              method: 'move',
              x: 20,
              y: index % 2 ? 29 : 31,
              steps: 1,
            })),
            ...(phase === 'pointer' ? [{ method: 'up', x: 20, y: 31 }] : []),
          ];
    const value = {
      id,
      arm: clockBracket(1_000, 1_004, { ...clock(2), sampleId: id }),
      result: clockBracket(1_400 + plan.length * 300, 1_404 + plan.length * 300, {
        ...clock(402 + plan.length * 300),
        sampleId: id,
      }),
      actions: [],
      events: [],
    };
    for (const [index, action] of plan.entries()) {
      const nodeInvokedAtMs = 1_100 + index * 300;
      const keyboard = action.method.startsWith('key-');
      const api = keyboard ? (action.method === 'key-down' ? 'down' : 'up') : action.method;
      value.actions.push({
        ...action,
        transport: `playwright.${keyboard ? 'keyboard' : 'mouse'}.${api}`,
        actionIndex: index,
        sampleId: id,
        nodeInvokedAtMs,
      });
      value.events.push({
        sampleId: id,
        eventSequence: value.events.length,
        type: keyboard
          ? action.method === 'key-down'
            ? 'keydown'
            : 'keyup'
          : { move: 'pointermove', down: 'pointerdown', up: 'pointerup' }[action.method],
        inputObservedAtMs: nodeInvokedAtMs - 990,
        eventTimeStampMs: nodeInvokedAtMs - 990.5,
        presentedAtMs: nodeInvokedAtMs - 970,
        fromEventMs: 20.5,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...(keyboard
          ? {
              key: action.key,
              code: action.key === 'd' ? 'KeyD' : 'Enter',
              repeat: false,
              isComposing: false,
            }
          : {
              clientX: action.x,
              clientY: action.y,
              buttons: phase === 'pointer' && action.method !== 'up' ? 1 : 0,
              button: action.method === 'move' ? -1 : 0,
            }),
      });
    }
    return value;
  };
  const layoutMeasure = (value) =>
    layoutTrackActionSummary(value.id, value.actions, value.events, value.arm, value.result, 50);
  for (const phase of [
    'pickup',
    'preview',
    'commit',
    'pointer',
    'obstacle-pickup',
    'obstacle-preview',
    'obstacle-commit',
  ])
    check(`paced Layout ${phase} accepts paired single inputs`, () => {
      const result = layoutMeasure(layoutFixture(phase));
      assert.equal(result.valid, true);
      assert.equal(result.withinTarget, true);
      assert.equal(result.targetMs, 50);
      assert.equal(result.protocol, 'paced-single-api-inputs-v2');
      assert.equal(result.expectedActionCount, result.expectedCount);
      assert.equal(result.originalActionCount, result.rendererEventCount);
    });
  for (const [phase, expectedCount] of [
    ['pickup', 2],
    ['preview', 7],
    ['commit', 2],
    ['pointer', 9],
    ['obstacle-pickup', 2],
    ['obstacle-preview', 7],
    ['obstacle-commit', 2],
  ])
    check(`paced Layout ${phase} retains fixed expected count after a missing input`, () => {
      const value = layoutFixture(phase);
      value.actions.pop();
      const result = layoutMeasure(value);
      assert.equal(result.expectedCount, expectedCount);
      assert.equal(result.valid, false);
      assert.equal(result.withinTarget, false);
    });
  for (const [name, mutate] of [
    ['missing keyup', (value) => value.events.pop()],
    ['wrong keyup', (value) => (value.events[1].key = 'Escape')],
    ['wrong key code', (value) => (value.events[0].code = 'KeyG')],
    ['repeat keydown', (value) => (value.events[0].repeat = true)],
    ['modified keyup', (value) => (value.events[1].shiftKey = true)],
    [
      'shared down/up invocation',
      (value) => (value.actions[1].nodeInvokedAtMs = value.actions[0].nodeInvokedAtMs),
    ],
    [
      'reordered key invocation',
      (value) => (value.actions[1].nodeInvokedAtMs = value.actions[0].nodeInvokedAtMs - 1),
    ],
    [
      'whole press invocation',
      (value) => {
        value.actions[0].method = 'press';
        value.actions[0].transport = 'playwright.keyboard.press';
      },
    ],
    [
      'keyboard parsed as pointer',
      (value) => {
        value.actions[0].method = 'down';
        value.actions[0].transport = 'playwright.mouse.down';
      },
    ],
    ['wrong keyboard transport', (value) => (value.actions[1].transport = 'playwright.mouse.up')],
    [
      'debug key contamination',
      (value) => value.events.push({ ...value.events[0], key: 'Escape', eventSequence: 2 }),
    ],
  ])
    check(`paced Layout pickup rejects ${name}`, () => {
      const value = layoutFixture('pickup');
      mutate(value);
      const result = layoutMeasure(value);
      assert.equal(result.valid, false);
      assert.equal(result.withinTarget, false);
    });
  check('paced Layout v2 uses 31 independent invocations for all 31 track events', () => {
    const results = [
      'pickup',
      'preview',
      'commit',
      'pointer',
      'obstacle-pickup',
      'obstacle-preview',
      'obstacle-commit',
    ].map((phase) => layoutMeasure(layoutFixture(phase)));
    assert.equal(
      results.reduce((sum, result) => sum + result.expectedActionCount, 0),
      31,
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.expectedCount, 0),
      31,
    );
    assert.ok(results.every((result) => result.valid && result.withinTarget));
  });
  check('paced Layout slow mutating keydown cannot move the independent keyup start', () => {
    const value = layoutFixture('pickup');
    const original = layoutMeasure(value);
    value.events[0].presentedAtMs += 40;
    value.events[0].fromEventMs += 40;
    const result = layoutMeasure(value);
    assert.equal(result.valid, true);
    assert.equal(result.samples[0].withinTarget, false);
    assert.ok(result.samples[0].actionInvokeToPresentation.upperMs > 50);
    assert.equal(result.samples[1].invocation.nodeInvokedAtMs, value.actions[1].nodeInvokedAtMs);
    assert.equal(
      result.samples[1].actionInvokeToPresentation.nodeInvokedAtMs,
      value.actions[1].nodeInvokedAtMs,
    );
    assert.equal(
      result.samples[1].actionInvokeToPresentation.upperMs,
      original.samples[1].actionInvokeToPresentation.upperMs,
    );
    assert.equal(result.samples[1].withinTarget, true);
    assert.equal(result.withinTarget, false);
  });
  check('paced Layout keydown original event at exactly 50 ms still fails', () => {
    const value = layoutFixture('commit');
    value.events[0].fromEventMs = 50;
    const result = layoutMeasure(value);
    assert.equal(result.valid, true);
    assert.equal(result.samples[0].withinTarget, false);
    assert.equal(result.samples[1].withinTarget, true);
    assert.equal(result.withinTarget, false);
  });
  const layoutMutations = [
    ['missing input', (value) => value.actions.pop()],
    ['missing event', (value) => value.events.pop()],
    ['extra event', (value) => value.events.push({ ...value.events.at(-1) })],
    ['multi-step gesture', (value) => (value.actions[0].steps = 8)],
    [
      'same resolved head',
      (value) => {
        value.actions[1].y = value.actions[0].y;
        value.events[1].clientY = value.events[0].clientY;
      },
    ],
    ['wrong coordinates', (value) => (value.events[1].clientX += 1)],
    ['wrong sample', (value) => (value.events[1].sampleId = 'other')],
    ['reordered event', (value) => (value.events[1].eventSequence = 0)],
    ['modified input', (value) => (value.events[1].ctrlKey = true)],
    ['incomplete presentation', (value) => delete value.events[1].presentedAtMs],
  ];
  for (const [name, mutate] of layoutMutations)
    check(`paced Layout rejects ${name}`, () => {
      const value = layoutFixture('preview');
      mutate(value);
      const result = layoutMeasure(value);
      assert.equal(result.valid, false);
      assert.equal(result.withinTarget, false);
    });
  for (const duration of [43, 44])
    check(`paced Layout strict 50 ms bound ${duration + 6}`, () => {
      const value = layoutFixture('preview');
      value.events.forEach((event, index) => {
        event.presentedAtMs = value.actions[index].nodeInvokedAtMs - 1_000 + duration;
        event.fromEventMs = duration - 9.5;
      });
      const result = layoutMeasure(value);
      assert.equal(result.valid, true);
      assert.equal(result.withinTarget, duration === 43);
    });
  console.log(`Editor experience clock self-test passed (${count} cases).`);
}
