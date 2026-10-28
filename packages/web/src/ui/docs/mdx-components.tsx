import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Mermaid } from './Mermaid.js';

export function getMdxComponents(): MDXComponents {
  return { ...defaultMdxComponents, Mermaid };
}
