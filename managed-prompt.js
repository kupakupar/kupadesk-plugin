const START = '<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->';
const END = '<!-- KUPADESK-NATIVE-PAGE-TEST:END -->';
const FOOTER = /\n<!-- KUPADESK:MANAGED:1:(text|message|part):(\d{1,10}):([a-f0-9]{16}):(\d{1,5}):([a-f0-9]{16}) -->$/;

// Format integrity, not authentication. Bind the suffix to its exact prefix and
// prompt, so copied examples, partial markers and unknown legacy blocks stay data.
function fingerprint(text) {
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export function readManagedText(text) {
  if (typeof text !== 'string') return null;
  const footer = text.match(FOOTER);
  if (!footer) return null;
  const [, kind, prefixSize, prefixHash, promptSize, promptHash] = footer;
  const prefixLength = Number(prefixSize), promptLength = Number(promptSize);
  if (promptLength < 1 || promptLength > 32768 || prefixLength > text.length ||
      (kind !== 'text' && prefixLength !== 0)) return null;
  const at = prefixLength + (prefixLength ? 2 : 0);
  const promptAt = at + START.length + 1;
  const promptEnd = promptAt + promptLength;
  if (promptEnd + END.length + 1 !== footer.index ||
      text.slice(prefixLength, at) !== (prefixLength ? '\n\n' : '') ||
      text.slice(at, promptAt) !== START + '\n' || text.slice(promptEnd, footer.index) !== '\n' + END) return null;
  const original = text.slice(0, prefixLength), prompt = text.slice(promptAt, promptEnd);
  if (fingerprint(original) !== prefixHash || fingerprint(prompt) !== promptHash) return null;
  return {original, prompt, kind};
}

export function appendManagedText(original, prompt, kind = 'text') {
  return original + (original ? '\n\n' : '') + START + '\n' + prompt + '\n' + END +
    `\n<!-- KUPADESK:MANAGED:1:${kind}:${original.length}:${fingerprint(original)}:${prompt.length}:${fingerprint(prompt)} -->`;
}

export function cleanManagedText(text) {
  if (typeof text !== 'string') throw new Error('invalid instruction');
  return readManagedText(text)?.original ?? text;
}
