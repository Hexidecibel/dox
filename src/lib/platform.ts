/** Keyboard labels for the current platform: ⌘ on a Mac, Ctrl elsewhere. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
}

export function modKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl ';
}

/** True when a key event happened inside something the person is typing into. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit'].includes(type);
  }
  return false;
}
