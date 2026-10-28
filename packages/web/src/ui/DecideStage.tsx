'use client';

import { motion } from 'motion/react';
import { badgeFor } from './DecisionCard.js';
import {
  BAR,
  CARD,
  checkRows,
  CITE_ANGLES,
  distanceLabel,
  innerPoint,
  layerOpacity,
  cardOpacity,
  NEW_DOT_ANGLE,
  percent,
  ringPath,
  ROWS,
  STAGE,
  type Example,
} from './decide-model.js';
import { RISE_EASE } from './motion-tokens.js';

type StageState = {
  /** The active step, 0 to 4. Additions from earlier steps stay, dimmed. */
  step: number;
  example: Example | null;
  /** True once the stage is on screen, so entrance animations are not spent off screen. */
  live: boolean;
  /** Skips every slide, draw and pulse and shows each step's end state. */
  still: boolean;
};

const CARD_SHELL = 'rounded-card border border-line bg-[rgba(8,9,10,0.72)] p-3 backdrop-blur-[12px]';
// On the wide stage the words shrink a little, never below 12 and 9 pixels, when the column is narrower than the
// full-size layout, so labels and the card do not run into each other. At full size they are exactly 16 and 12.
const FLUID_BODY = 'text-[length:clamp(12px,2.8cqw,16px)]';
const FLUID_MONO = 'text-[length:clamp(9px,2.1cqw,12px)]';
const FLUID_LABELS = '[&_.label-mono]:text-[length:clamp(9px,2.1cqw,12px)]';
const ROW_HEIGHT = 'clamp(20px, 4.5cqw, 28px)';
const DOT_BOX = { transformBox: 'fill-box', transformOrigin: 'center' } as const;

