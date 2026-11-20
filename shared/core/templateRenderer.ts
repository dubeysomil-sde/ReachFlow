export interface TemplateValues {
  Name?: string | null;
  Company?: string | null;
  Role?: string | null;
  JobId?: string | null;
}

export interface RenderedTemplate {
  text: string;
  unresolved: string[];
  warnings: string[];
}

const SUPPORTED_PLACEHOLDER = /\[(Name|Company|Role|JobId)\]/g;

export function renderTemplate(
  text: string,
  values: TemplateValues,
  mode: 'message' | 'subject' = 'message',
): RenderedTemplate {
  const unresolved = new Set<string>();
  const warnings: string[] = [];
  const lines = mode === 'subject' ? [text] : text.replace(/\r\n?/g, '\n').split('\n');
  const rendered = lines.flatMap((line) => {
    const missingOptional = [...line.matchAll(/\[(Role|JobId)\]/g)].some(
      (match) => !values[match[1] as keyof TemplateValues]?.trim(),
    );
    if (mode === 'message' && missingOptional && !/\[(Name|Company)\]/.test(line)) return [];
    let filled = line.replace(SUPPORTED_PLACEHOLDER, (placeholder, key: keyof TemplateValues) => {
      const value = values[key]?.trim();
      if (value) return value;
      if (key === 'Role' || key === 'JobId') return '';
      unresolved.add(placeholder);
      return placeholder;
    });
    if (missingOptional) {
      filled = filled
        .replace(/\([ \t]*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        .trim();
      warnings.push(filled);
    }
    return [filled];
  });
  return {
    text: rendered
      .join('\n')
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .trim(),
    unresolved: [...unresolved],
    warnings,
  };
}

export function assertSendable(subject: string, body: string, requiredValues: readonly string[] = []): void {
  if (!subject.trim()) throw new Error('Add a subject. You can set a default one in Sender details.');
  if (/[\r\n]/.test(subject)) throw new Error('Keep the subject on one line.');
  if (!body.trim()) throw new Error('Message is required');

  const unresolved = [...new Set(`${subject}\n${body}`.match(SUPPORTED_PLACEHOLDER) ?? [])];
  if (unresolved.length > 0) {
    throw new Error(
      `These blanks are still empty: ${unresolved.map((value) => value.slice(1, -1)).join(', ')}`,
    );
  }
  if (requiredValues.some((value) => !value.trim())) {
    throw new Error('Fill in the required blanks.');
  }
}
