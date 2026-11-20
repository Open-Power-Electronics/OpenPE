type ContextPointer<T> = {
  id: number;
  button: number;
  x: number;
  y: number;
  identity: unknown;
  target: T;
};

/** Camera drags keep ownership even when they return to the original position. */
export function createCanvasContextGesture<T>() {
  let press: (ContextPointer<T> & { moved: boolean }) | null = null;
  return {
    start(pointer: ContextPointer<T>) {
      press = pointer.button === 2 ? { ...pointer, moved: false } : null;
    },
    move(id: number, x: number, y: number) {
      if (press?.id === id && Math.hypot(x - press.x, y - press.y) > 3) press.moved = true;
    },
    finish(pointer: ContextPointer<T>): ContextPointer<T> | null {
      const click = press;
      press = null;
      return click &&
        pointer.button === 2 &&
        click.id === pointer.id &&
        click.identity === pointer.identity &&
        !click.moved &&
        Math.hypot(pointer.x - click.x, pointer.y - click.y) <= 3
        ? { ...pointer, target: click.target }
        : null;
    },
    cancel() {
      press = null;
    },
  };
}
