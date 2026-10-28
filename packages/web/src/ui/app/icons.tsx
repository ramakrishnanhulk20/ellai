import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const OverviewIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Icon>
);

export const QuestionsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    <path d="M6.5 6.2a1.5 1.5 0 1 1 2.2 1.3c-.5.3-.7.6-.7 1" />
  </Icon>
);

export const HistoryIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.75V8l2.25 1.5" />
  </Icon>
);

export const MemoriesIcon = (props: IconProps) => (
  <Icon {...props}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
    <path d="M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5l3.25 3L13 4.5" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
    <path d="M13.25 2.5v2.75H10.5" />
  </Icon>
);

export const AgentsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="5.25" r="2.5" />
    <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
  </Icon>
);

export const RunIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.75 3v10l8-5z" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 4.5H8M13.5 4.5H12M2.5 11.5H4M13.5 11.5H8.5" />
    <circle cx="10" cy="4.5" r="1.75" />
    <circle cx="6.25" cy="11.5" r="1.75" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 6l4.5 4.5L12.5 6" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.25 8h9.5" />
  </Icon>
);
