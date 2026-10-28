import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins/remark-mdx-mermaid';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({ dir: 'content/docs' });

export default defineConfig({
  mdxOptions: {
    // Turns every mermaid code block into a <Mermaid chart="..." /> element that the page draws on the client.
    remarkPlugins: [remarkMdxMermaid],
    // The docs are dark only, so both theme slots get the same dark colours and no theme class is needed on the page.
    rehypeCodeOptions: { themes: { light: 'github-dark', dark: 'github-dark' } },
  },
});
