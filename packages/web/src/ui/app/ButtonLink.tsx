import Link from 'next/link';
import type { ReactNode } from 'react';
import { BUTTON_BASE, LINK_VARIANT } from './button-styles.js';

/** A link that looks like a button, for moving between pages. 40px by default, 48px for the main action. */
export function ButtonLink({
  href,
  variant = 'ghost',
  size = 'md',
  className = '',
  children,
}: {
  href: string;
  variant?: 'primary' | 'ghost' | 'text';
  size?: 'md' | 'lg';
  className?: string;
  children: ReactNode;
}) {
  const height = variant === 'text' ? '' : size === 'lg' ? 'h-12' : 'h-10';
  return (
    <Link href={href} className={`${BUTTON_BASE} ${LINK_VARIANT[variant]} ${height} ${className}`}>
      {children}
    </Link>
  );
}