function useStepGate({ step, live }: Pick<StageState, 'step' | 'live'>) {
  return (addedAt: number) => live && step >= addedAt;
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 stroke-accent">
      <path d="M3 8.5 6.5 12 13 4.5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CardBody({
  example,
  showOutcome,
  fluid = false,
}: {
  example: Example | null;
  /** True from step 5, when the card gets its badge. The badge says what the picked decision really was. */
  showOutcome: boolean;
  fluid?: boolean;
}) {
  const badge = example ? badgeFor(example.decision) : null;
  return (
    <>
      <p className="label-mono text-muted">402 PAYMENT REQUIRED</p>
      {example ? (
        <p className={`mt-1 ${fluid ? FLUID_BODY : 'text-[16px]'} leading-[1.25] text-fg [overflow-wrap:anywhere]`}>
          {example.amount} USDC to {example.host}
        </p>
      ) : null}
      {showOutcome && badge ? (
        <>
          <p className={`label-mono mt-3 inline-flex min-h-6 max-w-full items-center rounded-button border px-2 ${badge.tone}`}>
            {badge.label}
          </p>
          {example?.digest ? (
            <p className="mt-3">
              <a
                href={`https://suiscan.xyz/mainnet/tx/${encodeURIComponent(example.digest)}`}
                target="_blank"
                rel="noopener"
                className="label-mono link-draw text-fg"
              >
                SEE IT ON SUI
              </a>
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function CheckRows({ example }: { example: Example | null }) {
  return (
    <>
      {checkRows(example).map((row) => (
        <div key={row} className="flex h-7 items-center gap-2 text-[16px] leading-none text-fg">
          <Check />
          <span>{row}</span>
        </div>
      ))}
    </>
  );
}

/** The drawing: ring, memory dots, lines, purse bar and the new memory. Text lives in its own layer. */
export function StageGraphics({
  step,
  example,
  live,
  still,
  requestPoint,
}: StageState & { requestPoint: boolean }) {
  const on = useStepGate({ step, live });
  const dots = (example?.distances ?? []).map((_, index) => innerPoint(CITE_ANGLES[index] ?? 0));
  const newDot = innerPoint(NEW_DOT_ANGLE);
  const purseX = BAR.x + BAR.purseWidth / 2;
  const purseY = BAR.y + BAR.height / 2;
  const fade = still ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' as const };

  return (
    <svg
      viewBox={`0 0 ${STAGE} ${STAGE}`}
      fill="none"
      aria-hidden="true"
      className="absolute inset-0 size-full overflow-visible"
    >
      <path
        d={ringPath()}
        stroke="var(--accent)"
        strokeOpacity={0.5}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />

      {requestPoint ? (
        <motion.circle
          cy={CARD.cy}
          r={8}
          fill="var(--fg)"
          initial={still ? false : { cx: STAGE + 40, opacity: 0 }}
          animate={live ? { cx: CARD.x, opacity: cardOpacity(step) } : { cx: STAGE + 40, opacity: 0 }}
          transition={still ? { duration: 0 } : { cx: { duration: 0.5, ease: RISE_EASE }, opacity: fade }}
        />
      ) : null}

      <motion.g
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: on(1) ? layerOpacity(step, 1) : 0 }}
        transition={fade}
      >
        {dots.map((point, index) => (
          <g key={index}>
            <motion.line
              x1={CARD.x}
              y1={CARD.cy}
              stroke="var(--fg)"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
              initial={still ? false : { x2: CARD.x, y2: CARD.cy }}
              animate={on(1) ? { x2: point.x, y2: point.y } : { x2: CARD.x, y2: CARD.cy }}
              transition={still ? { duration: 0 } : { duration: 0.6, ease: 'easeOut' }}
            />
            <motion.circle
              cx={point.x}
              cy={point.y}
              r={5}
              fill="var(--accent)"
              style={DOT_BOX}
              initial={still ? false : { scale: 0.6, opacity: 0 }}
              animate={on(1) ? { scale: 1, opacity: 1 } : { scale: 0.6, opacity: 0 }}
              transition={fade}
            />
          </g>
        ))}
      </motion.g>

      <motion.g
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: on(3) ? layerOpacity(step, 3) : 0 }}
        transition={fade}
      >
        <rect x={BAR.x} y={BAR.y} width={BAR.width} height={BAR.height} rx={4} fill="var(--line)" />
        <rect x={BAR.x} y={BAR.y} width={BAR.purseWidth} height={BAR.height} rx={4} fill="var(--accent)" />
        <motion.circle
          r={4}
          fill="var(--accent)"
          initial={still ? false : { cx: purseX, cy: purseY }}
          animate={on(3) ? { cx: CARD.x, cy: CARD.cy } : { cx: purseX, cy: purseY }}
          transition={still ? { duration: 0 } : { duration: 0.5, delay: 0.3, ease: 'easeIn' }}
        />
      </motion.g>

      <g>
        <motion.circle
          cx={newDot.x}
          cy={newDot.y}
          r={5}
          fill="var(--accent)"
          style={DOT_BOX}
          initial={still ? false : { scale: 0.6, opacity: 0 }}
          animate={on(4) ? { scale: 1, opacity: 1 } : { scale: 0.6, opacity: 0 }}
          transition={fade}
        />
        <motion.circle
          cx={newDot.x}
          cy={newDot.y}
          r={5}
          stroke="var(--accent)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={DOT_BOX}
          initial={{ scale: 1, opacity: 0 }}
          animate={on(4) && !still ? { scale: [1, 2.2], opacity: [1, 0] } : { scale: 1, opacity: 0 }}
          transition={{ duration: still ? 0 : 0.9, delay: still ? 0 : 0.3, ease: 'easeOut' }}
        />
      </g>
    </svg>
  );
}

/** The words over the drawing, at real size, placed by the stage's own coordinates. Wide screens only. */
export function StageText({ step, example, live, still }: StageState) {
  const on = useStepGate({ step, live });
  const fade = still ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' as const };
  const dots = (example?.distances ?? []).map((distance, index) => ({
    label: distanceLabel(distance),
    point: innerPoint(CITE_ANGLES[index] ?? 0),
    below: index === 2,
  }));
  const rowCount = checkRows(example).length;

  return (
    <div className={`pointer-events-none absolute inset-0 ${FLUID_LABELS}`}>
      <motion.div
        className={`absolute -translate-y-1/2 ${CARD_SHELL} ${step === 4 ? 'pointer-events-auto' : ''}`}
        style={{ left: percent(CARD.x), top: percent(CARD.cy), width: percent(CARD.width) }}
        initial={still ? false : { x: '115%', opacity: 0 }}
        animate={live ? { x: 0, opacity: cardOpacity(step) } : { x: '115%', opacity: 0 }}
        transition={still ? { duration: 0 } : { x: { duration: 0.5, ease: RISE_EASE }, opacity: fade }}
      >
        <CardBody example={example} showOutcome={step >= 4} fluid />
      </motion.div>

      {dots.map(({ label, point, below }, index) =>
        label ? (
          <motion.p
            key={index}
            className={`absolute -translate-x-1/2 whitespace-nowrap font-mono ${FLUID_MONO} leading-normal text-muted`}
            style={{
              left: percent(point.x),
              top: `calc(${percent(point.y)} ${below ? '+ 10px' : '- 28px'})`,
            }}
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: on(1) ? layerOpacity(step, 1) : 0 }}
            transition={fade}
          >
            {label}
          </motion.p>
        ) : null,
      )}

      <motion.div
        className="absolute"
        style={{ left: percent(ROWS.x), top: percent(ROWS.y), width: percent(ROWS.width) }}
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: on(2) ? layerOpacity(step, 2) : 0 }}
        transition={fade}
      >
        {checkRows(example).map((row, index) => (
          <motion.div
            key={row}
            className={`flex items-center gap-2 ${FLUID_BODY} leading-none text-fg`}
            style={{ height: ROW_HEIGHT }}
            initial={still ? false : { opacity: 0, y: 8 }}
            animate={on(2) ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={
              still
                ? { duration: 0 }
                : { duration: 0.3, ease: 'easeOut', delay: on(2) ? index * 0.12 : (rowCount - 1 - index) * 0.04 }
            }
          >
            <Check />
            <span>{row}</span>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: on(3) ? layerOpacity(step, 3) : 0 }}
        transition={fade}
      >
        <p className="label-mono absolute text-muted" style={{ left: percent(BAR.x), top: percent(BAR.labelY) }}>
          YOUR ALLOWANCE
        </p>
        <p className="label-mono absolute text-muted" style={{ left: percent(BAR.x), top: percent(BAR.purseLabelY) }}>
          PURSE
        </p>
      </motion.div>
    </div>
  );
}

