const PLUS = 'absolute top-1/2 -translate-y-1/2 font-mono text-[14px] leading-none text-faint';

/** The row of plus marks under the panel. The label stands where the middle mark would be. */
export function MarkerRow() {
  return (
    <div
      aria-hidden="true"
      className="enter-fade relative mx-4 h-14 md:mx-8"
      style={{ animationDelay: '1200ms' }}
    >
      <span className={`${PLUS} left-0`}>+</span>
      <span className={`${PLUS} left-1/4 hidden -translate-x-1/2 md:block`}>+</span>
      <span className={`${PLUS} left-3/4 hidden -translate-x-1/2 md:block`}>+</span>
      <span className={`${PLUS} right-0`}>+</span>
      <span className="label-mono absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-muted">
        SCROLL TO SEE IT LEARN
      </span>
    </div>
  );
}
