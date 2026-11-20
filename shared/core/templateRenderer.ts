export interface TemplateValues {
  Name?: string | null;
  Company?: string | null;
  Role?: string | null;
  JobId?: string | null;
}

export interface RenderedTemplate {
  text: string;
  unresolved: string[];
}

const SUPPORTED_PLACEHOLDER = /\[(Name|Company|Role|JobId)\]/g;

export function renderTemplate(
  text: string,
  values: TemplateValues,
): RenderedTemplate {
  const unresolved = new Set<string>();
  const rendered = text.replace(SUPPORTED_PLACEHOLDER, (placeholder, key: keyof TemplateValues) => {
    const value = values[key];
    if (value === undefined || value === null || value.length === 0) {
      unresolved.add(placeholder);
      return placeholder;
    }
    return value;
  });

  return { text: rendered, unresolved: [...unresolved] };
}

export function assertSendable(
  subject: string,
  body: string,
  requiredValues: readonly string[] = [],
): void {
  if (!subject.trim()) throw new Error('Subject is required');
  if (!body.trim()) throw new Error('Body is required');

  const unresolved = [
    ...new Set(
      `${subject}\n${body}`.match(SUPPORTED_PLACEHOLDER) ?? [],
    ),
  ];
  if (unresolved.length > 0) {
    throw new Error(`Unresolved placeholders: ${unresolved.join(', ')}`);
  }

  if (requiredValues.some((value) => !value.trim())) {
    throw new Error('Required template values must not be empty');
  }
}