/** The wide-screen stage: a square that scales to fit its column, drawing under the words. */
export function Stage(props: StageState) {
  return (
    <div className="@container relative aspect-square w-[min(100%,70svh)]">
      <StageGraphics {...props} requestPoint={false} />
      <StageText {...props} />
    </div>
  );
}

/**
 * The small-screen stage: the same drawing at 320 by 320, and under it the words that belong to
 * this step at real size. At that width the words cannot sit on the drawing without covering it.
 */
export function MobileStage({ step, example, live, still }: StageState) {
  const labels = (example?.distances ?? []).flatMap((distance) => {
    const label = distanceLabel(distance);
    return label ? [label] : [];
  });
  return (
    <div>
      <div className="relative mx-auto size-[320px]">
        <StageGraphics step={step} example={example} live={live} still={still} requestPoint />
      </div>
      <div className="mt-4 max-w-[320px]">
        {step === 0 || step === 4 ? (
          <div className={CARD_SHELL}>
            <CardBody example={example} showOutcome={step === 4} />
          </div>
        ) : null}
        {step === 1 && labels.length > 0 ? (
          <ul className="space-y-2">
            {labels.map((label) => (
              <li key={label} className="flex items-center gap-3 font-mono text-[12px] leading-normal text-muted">
                <span aria-hidden="true" className="size-[10px] shrink-0 rounded-full bg-accent" />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        {step === 2 ? <CheckRows example={example} /> : null}
        {step === 3 ? (
          <ul className="space-y-2">
            <li className="label-mono flex items-center gap-3 text-muted">
              <span aria-hidden="true" className="h-2 w-[10px] shrink-0 rounded-[4px] bg-line" />
              YOUR ALLOWANCE
            </li>
            <li className="label-mono flex items-center gap-3 text-muted">
              <span aria-hidden="true" className="h-2 w-[10px] shrink-0 rounded-[4px] bg-accent" />
              PURSE
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}
