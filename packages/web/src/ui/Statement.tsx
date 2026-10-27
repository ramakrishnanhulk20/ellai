const LINES = [
  'Let your AI agent pay for things.',
  'Ellai learns when to ask you.',
  'Every answer is a memory on Walrus.',
];

/** The three-line pitch. Each word rises in, one after another, when the page loads. */
export function Statement({ className }: { className: string }) {
  let wordIndex = 0;
  return (
    <p className={className}>
      {LINES.map((line) => (
        <span key={line} className="block">
          {line.split(' ').map((word, position, words) => {
            const index = wordIndex;
            wordIndex += 1;
            return (
              <span key={index}>
                <span className="enter-rise inline-block" style={{ animationDelay: `${index * 60}ms` }}>
                  {word}
                </span>
                {position < words.length - 1 ? ' ' : null}
              </span>
            );
          })}
        </span>
      ))}
    </p>
  );
}
